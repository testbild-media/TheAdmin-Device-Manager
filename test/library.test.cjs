const test = require('node:test');
const assert = require('node:assert/strict');
const { slugify, parseViewBox, validateSvg, cleanSvg, formatSvg, validateManifest, validateDeviceFolder, normalizeDeviceType, formatManifest, scanLibrary, isInside } = require('../src/library.cjs');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

test('slugify follows the device folder convention', () => {
  assert.equal(slugify('U6+'), 'u6plus');
  assert.equal(slugify('AP Pro'), 'ap-pro');
  assert.equal(slugify('10G/SFP'), '10g-sfp');
});

test('parseViewBox accepts spaces and commas', () => {
  assert.deepEqual(parseViewBox('<svg viewBox="0, 0 153.99321 21.595139"></svg>'), [0, 0, 153.99321, 21.595139]);
});

test('manifest validation requires an element on each port', () => {
  const errors = validateManifest({ formatVersion: 1, vendor: 'A', model: 'B', type: 'switch', viewBox: [0, 0, 10, 10], ports: [{ label: '1', kind: 'ethernet', element: '' }] }, '<svg viewBox="0 0 10 10"></svg>');
  assert.ok(errors.some((error) => error.includes('Element assignment')));
});

test('manifest validation rejects duplicate SVG element references', () => {
  const manifest = {
    formatVersion: 1, vendor: 'A', model: 'B', type: 'switch', viewBox: [0, 0, 10, 10],
    ports: [{ label: '1', kind: 'ethernet', element: 'port-1' }, { label: '2', kind: 'ethernet', element: 'port-1' }]
  };
  const errors = validateManifest(manifest, '<svg viewBox="0 0 10 10"><rect id="port-1" x="0" y="0" width="1" height="1"/></svg>');
  assert.ok(errors.some((error) => error.includes('already assigned to another port')));
});

test('manifest validation accepts only the established device types', () => {
  const manifest = { formatVersion: 1, vendor: 'A', model: 'B', type: 'toaster', viewBox: [0, 0, 10, 10], ports: [] };
  assert.ok(validateManifest(manifest, '<svg viewBox="0 0 10 10"></svg>').includes('Select a valid device type.'));
});

test('catalog type ids use underscores and migrate legacy spellings', () => {
  assert.equal(normalizeDeviceType('Access Point'), 'access_point');
  assert.equal(normalizeDeviceType('access-point'), 'access_point');
  assert.equal(normalizeDeviceType('Patch Panel'), 'patch_panel');
});

test('manifest formatter keeps viewBox and every port on one line', () => {
  const output = formatManifest({
    formatVersion: 1, vendor: 'Vendor', model: 'Model', type: 'switch', viewBox: [0, 0, 10.5, 20],
    ports: [{ label: '1', kind: 'ethernet', element: 'port-1' }, { label: 'SFP+', kind: 'sfp', element: 'port-sfp' }]
  });
  assert.match(output, /^  "viewBox": \[0, 0, 10\.5, 20\],$/m);
  assert.match(output, /^    \{ "label": "1", "kind": "ethernet", "element": "port-1" \},$/m);
  assert.match(output, /^    \{ "label": "SFP\+", "kind": "sfp", "element": "port-sfp" \}$/m);
  assert.deepEqual(JSON.parse(output).viewBox, [0, 0, 10.5, 20]);
});

test('path containment rejects traversal', () => {
  assert.equal(isInside('C:\\assets', 'C:\\assets\\vendor\\model'), true);
  assert.equal(isInside('C:\\assets', 'C:\\elsewhere'), false);
});

test('unsafe and external SVG content is rejected', () => {
  assert.ok(validateSvg('<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>').some((error) => error.includes('<script>')));
  assert.ok(validateSvg('<svg viewBox="0 0 1 1"><use href="remote.svg#x"/></svg>').some((error) => error.includes('External reference')));
  assert.ok(validateSvg('<svg viewBox="0 0 1 1"><path onclick="x()"/></svg>').some((error) => error.includes('Event attributes')));
});

test('SVG cleaner removes Inkscape metadata while preserving artwork and IDs', async () => {
  const source = `<?xml version="1.0"?>
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" viewBox="0 0 153.99321 21.595139">
      <!-- Created with Inkscape -->
      <sodipodi:namedview id="namedview1"/>
      <g inkscape:groupmode="layer" inkscape:label="Ports"><rect id="rect1" x="0" y="0" width="10" height="10"/></g>
    </svg>`;
  const cleaned = cleanSvg(source);
  assert.equal(validateSvg(cleaned.svg).length, 0);
  assert.doesNotMatch(cleaned.svg, /sodipodi:|inkscape:|<sodipodi:|Created with Inkscape|<!--/i);
  assert.match(cleaned.svg, /id="rect1"/);
  assert.deepEqual(parseViewBox(cleaned.svg), [0, 0, 153.99321, 21.595139]);
  assert.ok(cleaned.report.removedElements > 0);
  assert.ok(cleaned.report.removedAttributes > 0);
});

test('SVG cleaner removes inline and multiline XML comments', () => {
  const source = '<?xml version="1.0"?><!-- before --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><!--\ninside\n--><path id="kept" d="M0 0h1v1z"/><!-- after path --></svg><!-- after -->';
  const cleaned = cleanSvg(source);
  assert.doesNotMatch(cleaned.svg, /<!--|before|inside|after/);
  assert.match(cleaned.svg, /id="kept"/);
  assert.ok(cleaned.report.removedMetadataNodes >= 4);
});

test('SVG formatter writes readable indented XML without changing text content', () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g id="ports"><path id="port-1" d="M0 0h1v1z"/><text id="label">Port  1</text></g></svg>';
  const output = formatSvg(source);
  assert.match(output, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(output, /\n  <g id="ports">\n    <path id="port-1"/);
  assert.match(output, /<text id="label">Port  1<\/text>/);
  assert.equal(validateSvg(output).length, 0);
});

test('a valid library is discovered', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'device-manager-valid-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'mokerlink', '2g08110gsm');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'device.json'), JSON.stringify({
    formatVersion: 1, vendor: 'MokerLink', model: '2G08110GSM', type: 'switch', viewBox: [0, 0, 10, 10],
    ports: [{ label: '1', kind: 'ethernet', element: 'port-1' }]
  }));
  await fs.writeFile(path.join(folder, 'front.svg'), '<svg viewBox="0 0 10 10"><rect id="port-1" x="0" y="0" width="2" height="2"/></svg>');
  const devices = await scanLibrary(root);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, 'mokerlink/2g08110gsm');
  assert.equal(devices[0].validation.status, 'valid');
});

test('server rules report invalid assets and non-fatal paint warnings', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'device-manager-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'Bad Vendor', 'model');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'device.json'), JSON.stringify({
    formatVersion: 1, vendor: 'Vendor', model: 'Model', type: 'access-point', viewBox: [0, 0, 10, 10],
    ports: [{ label: '1', kind: 'ethernet', element: 'port-1' }, { label: '1', kind: 'ethernet', element: 'port-1' }]
  }));
  await fs.writeFile(path.join(folder, 'front.svg'), '<svg viewBox="0 0 10 10"><rect id="port-1" fill="none" x="0" y="0" width="2" height="2"/></svg>');
  const result = await validateDeviceFolder(root, 'Bad Vendor', 'model');
  assert.ok(result.errors.some((error) => error.startsWith('A1:')));
  assert.ok(result.errors.some((error) => error.startsWith('B6:')));
  assert.ok(result.errors.some((error) => error.startsWith('D3:')));
  assert.equal(result.warnings.filter((warning) => warning.startsWith('D13:')).length, 2);
});

test('library scan includes incomplete asset folders', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'device-manager-incomplete-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'vendor', 'model'), { recursive: true });
  await fs.writeFile(path.join(root, 'vendor', 'model', 'device.json'), '{}');
  const devices = await scanLibrary(root);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].loadable, false);
  assert.ok(devices[0].validation.errors.includes('A2: front.svg is missing.'));
});
