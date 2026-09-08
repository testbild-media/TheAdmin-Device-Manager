const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const AdmZip = require('adm-zip');
const {
  normalizeLibraryMetadata, validateLibraryMetadata, writeLibraryMetadata, readLibraryMetadata,
  createArchive, extractAdlib, fetchDefaultLibrary, normalizeArchivePath
} = require('../src/library-package.cjs');

async function makeDevice(assetsRoot, vendor = 'vendor', model = 'model') {
  const folder = path.join(assetsRoot, vendor, model);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'device.json'), JSON.stringify({
    formatVersion: 1, vendor: 'Vendor', model: 'Model', type: 'switch', viewBox: [0, 0, 10, 10],
    ports: [{ label: '1', kind: 'ethernet', element: 'port-1' }]
  }));
  await fs.writeFile(path.join(folder, 'front.svg'), '<svg viewBox="0 0 10 10"><rect id="port-1" x="0" y="0" width="2" height="2"/></svg>');
}

test('library metadata migrates legacy field names to the canonical schema', () => {
  assert.deepEqual(normalizeLibraryMetadata({ name: 'Default', version: '1.2.3', updated: '2026-09-08T00:00:00.000Z', autor: 'TheAdmin', devices: 4 }, 7), {
    name: 'Default', version: '1.2.3', updated: '2026-09-08T00:00:00.000Z', author: 'TheAdmin', deviceCount: 7
  });
  assert.deepEqual(validateLibraryMetadata({ name: '', author: '', version: 'v1' }), [
    'Library name is required.', 'Library author is required.', 'Library version must use semantic versioning, for example 1.0.0.'
  ]);
});

test('ADLIB round trip contains metadata inside device-assets and no unrelated files', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'theadmin-adlib-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'library');
  const assetsRoot = path.join(libraryRoot, 'device-assets');
  await makeDevice(assetsRoot);
  await fs.writeFile(path.join(libraryRoot, 'README.md'), 'must not be exported');
  await writeLibraryMetadata(libraryRoot, { name: 'Test', version: '1.0.0', author: 'Tester' });
  const archive = path.join(root, 'test.adlib');
  await createArchive(libraryRoot, archive);

  const names = new AdmZip(archive).getEntries().map((entry) => entry.entryName);
  assert.ok(names.includes('device-assets/library.json'));
  assert.ok(!names.includes('library.json'));
  assert.ok(names.includes('device-assets/vendor/model/device.json'));
  assert.ok(names.includes('device-assets/vendor/model/front.svg'));
  assert.equal(names.some((name) => /README|\.git/i.test(name)), false);

  const extracted = path.join(root, 'extracted');
  const opened = await extractAdlib(archive, extracted);
  assert.equal(opened.metadata.deviceCount, 1);
  assert.equal(opened.invalid.length, 0);
  assert.equal((await readLibraryMetadata(extracted)).author, 'Tester');
});

test('default fetch imports only validated device assets from a repository archive', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'theadmin-fetch-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source', 'repository-main', 'device-assets');
  await makeDevice(source);
  await fs.writeFile(path.join(source, 'library.json'), JSON.stringify({ name: 'legacy', autor: 'old' }));
  const zip = new AdmZip(); zip.addLocalFolder(path.join(root, 'source'));
  const bytes = zip.toBuffer();
  const destination = path.join(root, 'destination');
  const mockFetch = async () => ({ ok: true, arrayBuffer: async () => bytes, status: 200, statusText: 'OK' });

  const result = await fetchDefaultLibrary(destination, mockFetch);

  assert.equal(result.deviceCount, 1);
  await fs.access(path.join(destination, 'vendor', 'model', 'device.json'));
  await assert.rejects(fs.access(path.join(destination, 'library.json')));
});

test('ADLIB paths reject traversal and absolute entries', () => {
  assert.throws(() => normalizeArchivePath('../outside.txt'), /Unsafe archive path/);
  assert.throws(() => normalizeArchivePath('/absolute.txt'), /Unsafe archive path/);
  assert.throws(() => normalizeArchivePath('C:\\absolute.txt'), /Unsafe archive path/);
  assert.equal(normalizeArchivePath('device-assets/vendor/model/device.json'), 'device-assets/vendor/model/device.json');
});

test('legacy root metadata is migrated into device-assets', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'theadmin-library-migration-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'device-assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'library.json'), JSON.stringify({ name: 'Legacy', version: '1.0.0', author: 'Tester' }));

  const metadata = await readLibraryMetadata(root);

  assert.equal(metadata.name, 'Legacy');
  await fs.access(path.join(root, 'device-assets', 'library.json'));
  await assert.rejects(fs.access(path.join(root, 'library.json')));
});
