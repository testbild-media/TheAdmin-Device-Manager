const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { scanLibrary, slugify, slugError, parseViewBox, cleanSvg, formatSvg, validateManifest, normalizeDeviceType, formatManifest, isInside } = require('./library.cjs');

let mainWindow;
let editorDirty = false;
let allowClose = false;
let closePromptOpen = false;

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
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
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

function registerIpc() {
  ipcMain.handle('library:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Open device-assets folder', properties: ['openDirectory'] });
    if (result.canceled) return null;
    const library = await openLibrary(result.filePaths[0]);
    await rememberLibrary(library.root);
    return library;
  });
  ipcMain.handle('library:open', (_event, root) => openLibrary(root));
  ipcMain.handle('library:last', async () => {
    const root = await readLastLibrary();
    if (!root) return null;
    try { return { ok: true, data: await openLibrary(root) }; }
    catch (error) { return { ok: false, error: `The last opened folder is no longer available.\n${error.message}` }; }
  });
  ipcMain.handle('device:load', async (_event, { root, id }) => {
    const folder = path.resolve(root, ...String(id).split('/'));
    if (!isInside(root, folder)) throw new Error('Invalid device path.');
    const [manifestText, svg] = await Promise.all([
      fs.readFile(path.join(folder, 'device.json'), 'utf8'),
      fs.readFile(path.join(folder, 'front.svg'), 'utf8')
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
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'The SVG could not be imported.' }; }
  });
  ipcMain.handle('device:save', async (_event, payload) => {
    try { return { ok: true, data: await saveDevice(payload) }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Unknown error while saving.' }; }
  });
  ipcMain.on('editor:dirty', (_event, dirty) => { editorDirty = Boolean(dirty); });
  ipcMain.on('app:close-after-save', (_event, success) => {
    closePromptOpen = false;
    if (success && mainWindow && !mainWindow.isDestroyed()) { editorDirty = false; allowClose = true; mainWindow.close(); }
  });
}

async function handleWindowClose(event) {
  if (allowClose || !editorDirty) return;
  event.preventDefault();
  if (closePromptOpen) return;
  closePromptOpen = true;
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning', title: 'Unsaved changes', message: 'Save changes before closing?',
    detail: 'Your manifest and SVG changes have not been written to disk.',
    buttons: ['Save and close', 'Discard and close', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true
  });
  if (result.response === 0) { mainWindow.webContents.send('app:save-before-close'); return; }
  closePromptOpen = false;
  if (result.response === 1) { allowClose = true; mainWindow.close(); }
}

async function readLastLibrary() {
  try {
    const settings = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    return typeof settings.lastLibrary === 'string' ? settings.lastLibrary : null;
  } catch { return null; }
}

async function rememberLibrary(root) {
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await atomicWrite(settingsPath, `${JSON.stringify({ lastLibrary: root }, null, 2)}\n`);
  } catch (error) { console.warn('The last library path could not be saved:', error.message); }
}

async function openLibrary(root) {
  const resolved = path.resolve(root);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error('The selected path is not a folder.');
  return { root: resolved, devices: await scanLibrary(resolved) };
}

async function saveDevice({ root, originalId, manifest, svg }) {
  if (!root) throw new Error('Open a device-assets folder first.');
  manifest = { ...manifest, type: normalizeDeviceType(manifest.type) };
  const resolvedRoot = path.resolve(root);
  const errors = validateManifest(manifest, svg);
  const vendorSlugError = slugError('Vendor', manifest.vendor);
  const modelSlugError = slugError('Model', manifest.model);
  if (vendorSlugError) errors.push(vendorSlugError);
  if (modelSlugError) errors.push(modelSlugError);
  if (errors.length) throw new Error(errors.join('\n'));

  const vendorDir = slugify(manifest.vendor);
  const modelDir = slugify(manifest.model);
  const target = path.join(resolvedRoot, vendorDir, modelDir);
  if (!isInside(resolvedRoot, target)) throw new Error('Invalid destination path.');
  const original = originalId ? path.resolve(resolvedRoot, ...String(originalId).split('/')) : null;
  if (original && !isInside(resolvedRoot, original)) throw new Error('Invalid source path.');

  if ((!original || path.normalize(original) !== path.normalize(target)) && await exists(target)) {
    throw new Error(`The destination ${vendorDir}/${modelDir} already exists.`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (original && path.normalize(original) !== path.normalize(target)) await fs.rename(original, target);
  else await fs.mkdir(target, { recursive: true });

  const cleanManifest = {
    formatVersion: 1,
    vendor: String(manifest.vendor).trim(),
    model: String(manifest.model).trim(),
    type: normalizeDeviceType(manifest.type),
    viewBox: parseViewBox(svg),
    ports: manifest.ports.map((port) => ({ label: String(port.label).trim(), kind: port.kind, element: String(port.element).trim() }))
  };
  await Promise.all([
    atomicWrite(path.join(target, 'device.json'), formatManifest(cleanManifest)),
    atomicWrite(path.join(target, 'front.svg'), formatSvg(svg))
  ]);
  return { id: `${vendorDir}/${modelDir}`, manifest: cleanManifest, devices: await scanLibrary(resolvedRoot) };
}

async function atomicWrite(file, content) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, content, 'utf8');
  await fs.rename(temporary, file);
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}
