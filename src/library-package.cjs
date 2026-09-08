const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const { scanLibrary, fileSystemPath } = require('./library.cjs');

const DEFAULT_LIBRARY_REPOSITORY = 'testbild-media/TheAdmin-Device-Library';
const DEFAULT_LIBRARY_ARCHIVE = `https://codeload.github.com/${DEFAULT_LIBRARY_REPOSITORY}/zip/refs/heads/main`;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100000;

function normalizeLibraryMetadata(value = {}, deviceCount = 0) {
  return {
    name: String(value.name || '').trim(),
    version: String(value.version || '').trim(),
    updated: typeof value.updated === 'string' && value.updated ? value.updated : new Date().toISOString(),
    author: String(value.author || value.autor || '').trim(),
    deviceCount: Number.isInteger(deviceCount) ? deviceCount : Number(value.deviceCount ?? value.devices ?? 0) || 0
  };
}

function validateLibraryMetadata(metadata) {
  const errors = [];
  if (!String(metadata?.name || '').trim()) errors.push('Library name is required.');
  if (!String(metadata?.author || '').trim()) errors.push('Library author is required.');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(metadata?.version || '').trim())) errors.push('Library version must use semantic versioning, for example 1.0.0.');
  return errors;
}

async function readLibraryMetadata(libraryRoot) {
  await ensureMetadataLocation(libraryRoot);
  const metadataPath = path.join(libraryRoot, 'device-assets', 'library.json');
  const parsed = JSON.parse((await fs.readFile(fileSystemPath(metadataPath), 'utf8')).replace(/^\uFEFF/, ''));
  return normalizeLibraryMetadata(parsed, await countDevices(path.join(libraryRoot, 'device-assets')));
}

async function writeLibraryMetadata(libraryRoot, metadata, { touch = true } = {}) {
  const assetsRoot = path.join(libraryRoot, 'device-assets');
  const normalized = normalizeLibraryMetadata(metadata, await countDevices(assetsRoot));
  normalized.updated = touch || !normalized.updated ? new Date().toISOString() : normalized.updated;
  const errors = validateLibraryMetadata(normalized);
  if (errors.length) throw new Error(errors.join('\n'));
  await fs.mkdir(fileSystemPath(assetsRoot), { recursive: true });
  await atomicWrite(path.join(assetsRoot, 'library.json'), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

async function countDevices(assetsRoot) {
  let count = 0;
  for (const vendor of await directories(assetsRoot)) {
    for (const model of await directories(path.join(assetsRoot, vendor))) {
      try { await fs.access(fileSystemPath(path.join(assetsRoot, vendor, model, 'device.json'))); count += 1; }
      catch { /* An incomplete folder is not a device. */ }
    }
  }
  return count;
}

async function validateLibraryAssets(assetsRoot) {
  const devices = await scanLibrary(assetsRoot);
  const invalid = devices.filter((device) => device.validation.status === 'error');
  return { devices, invalid };
}

async function fetchDefaultLibrary(destinationRoot, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('This runtime cannot download the default library.');
  const response = await fetchImpl(DEFAULT_LIBRARY_ARCHIVE, { headers: { 'User-Agent': 'TheAdmin-Device-Manager' } });
  if (!response.ok) throw new Error(`Default library download failed (${response.status} ${response.statusText}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('The default library archive is too large.');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'theadmin-default-library-'));
  try {
    await extractArchiveBuffer(bytes, temporary);
    const sourceAssets = await findDirectoryNamed(temporary, 'device-assets');
    if (!sourceAssets) throw new Error('The default repository does not contain a device-assets folder.');
    const validation = await validateLibraryAssets(sourceAssets);
    if (validation.invalid.length) throw new Error(formatInvalidDevices('The fetched default library is invalid', validation.invalid));
    await fs.mkdir(fileSystemPath(destinationRoot), { recursive: true });
    await copyAssetContents(sourceAssets, destinationRoot);
    return { source: DEFAULT_LIBRARY_ARCHIVE, deviceCount: validation.devices.length };
  } finally { await fs.rm(fileSystemPath(temporary), { recursive: true, force: true }); }
}

async function createArchive(libraryRoot, targetFile) {
  const metadata = await readLibraryMetadata(libraryRoot);
  const metadataErrors = validateLibraryMetadata(metadata);
  if (metadataErrors.length) throw new Error(metadataErrors.join('\n'));
  const zip = new AdmZip();
  await addDirectoryToZip(zip, path.join(libraryRoot, 'device-assets'), 'device-assets');
  zip.updateFile('device-assets/library.json', Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`));
  await writeArchiveAtomically(zip, targetFile);
  return targetFile;
}

async function extractAdlib(archiveFile, destinationRoot) {
  const bytes = await fs.readFile(fileSystemPath(archiveFile));
  await extractArchiveBuffer(bytes, destinationRoot);
  const assetsRoot = path.join(destinationRoot, 'device-assets');
  const stat = await fs.stat(fileSystemPath(assetsRoot));
  if (!stat.isDirectory()) throw new Error('The archive has no device-assets folder.');
  const metadata = await readLibraryMetadata(destinationRoot);
  const metadataErrors = validateLibraryMetadata(metadata);
  if (metadataErrors.length) throw new Error(metadataErrors.join('\n'));
  const validation = await validateLibraryAssets(assetsRoot);
  return { libraryRoot: destinationRoot, assetsRoot, metadata, ...validation };
}

async function extractArchiveBuffer(bytes, destinationRoot) {
  const zip = new AdmZip(bytes);
  const entries = zip.getEntries();
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('The archive contains too many files.');
  let totalSize = 0;
  for (const entry of entries) {
    const name = normalizeArchivePath(entry.entryName);
    totalSize += Number(entry.header?.size || 0);
    if (totalSize > MAX_ARCHIVE_BYTES) throw new Error('The unpacked archive is too large.');
    const target = path.resolve(destinationRoot, ...name.split('/'));
    if (!isInside(destinationRoot, target)) throw new Error(`Unsafe archive path: ${entry.entryName}`);
    if (entry.isDirectory) { await fs.mkdir(fileSystemPath(target), { recursive: true }); continue; }
    await fs.mkdir(fileSystemPath(path.dirname(target)), { recursive: true });
    await fs.writeFile(fileSystemPath(target), entry.getData());
    if (entry.header?.time instanceof Date) await fs.utimes(fileSystemPath(target), entry.header.time, entry.header.time).catch(() => {});
  }
}

function normalizeArchivePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) throw new Error(`Unsafe archive path: ${value}`);
  return normalized;
}

async function collectDeviceFolders(assetsRoot) {
  const devices = new Map();
  for (const vendor of await directories(assetsRoot)) {
    for (const model of await directories(path.join(assetsRoot, vendor))) {
      const folder = path.join(assetsRoot, vendor, model);
      const modified = await latestModifiedTime(folder);
      devices.set(`${vendor}/${model}`, { id: `${vendor}/${model}`, folder, modified });
    }
  }
  return devices;
}

async function latestModifiedTime(folder) {
  let latest = 0;
  for (const entry of await fs.readdir(fileSystemPath(folder), { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const stat = await fs.stat(fileSystemPath(path.join(folder, entry.name)));
    latest = Math.max(latest, stat.mtimeMs);
  }
  return latest;
}

async function copyAssetContents(sourceAssets, destinationAssets) {
  for (const entry of await fs.readdir(fileSystemPath(sourceAssets), { withFileTypes: true })) {
    if (entry.name === 'library.json') continue;
    await fs.cp(fileSystemPath(path.join(sourceAssets, entry.name)), fileSystemPath(path.join(destinationAssets, entry.name)), { recursive: true, force: true });
  }
}

async function addDirectoryToZip(zip, source, archiveRoot) {
  for (const entry of await fs.readdir(fileSystemPath(source), { withFileTypes: true })) {
    const local = path.join(source, entry.name);
    const archivePath = `${archiveRoot}/${entry.name}`;
    if (entry.isDirectory()) await addDirectoryToZip(zip, local, archivePath);
    else if (entry.isFile()) {
      const stat = await fs.stat(fileSystemPath(local));
      zip.addFile(archivePath, await fs.readFile(fileSystemPath(local)), '', stat);
    }
  }
}

async function writeArchiveAtomically(zip, targetFile) {
  const resolved = path.resolve(targetFile);
  await fs.mkdir(fileSystemPath(path.dirname(resolved)), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  const backup = `${resolved}.bak-${crypto.randomUUID()}`;
  await zip.writeZipPromise(fileSystemPath(temporary), { overwrite: true });
  let hadOriginal = false;
  try {
    try { await fs.rename(fileSystemPath(resolved), fileSystemPath(backup)); hadOriginal = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(fileSystemPath(temporary), fileSystemPath(resolved));
    if (hadOriginal) await fs.rm(fileSystemPath(backup), { force: true });
  } catch (error) {
    if (hadOriginal) await fs.rename(fileSystemPath(backup), fileSystemPath(resolved)).catch(() => {});
    await fs.rm(fileSystemPath(temporary), { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicWrite(file, content) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(fileSystemPath(temporary), content, 'utf8');
  await fs.rename(fileSystemPath(temporary), fileSystemPath(file));
}

async function ensureMetadataLocation(libraryRoot) {
  const assetsRoot = path.join(libraryRoot, 'device-assets');
  const canonical = path.join(assetsRoot, 'library.json');
  const legacy = path.join(libraryRoot, 'library.json');
  try {
    const stat = await fs.stat(fileSystemPath(canonical));
    if (!stat.isFile()) throw new Error('device-assets/library.json is not a file.');
    await fs.rm(fileSystemPath(legacy), { force: true });
    return canonical;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(fileSystemPath(assetsRoot), { recursive: true });
  try {
    await fs.rename(fileSystemPath(legacy), fileSystemPath(canonical));
    return canonical;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('The library has no device-assets/library.json file.');
    throw error;
  }
}

async function directories(folder) {
  try { return (await fs.readdir(fileSystemPath(folder), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function findDirectoryNamed(root, name, depth = 3) {
  if (depth < 0) return null;
  for (const entry of await fs.readdir(fileSystemPath(root), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name);
    if (entry.name === name) return candidate;
    const nested = await findDirectoryNamed(candidate, name, depth - 1);
    if (nested) return nested;
  }
  return null;
}

function formatInvalidDevices(prefix, devices) {
  const details = devices.slice(0, 10).map((device) => `${device.id}: ${device.validation.errors.join('; ')}`).join('\n');
  return `${prefix} (${devices.length} device${devices.length === 1 ? '' : 's'}).\n${details}${devices.length > 10 ? '\n…' : ''}`;
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

module.exports = {
  DEFAULT_LIBRARY_REPOSITORY, DEFAULT_LIBRARY_ARCHIVE, normalizeLibraryMetadata, validateLibraryMetadata,
  readLibraryMetadata, writeLibraryMetadata, countDevices, validateLibraryAssets, fetchDefaultLibrary,
  createArchive, extractAdlib, collectDeviceFolders, copyAssetContents, formatInvalidDevices, normalizeArchivePath
};
