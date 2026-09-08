const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {
  scanLibrary, pruneAssetlessFolders, fileSystemPath, slugify, slugError, parseViewBox,
  cleanSvg, formatSvg, validateManifest, normalizeDeviceType, formatManifest, isInside
} = require('./library.cjs');
const {
  normalizeLibraryMetadata, validateLibraryMetadata, readLibraryMetadata, writeLibraryMetadata,
  validateLibraryAssets, fetchDefaultLibrary, createArchive, extractAdlib, collectDeviceFolders,
  formatInvalidDevices
} = require('./library-package.cjs');

let mainWindow;
let editorDirty = false;
let allowClose = false;
let closePromptOpen = false;
let activeLibrary = null;
const mergeSessions = new Map();

function createWindow() {
  editorDirty = false;
  allowClose = false;
  closePromptOpen = false;
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0c111b',
    title: 'TheAdmin Device Manager',
    icon: path.join(__dirname, '..', 'branding', process.platform === 'win32' ? 'icon.ico' : 'icon_256x256.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('close', handleWindowClose);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
app.on('before-quit', () => {
  for (const session of mergeSessions.values()) fs.rm(fileSystemPath(session.temporary), { recursive: true, force: true }).catch(() => {});
});

function registerIpc() {
  handle('library:startup', openUserLibraryAtStartup);
  handle('library:create', (_event, metadata) => createUserLibrary(metadata));
  handle('library:open-user', openUserLibrary);
  handle('library:open-external', openExternalLibrary);
  handle('library:edit', (_event, metadata) => editLibrary(metadata));
  handle('library:export', exportLibrary);
  handle('library:show', showLibrary);
  handle('library:merge-prepare', prepareMerge);
  handle('library:merge-commit', (_event, payload) => commitMerge(payload));
  handle('library:merge-cancel', (_event, token) => cancelMerge(token));
  handle('device:delete', (_event, id) => deleteDevice(id));

  ipcMain.handle('device:load', async (_event, { root, id }) => {
    assertActiveRoot(root);
    const folder = resolveDeviceFolder(id);
    const [manifestText, svg] = await Promise.all([
      fs.readFile(fileSystemPath(path.join(folder, 'device.json')), 'utf8'),
      fs.readFile(fileSystemPath(path.join(folder, 'front.svg')), 'utf8')
    ]);
    return { manifest: JSON.parse(manifestText.replace(/^\uFEFF/, '')), svg, id };
  });
  ipcMain.handle('svg:choose', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, { title: 'Select SVG', properties: ['openFile'], filters: [{ name: 'SVG', extensions: ['svg'] }] });
      if (result.canceled) return { ok: true, data: null };
      const sourceSvg = await fs.readFile(result.filePaths[0], 'utf8');
      const cleaned = cleanSvg(sourceSvg);
      return { ok: true, data: { svg: cleaned.svg, viewBox: parseViewBox(cleaned.svg), sourceName: path.basename(result.filePaths[0]), cleanup: cleaned.report } };
    } catch (error) { return failure(error, 'The SVG could not be imported.'); }
  });
  ipcMain.handle('device:save', async (_event, payload) => {
    try { return { ok: true, data: await saveDevice(payload) }; }
    catch (error) { return failure(error, 'Unknown error while saving.'); }
  });
  ipcMain.on('editor:dirty', (_event, dirty) => { editorDirty = Boolean(dirty); });
  ipcMain.on('app:close-after-save', (_event, success) => {
    closePromptOpen = false;
    if (success && mainWindow && !mainWindow.isDestroyed()) { editorDirty = false; allowClose = true; mainWindow.close(); }
  });
}

function handle(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    try { return { ok: true, data: await action(event, ...args) }; }
    catch (error) { return failure(error); }
  });
}

async function openUserLibraryAtStartup() {
  const libraryRoot = userLibraryRoot();
  if (!await isLibraryRoot(libraryRoot)) return { needsSetup: true, workspaceRoot: path.dirname(libraryRoot) };
  return openLibraryContext({ kind: 'user', libraryRoot });
}

async function createUserLibrary(_eventOrMetadata, maybeMetadata) {
  const metadata = maybeMetadata || _eventOrMetadata;
  const errors = validateLibraryMetadata(metadata);
  if (errors.length) throw new Error(errors.join('\n'));
  const target = userLibraryRoot();
  if (await pathExists(target)) {
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: 'Replace user library?', message: 'The existing user library will be replaced.',
      detail: 'This permanently removes its devices. Export a copy first if you need it.',
      buttons: ['Replace library', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true
    });
    if (confirmation.response !== 0) return null;
  }
  const parent = path.dirname(target);
  await fs.mkdir(fileSystemPath(parent), { recursive: true });
  const staging = path.join(parent, `.creating-${crypto.randomUUID()}`);
  const backup = path.join(parent, `.backup-${crypto.randomUUID()}`);
  try {
    const assetsRoot = path.join(staging, 'device-assets');
    await fs.mkdir(fileSystemPath(assetsRoot), { recursive: true });
    await fetchDefaultLibrary(assetsRoot);
    await writeLibraryMetadata(staging, normalizeLibraryMetadata(metadata, 0));
    let hadTarget = false;
    if (await pathExists(target)) { await fs.rename(fileSystemPath(target), fileSystemPath(backup)); hadTarget = true; }
    try { await fs.rename(fileSystemPath(staging), fileSystemPath(target)); }
    catch (error) { if (hadTarget) await fs.rename(fileSystemPath(backup), fileSystemPath(target)).catch(() => {}); throw error; }
    if (hadTarget) await fs.rm(fileSystemPath(backup), { recursive: true, force: true });
    return openLibraryContext({ kind: 'user', libraryRoot: target });
  } finally {
    await fs.rm(fileSystemPath(staging), { recursive: true, force: true }).catch(() => {});
    await fs.rm(fileSystemPath(backup), { recursive: true, force: true }).catch(() => {});
  }
}

async function openUserLibrary() {
  const libraryRoot = userLibraryRoot();
  if (!await isLibraryRoot(libraryRoot)) return { needsSetup: true, workspaceRoot: path.dirname(libraryRoot) };
  return openLibraryContext({ kind: 'user', libraryRoot });
}

async function openExternalLibrary() {
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'question', title: 'Open external library', message: 'Which library do you want to open?',
    buttons: ['ADLIB archive', 'Library folder', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true
  });
  if (choice.response === 2) return null;
  if (choice.response === 0) {
    const selected = await dialog.showOpenDialog(mainWindow, { title: 'Open ADLIB library', properties: ['openFile'], filters: [{ name: 'TheAdmin Device Library', extensions: ['adlib'] }] });
    if (selected.canceled) return null;
    const temporary = path.join(app.getPath('userData'), 'external-workspace');
    await fs.rm(fileSystemPath(temporary), { recursive: true, force: true });
    await fs.mkdir(fileSystemPath(temporary), { recursive: true });
    const extracted = await extractAdlib(selected.filePaths[0], temporary);
    if (extracted.invalid.length) throw new Error(formatInvalidDevices('The external library is invalid', extracted.invalid));
    return openLibraryContext({ kind: 'archive', libraryRoot: temporary, archivePath: selected.filePaths[0] });
  }
  const selected = await dialog.showOpenDialog(mainWindow, { title: 'Open external library folder', properties: ['openDirectory'] });
  if (selected.canceled) return null;
  let libraryRoot = path.resolve(selected.filePaths[0]);
  if (path.basename(libraryRoot) === 'device-assets') libraryRoot = path.dirname(libraryRoot);
  if (!await isLibraryRoot(libraryRoot)) throw new Error('Select a library folder whose device-assets folder contains library.json.');
  return openLibraryContext({ kind: 'external', libraryRoot });
}

async function openLibraryContext(context) {
  const assetsRoot = path.join(context.libraryRoot, 'device-assets');
  const removedFolders = await pruneAssetlessFolders(assetsRoot);
  const metadata = await readLibraryMetadata(context.libraryRoot);
  const devices = await scanLibrary(assetsRoot);
  activeLibrary = { ...context, assetsRoot };
  return libraryPayload(metadata, devices, removedFolders);
}

async function editLibrary(metadata) {
  requireActiveLibrary();
  const errors = validateLibraryMetadata(metadata);
  if (errors.length) throw new Error(errors.join('\n'));
  const updated = await writeLibraryMetadata(activeLibrary.libraryRoot, metadata);
  await persistArchiveIfNeeded();
  return libraryPayload(updated, await scanLibrary(activeLibrary.assetsRoot), []);
}

async function exportLibrary() {
  requireActiveLibrary();
  const metadata = await readLibraryMetadata(activeLibrary.libraryRoot);
  const suggested = `${slugify(metadata.name) || 'device-library'}-${metadata.version}.adlib`;
  const selected = await dialog.showSaveDialog(mainWindow, { title: 'Export library', defaultPath: path.join(app.getPath('downloads'), suggested), filters: [{ name: 'TheAdmin Device Library', extensions: ['adlib'] }] });
  if (selected.canceled || !selected.filePath) return null;
  const target = selected.filePath.toLowerCase().endsWith('.adlib') ? selected.filePath : `${selected.filePath}.adlib`;
  await createArchive(activeLibrary.libraryRoot, target);
  return { path: target };
}

async function showLibrary() {
  requireActiveLibrary();
  if (activeLibrary.kind === 'archive') {
    shell.showItemInFolder(activeLibrary.archivePath);
    return { path: activeLibrary.archivePath };
  }
  const error = await shell.openPath(activeLibrary.libraryRoot);
  if (error) throw new Error(error);
  return { path: activeLibrary.libraryRoot };
}

async function prepareMerge() {
  requireActiveLibrary();
  const currentValidation = await validateLibraryAssets(activeLibrary.assetsRoot);
  if (currentValidation.invalid.length) throw new Error(formatInvalidDevices('Fix the current library before merging', currentValidation.invalid));
  const selected = await dialog.showOpenDialog(mainWindow, { title: 'Merge ADLIB library', properties: ['openFile'], filters: [{ name: 'TheAdmin Device Library', extensions: ['adlib'] }] });
  if (selected.canceled) return null;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'theadmin-merge-'));
  try {
    const incoming = await extractAdlib(selected.filePaths[0], temporary);
    if (incoming.invalid.length) throw new Error(formatInvalidDevices('The library to merge is invalid', incoming.invalid));
    const currentFolders = await collectDeviceFolders(activeLibrary.assetsRoot);
    const incomingFolders = await collectDeviceFolders(incoming.assetsRoot);
    const incomingLabels = new Map(incoming.devices.map((device) => [device.id, `${device.vendor} ${device.model}`]));
    const conflicts = [];
    for (const [id, candidate] of incomingFolders) {
      const current = currentFolders.get(id);
      if (!current) continue;
      const suggested = candidate.modified > current.modified ? 'incoming' : 'current';
      conflicts.push({ id, label: incomingLabels.get(id) || id, currentModified: new Date(current.modified).toISOString(), incomingModified: new Date(candidate.modified).toISOString(), suggested });
    }
    const token = crypto.randomUUID();
    mergeSessions.set(token, { temporary, incomingAssets: incoming.assetsRoot, incomingFolders, conflicts: new Set(conflicts.map((item) => item.id)) });
    return { token, source: selected.filePaths[0], incomingCount: incomingFolders.size, conflicts };
  } catch (error) { await fs.rm(fileSystemPath(temporary), { recursive: true, force: true }); throw error; }
}

async function commitMerge({ token, decisions = {} }) {
  requireActiveLibrary();
  const session = mergeSessions.get(token);
  if (!session) throw new Error('The merge session has expired.');
  try {
    let mergedCount = 0;
    for (const [id, incoming] of session.incomingFolders) {
      const decision = session.conflicts.has(id) ? decisions[id] : 'incoming';
      if (decision === 'current') continue;
      if (decision !== 'incoming') throw new Error(`Choose which version to keep for ${id}.`);
      const target = path.resolve(activeLibrary.assetsRoot, ...id.split('/'));
      if (!isInside(activeLibrary.assetsRoot, target)) throw new Error(`Invalid device path in merge: ${id}`);
      await fs.rm(fileSystemPath(target), { recursive: true, force: true });
      await fs.mkdir(fileSystemPath(path.dirname(target)), { recursive: true });
      await fs.cp(fileSystemPath(incoming.folder), fileSystemPath(target), { recursive: true, force: true });
      mergedCount += 1;
    }
    const metadata = await writeLibraryMetadata(activeLibrary.libraryRoot, await readLibraryMetadata(activeLibrary.libraryRoot));
    await persistArchiveIfNeeded();
    const devices = await scanLibrary(activeLibrary.assetsRoot);
    return { ...libraryPayload(metadata, devices, []), mergedCount };
  } finally { mergeSessions.delete(token); await fs.rm(fileSystemPath(session.temporary), { recursive: true, force: true }); }
}

async function cancelMerge(token) {
  const session = mergeSessions.get(token);
  if (!session) return null;
  mergeSessions.delete(token);
  await fs.rm(fileSystemPath(session.temporary), { recursive: true, force: true });
  return null;
}

async function deleteDevice(id) {
  requireActiveLibrary();
  const folder = resolveDeviceFolder(id);
  const device = (await scanLibrary(activeLibrary.assetsRoot)).find((item) => item.id === id);
  if (!device) throw new Error('The selected device no longer exists.');
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'warning', title: 'Delete device?', message: `Delete ${device.vendor} ${device.model}?`,
    detail: 'This permanently removes device.json and front.svg from the active library.',
    buttons: ['Delete device', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true
  });
  if (confirmation.response !== 0) return null;
  await fs.rm(fileSystemPath(folder), { recursive: true, force: false });
  const removedFolders = await pruneAssetlessFolders(activeLibrary.assetsRoot);
  const metadata = await writeLibraryMetadata(activeLibrary.libraryRoot, await readLibraryMetadata(activeLibrary.libraryRoot));
  await persistArchiveIfNeeded();
  return libraryPayload(metadata, await scanLibrary(activeLibrary.assetsRoot), removedFolders);
}

async function saveDevice({ root, originalId, manifest, svg }) {
  requireActiveLibrary();
  assertActiveRoot(root);
  manifest = { ...manifest, type: normalizeDeviceType(manifest.type) };
  const errors = validateManifest(manifest, svg);
  const vendorSlugError = slugError('Vendor', manifest.vendor);
  const modelSlugError = slugError('Model', manifest.model);
  if (vendorSlugError) errors.push(vendorSlugError);
  if (modelSlugError) errors.push(modelSlugError);
  if (errors.length) throw new Error(errors.join('\n'));

  const vendorDir = slugify(manifest.vendor);
  const modelDir = slugify(manifest.model);
  const target = path.join(activeLibrary.assetsRoot, vendorDir, modelDir);
  if (!isInside(activeLibrary.assetsRoot, target)) throw new Error('Invalid destination path.');
  const original = originalId ? resolveDeviceFolder(originalId) : null;
  if ((!original || path.normalize(original) !== path.normalize(target)) && await pathExists(target)) throw new Error(`The destination ${vendorDir}/${modelDir} already exists.`);
  await fs.mkdir(fileSystemPath(path.dirname(target)), { recursive: true });
  if (original && path.normalize(original) !== path.normalize(target)) await fs.rename(fileSystemPath(original), fileSystemPath(target));
  else await fs.mkdir(fileSystemPath(target), { recursive: true });

  const cleanManifest = {
    formatVersion: 1, vendor: String(manifest.vendor).trim(), model: String(manifest.model).trim(), type: normalizeDeviceType(manifest.type),
    viewBox: parseViewBox(svg), ports: manifest.ports.map((port) => ({ label: String(port.label).trim(), kind: port.kind, element: String(port.element).trim() }))
  };
  await Promise.all([
    atomicWrite(path.join(target, 'device.json'), formatManifest(cleanManifest)),
    atomicWrite(path.join(target, 'front.svg'), formatSvg(svg))
  ]);
  const removedFolders = await pruneAssetlessFolders(activeLibrary.assetsRoot);
  const metadata = await writeLibraryMetadata(activeLibrary.libraryRoot, await readLibraryMetadata(activeLibrary.libraryRoot));
  await persistArchiveIfNeeded();
  return { id: `${vendorDir}/${modelDir}`, manifest: cleanManifest, ...libraryPayload(metadata, await scanLibrary(activeLibrary.assetsRoot), removedFolders) };
}

async function persistArchiveIfNeeded() {
  if (activeLibrary?.kind === 'archive') await createArchive(activeLibrary.libraryRoot, activeLibrary.archivePath);
}

function libraryPayload(metadata, devices, removedFolders) {
  return {
    root: activeLibrary?.assetsRoot || '', libraryRoot: activeLibrary?.libraryRoot || '', libraryKind: activeLibrary?.kind || '',
    archivePath: activeLibrary?.archivePath || null, metadata, devices, removedFolders
  };
}

function userLibraryRoot() {
  return path.join(app.getPath('documents'), 'TheAdmin Device Manager', 'User Library');
}

async function isLibraryRoot(root) {
  try {
    const assetsRoot = path.join(root, 'device-assets');
    const assets = await fs.stat(fileSystemPath(assetsRoot));
    if (!assets.isDirectory()) return false;
    for (const candidate of [path.join(assetsRoot, 'library.json'), path.join(root, 'library.json')]) {
      try { if ((await fs.stat(fileSystemPath(candidate))).isFile()) return true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return false;
  } catch { return false; }
}

function requireActiveLibrary() {
  if (!activeLibrary) throw new Error('Open or create a library first.');
}

function assertActiveRoot(root) {
  requireActiveLibrary();
  if (path.resolve(String(root || '')) !== path.resolve(activeLibrary.assetsRoot)) throw new Error('The requested library is not active.');
}

function resolveDeviceFolder(id) {
  requireActiveLibrary();
  const folder = path.resolve(activeLibrary.assetsRoot, ...String(id).split('/'));
  if (!isInside(activeLibrary.assetsRoot, folder)) throw new Error('Invalid device path.');
  return folder;
}

async function handleWindowClose(event) {
  if (allowClose || !editorDirty) return;
  event.preventDefault();
  if (closePromptOpen) return;
  closePromptOpen = true;
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning', title: 'Unsaved changes', message: 'Save changes before closing?', detail: 'Your manifest and SVG changes have not been written to disk.',
    buttons: ['Save and close', 'Discard and close', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true
  });
  if (result.response === 0) { mainWindow.webContents.send('app:save-before-close'); return; }
  closePromptOpen = false;
  if (result.response === 1) { allowClose = true; mainWindow.close(); }
}

async function atomicWrite(file, content) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(fileSystemPath(temporary), content, 'utf8');
  await fs.rename(fileSystemPath(temporary), fileSystemPath(file));
}

async function pathExists(file) {
  try { await fs.access(fileSystemPath(file)); return true; } catch { return false; }
}

function failure(error, fallback = 'The operation failed.') {
  return { ok: false, error: error instanceof Error ? error.message : fallback };
}
