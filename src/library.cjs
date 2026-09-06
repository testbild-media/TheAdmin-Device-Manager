const fs = require('node:fs/promises');
const path = require('node:path');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { slugify, isValidAssetSlug, slugError } = require('./asset-slug.js');

const ALLOWED_TAGS = new Set([
  'svg', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'g',
  'text', 'tspan', 'title', 'desc', 'defs', 'style', 'use', 'symbol',
  'lineargradient', 'radialgradient', 'stop', 'pattern', 'clippath', 'mask'
]);
const SELECTABLE_TAGS = new Set([
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'g', 'text', 'tspan', 'use'
]);
const PORT_KINDS = ['ethernet', 'sfp', 'qsfp', 'console', 'power', 'other'];
const DEVICE_TYPES = ['access_point', 'camera', 'firewall', 'nvr', 'other', 'patch_panel', 'printer', 'router', 'server', 'switch', 'ups', 'workstation'];

function normalizeDeviceType(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ({ accesspoint: 'access_point', patchpanel: 'patch_panel' })[normalized] || normalized;
}

function parseViewBox(svg) {
  const match = String(svg).match(/<svg\b[^>]*\bviewBox\s*=\s*["']([^"']+)["']/i);
  if (!match) throw new Error('The SVG has no viewBox.');
  const values = match[1].trim().split(/[\s,]+/).map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('The SVG viewBox must contain exactly four numbers.');
  }
  return values;
}

function validateManifest(manifest, svg) {
  const errors = validateSvg(svg);
  if (manifest.formatVersion !== 1) errors.push('formatVersion must be 1.');
  if (!String(manifest.vendor || '').trim()) errors.push('Vendor is required.');
  if (!String(manifest.model || '').trim()) errors.push('Model name is required.');
  if (!DEVICE_TYPES.includes(normalizeDeviceType(manifest.type))) errors.push('Select a valid device type.');
  let viewBox;
  try { viewBox = parseViewBox(svg); } catch (error) { errors.push(error.message); }
  if (!Array.isArray(manifest.viewBox) || manifest.viewBox.length !== 4) {
    errors.push('The manifest viewBox is invalid.');
  } else if (viewBox && viewBox.some((value, index) => Math.abs(value - Number(manifest.viewBox[index])) > 0.01)) {
    errors.push('The manifest and SVG viewBox values do not match.');
  }
  const svgElements = indexSvgElements(svg);
  if (!Array.isArray(manifest.ports) || !manifest.ports.length) errors.push('At least one port is required.');
  else {
    const labels = new Set();
    const elementReferences = new Set();
    manifest.ports.forEach((port, index) => {
    const title = `Port ${index + 1}`;
    if (!String(port.label || '').trim()) errors.push(`${title}: Label is required.`);
    else if (labels.has(port.label)) errors.push(`${title}: Label “${port.label}” is duplicated.`);
    else labels.add(port.label);
    if (!PORT_KINDS.includes(port.kind)) errors.push(`${title}: Kind is invalid.`);
    const element = String(port.element || '').trim();
    if (!element) errors.push(`${title}: Element assignment is required.`);
    else if (elementReferences.has(element)) errors.push(`${title}: SVG element “${element}” is already assigned to another port.`);
    else elementReferences.add(element);
    if (element && !svgElements.has(element)) errors.push(`${title}: SVG element “${element}” does not exist.`);
    else if (element && svgElements.get(element).count > 1) errors.push(`${title}: ID “${element}” occurs more than once.`);
    else if (element && !SELECTABLE_TAGS.has(svgElements.get(element).tag)) errors.push(`${title}: <${svgElements.get(element).tag}> cannot be assigned.`);
    });
  }
  return errors;
}

function validateSvg(svg) {
  const errors = [];
  const source = String(svg);
  const clean = source.replace(/<!--[\s\S]*?-->/g, '');
  const tagPattern = /<\s*\/?\s*([\w:-]+)\b([^>]*)>/g;
  let match;
  while ((match = tagPattern.exec(clean))) {
    const tag = match[1].split(':').pop().toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) errors.push(`SVG element <${tag}> is not allowed.`);
    const attributes = match[2];
    if (/[\s"']on[a-z]+\s*=/i.test(` ${attributes}`)) errors.push(`Event attributes on <${tag}> are not allowed.`);
    for (const attribute of attributes.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
      const name = attribute[1].toLowerCase();
      const value = attribute[3].trim();
      if ((name === 'href' || name.endsWith(':href')) && value && !value.startsWith('#')) errors.push(`External reference “${value}” is not allowed.`);
    }
  }
  if (/@import/i.test(clean)) errors.push('@import is not allowed in SVG styles.');
  if (/url\(\s*['"]?\s*(https?:)?\/\//i.test(clean)) errors.push('External URLs are not allowed in SVG styles.');
  return [...new Set(errors)];
}

function cleanSvg(svg) {
  const parsed = parseSvgXml(svg);
  if (parsed.errors.length || !parsed.document?.documentElement) {
    throw new Error(`The SVG is not valid readable XML${parsed.errors[0] ? `: ${parsed.errors[0]}` : '.'}`);
  }
  const document = parsed.document;
  const root = document.documentElement;
  if ((root.localName || root.nodeName).split(':').pop().toLowerCase() !== 'svg') throw new Error('The selected file has no SVG root element.');
  const report = { removedElements: 0, removedAttributes: 0, removedMetadataNodes: 0 };

  removeMetadataNodes(document, report);
  const nodes = Array.from(root.getElementsByTagName('*'));
  nodes.forEach((node) => {
    const tag = (node.localName || node.nodeName).split(':').pop().toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) { node.parentNode?.removeChild(node); report.removedElements += 1; return; }
    if (tag === 'style' && (/@import/i.test(node.textContent || '') || /url\(\s*['"]?\s*(https?:)?\/\//i.test(node.textContent || ''))) {
      node.parentNode?.removeChild(node); report.removedElements += 1; return;
    }
    const attributes = Array.from(node.attributes || []);
    let removeNode = false;
    attributes.forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      const prefix = name.includes(':') ? name.split(':')[0] : '';
      const editorMetadata = name.startsWith('inkscape:') || name.startsWith('sodipodi:') || (prefix && !['xml', 'xlink'].includes(prefix));
      const unsafeEvent = /^on[a-z]+$/i.test(name);
      const externalHref = (name === 'href' || name.endsWith(':href')) && value && !value.startsWith('#');
      if (externalHref) { removeNode = true; return; }
      if (editorMetadata || unsafeEvent) { node.removeAttributeNode(attribute); report.removedAttributes += 1; return; }
      if (name === 'style') {
        const cleanedStyle = value.split(';').map((part) => part.trim()).filter((part) => part && !/^-inkscape-/i.test(part) && !/@import/i.test(part) && !/url\(\s*['"]?\s*(https?:)?\/\//i.test(part)).join(';');
        if (cleanedStyle !== value.replace(/;\s*$/, '')) report.removedAttributes += 1;
        if (cleanedStyle) node.setAttribute(attribute.name, cleanedStyle); else node.removeAttribute(attribute.name);
      }
    });
    if (removeNode) { node.parentNode?.removeChild(node); report.removedElements += 1; }
  });

  Array.from(root.attributes || []).forEach((attribute) => {
    const name = attribute.name.toLowerCase();
    const namespaceDeclaration = name.startsWith('xmlns:') && name !== 'xmlns:xlink';
    if (['width', 'height', 'version'].includes(name) || name.startsWith('inkscape:') || name.startsWith('sodipodi:') || namespaceDeclaration) {
      root.removeAttributeNode(attribute); report.removedAttributes += 1;
    }
  });
  removeEmptyDefs(root, report);
  if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const output = formatSvgDocument(root);
  const validationErrors = validateSvg(output);
  if (validationErrors.length) throw new Error(`The SVG could not be cleaned safely:\n${validationErrors.join('\n')}`);
  return { svg: output, report };
}

function formatSvg(svg) {
  const parsed = parseSvgXml(svg);
  if (parsed.errors.length || !parsed.document?.documentElement) {
    throw new Error(`The SVG cannot be formatted because it is not valid XML${parsed.errors[0] ? `: ${parsed.errors[0]}` : '.'}`);
  }
  return formatSvgDocument(parsed.document.documentElement);
}

function formatSvgDocument(root) {
  const serializer = new XMLSerializer();
  const preserveInline = new Set(['text', 'tspan', 'style', 'title', 'desc']);
  const formatNode = (node, depth) => {
    const indent = '  '.repeat(depth);
    const tag = (node.localName || node.nodeName).split(':').pop().toLowerCase();
    const serializeHere = (target) => {
      const serialized = serializer.serializeToString(target).trim();
      return depth > 0 ? serialized.replace(/\s+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '') : serialized;
    };
    if (preserveInline.has(tag)) return `${indent}${serializeHere(node)}`;
    const childElements = Array.from(node.childNodes || []).filter((child) => child.nodeType === 1);
    const significantText = Array.from(node.childNodes || []).filter((child) => (child.nodeType === 3 || child.nodeType === 4) && child.nodeValue.trim());
    if (!childElements.length && !significantText.length) return `${indent}${serializeHere(node)}`;
    if (!childElements.length) return `${indent}${serializeHere(node)}`;
    const serialized = serializeHere(node);
    const openingEnd = serialized.indexOf('>');
    let opening = serialized.slice(0, openingEnd + 1).replace(/\/>$/, '>');
    const lines = [`${indent}${opening}`];
    Array.from(node.childNodes || []).forEach((child) => {
      if (child.nodeType === 1) lines.push(formatNode(child, depth + 1));
      else if ((child.nodeType === 3 || child.nodeType === 4) && child.nodeValue.trim()) lines.push(`${'  '.repeat(depth + 1)}${serializer.serializeToString(child).trim()}`);
    });
    lines.push(`${indent}</${node.nodeName}>`);
    return lines.join('\n');
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n${formatNode(root, 0)}\n`;
}

function removeMetadataNodes(node, report) {
  Array.from(node.childNodes || []).forEach((child) => {
    if (child.nodeType === 7 || child.nodeType === 8) { node.removeChild(child); report.removedMetadataNodes += 1; }
    else if (child.nodeType === 1) removeMetadataNodes(child, report);
  });
}

function removeEmptyDefs(root, report) {
  Array.from(root.getElementsByTagName('*')).reverse().forEach((node) => {
    const tag = (node.localName || node.nodeName).split(':').pop().toLowerCase();
    if (tag === 'defs' && !Array.from(node.childNodes || []).some((child) => child.nodeType === 1)) {
      node.parentNode?.removeChild(node); report.removedElements += 1;
    }
  });
}

function indexSvgElements(svg) {
  const result = new Map();
  const clean = String(svg).replace(/<!--[\s\S]*?-->/g, '');
  for (const match of clean.matchAll(/<\s*([\w:-]+)\b([^>]*)>/g)) {
    const tag = match[1].split(':').pop().toLowerCase();
    const idMatch = match[2].match(/\bid\s*=\s*(["'])(.*?)\1/i);
    if (!idMatch) continue;
    const id = idMatch[2];
    const current = result.get(id);
    result.set(id, { tag, count: current ? current.count + 1 : 1 });
  }
  return result;
}

function formatManifest(manifest) {
  const lines = [
    '{',
    `  "formatVersion": ${JSON.stringify(manifest.formatVersion)},`,
    `  "vendor": ${JSON.stringify(manifest.vendor)},`,
    `  "model": ${JSON.stringify(manifest.model)},`,
    `  "type": ${JSON.stringify(manifest.type)},`,
    `  "viewBox": [${manifest.viewBox.map((value) => JSON.stringify(value)).join(', ')}],`,
    '  "ports": ['
  ];
  manifest.ports.forEach((port, index) => {
    const inlinePort = `{ "label": ${JSON.stringify(port.label)}, "kind": ${JSON.stringify(port.kind)}, "element": ${JSON.stringify(port.element)} }`;
    lines.push(`    ${inlinePort}${index < manifest.ports.length - 1 ? ',' : ''}`);
  });
  lines.push('  ]', '}');
  return `${lines.join('\n')}\n`;
}

async function scanLibrary(root) {
  const devices = [];
  const vendors = await safeDirectories(root);
  for (const vendorDir of vendors) {
    const models = await safeDirectories(path.join(root, vendorDir));
    for (const modelDir of models) {
      const folder = path.join(root, vendorDir, modelDir);
      const validation = await validateDeviceFolder(root, vendorDir, modelDir);
      devices.push({
        id: `${vendorDir}/${modelDir}`,
        vendorDir,
        modelDir,
        vendor: validation.manifest?.vendor || vendorDir,
        model: validation.manifest?.model || modelDir,
        type: validation.manifest?.type ? normalizeDeviceType(validation.manifest.type) : 'other',
        folder,
        loadable: validation.loadable,
        validation: { status: validation.errors.length ? 'error' : validation.warnings.length ? 'warning' : 'valid', errors: validation.errors, warnings: validation.warnings }
      });
    }
  }
  return devices.sort((a, b) => `${a.vendor}\0${a.type}\0${a.model}`.localeCompare(`${b.vendor}\0${b.type}\0${b.model}`, 'de'));
}

async function validateDeviceFolder(root, vendorDir, modelDir) {
  const errors = [];
  const warnings = [];
  const folder = path.join(root, vendorDir, modelDir);
  if (!isValidAssetSlug(vendorDir)) errors.push(`A1: Vendor folder “${vendorDir}” is not a valid asset slug.`);
  if (!isValidAssetSlug(modelDir)) errors.push(`A1: Model folder “${modelDir}” is not a valid asset slug.`);

  const manifestPath = path.join(folder, 'device.json');
  const svgPath = path.join(folder, 'front.svg');
  const manifestExists = await fileExists(manifestPath);
  const svgExists = await fileExists(svgPath);
  if (!manifestExists) errors.push('A2: device.json is missing.');
  if (!svgExists) errors.push('A2: front.svg is missing.');
  if (!manifestExists || !svgExists) return { errors, warnings, manifest: null, loadable: false };

  let manifest;
  let manifestText;
  try {
    manifestText = (await fs.readFile(fileSystemPath(manifestPath), 'utf8')).replace(/^\uFEFF/, '');
    manifest = JSON.parse(manifestText);
  } catch (error) {
    errors.push(`B1: device.json is not valid readable JSON (${error.message}).`);
    return { errors, warnings, manifest: null, loadable: false };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push('B2: device.json must be a JSON object.');
    return { errors, warnings, manifest: null, loadable: false };
  }
  if (manifest.formatVersion !== 1) errors.push('B3: formatVersion must be exactly 1.');
  if (!String(manifest.vendor || '').trim()) errors.push('B4: vendor is missing or empty.');
  if (!String(manifest.model || '').trim()) errors.push('B5: model is missing or empty.');
  const vendorSlugError = slugError('Vendor', manifest.vendor);
  const modelSlugError = slugError('Model', manifest.model);
  if (vendorSlugError) errors.push(`A3: ${vendorSlugError}`);
  else if (slugify(manifest.vendor) !== vendorDir) errors.push(`A3: Vendor folder must be “${slugify(manifest.vendor)}” for manifest vendor “${manifest.vendor}”.`);
  if (modelSlugError) errors.push(`A3: ${modelSlugError}`);
  else if (slugify(manifest.model) !== modelDir) errors.push(`A3: Model folder must be “${slugify(manifest.model)}” for manifest model “${manifest.model}”.`);
  if (manifest.type !== undefined && manifest.type !== null && (typeof manifest.type !== 'string' || !/^[a-z]+(?:_[a-z]+)*$/.test(manifest.type))) {
    errors.push('B6: type may only contain lowercase words separated by single underscores.');
  }
  const manifestViewBoxValid = Array.isArray(manifest.viewBox) && manifest.viewBox.length === 4 && manifest.viewBox.every(isNumber);
  if (!manifestViewBoxValid) errors.push('B7: viewBox must be an array containing exactly four numbers.');

  const svg = await fs.readFile(fileSystemPath(svgPath), 'utf8');
  let svgViewBox;
  try { svgViewBox = parseViewBox(svg); }
  catch { errors.push('C1: front.svg has no valid viewBox attribute.'); }
  if (manifestViewBoxValid && svgViewBox && svgViewBox.some((value, index) => Math.abs(value - manifest.viewBox[index]) > 0.01)) {
    errors.push('C2: The viewBox values in device.json and front.svg do not match.');
  }

  const portsValid = Array.isArray(manifest.ports) && manifest.ports.length > 0;
  if (!portsValid) errors.push('D1: ports must exist and must not be empty.');
  const elementPorts = [];
  if (Array.isArray(manifest.ports)) {
    const labelCounts = new Map();
    manifest.ports.forEach((port, index) => {
      const title = `Port ${index + 1}`;
      if (!port || typeof port !== 'object' || Array.isArray(port)) { errors.push(`D2: ${title} must be an object.`); return; }
      labelCounts.set(port.label, (labelCounts.get(port.label) || 0) + 1);
      if (!PORT_KINDS.includes(port.kind)) errors.push(`D4: ${title} has an invalid kind value.`);
      const hasShape = Object.hasOwn(port, 'shape') && port.shape !== null;
      const hasElement = Object.hasOwn(port, 'element') && port.element !== null;
      if (hasShape === hasElement) errors.push(`D5: ${title} must contain exactly one of shape or element.`);
      if (hasShape) validateShape(port.shape, title, manifest.viewBox, manifestViewBoxValid, errors);
      if (hasElement) {
        if (typeof port.element !== 'string' || !port.element.trim()) errors.push(`D8: ${title} requires a non-empty element ID.`);
        else elementPorts.push({ ...port, index });
      }
    });
    for (const [label, count] of labelCounts) if (count > 1) errors.push(`D3: Port label “${String(label)}” is duplicated.`);
  }

  let svgDocument = null;
  let xmlErrors = [];
  if (elementPorts.length || svg) ({ document: svgDocument, errors: xmlErrors } = parseSvgXml(svg));
  if (elementPorts.length && xmlErrors.length) errors.push(`D9: front.svg is not valid readable XML (${xmlErrors[0]}).`);
  if (svgDocument && !xmlErrors.length) validateElementPorts(svgDocument, elementPorts, errors, warnings);
  validateSvg(svg).forEach((error) => errors.push(`E: ${error}`));
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)], manifest, loadable: true };
}

function validateShape(shape, title, viewBox, viewBoxValid, errors) {
  const valid = shape && typeof shape === 'object' && ['x', 'y', 'w', 'h'].every((key) => isNumber(shape[key]));
  if (!valid) { errors.push(`D6: ${title} has no valid shape containing numeric x, y, w, and h values.`); return; }
  if (!viewBoxValid) return;
  const [vx, vy, vw, vh] = viewBox;
  if (shape.x < vx || shape.y < vy || shape.x + shape.w > vx + vw || shape.y + shape.h > vy + vh) errors.push(`D7: ${title} shape is not fully inside the viewBox.`);
}

function parseSvgXml(svg) {
  const errors = [];
  const parser = new DOMParser({ errorHandler: { warning: () => {}, error: (message) => errors.push(message), fatalError: (message) => errors.push(message) } });
  const document = parser.parseFromString(svg, 'image/svg+xml');
  return { document, errors };
}

function validateElementPorts(document, ports, errors, warnings) {
  const all = Array.from(document.getElementsByTagName('*'));
  ports.forEach((port) => {
    const title = `Port ${port.index + 1}`;
    const matches = all.filter((node) => node.getAttribute('id') === port.element);
    if (!matches.length) { errors.push(`D10: ${title} references missing ID “${port.element}”.`); return; }
    if (matches.length !== 1) { errors.push(`D11: ID “${port.element}” occurs more than once.`); return; }
    const node = matches[0];
    const tag = (node.localName || node.nodeName).split(':').pop().toLowerCase();
    if (!SELECTABLE_TAGS.has(tag)) errors.push(`D12: ${title} references non-assignable element <${tag}>.`);
    const style = node.getAttribute('style') || '';
    if ((node.getAttribute('fill') || '').trim().toLowerCase() === 'none' || /(?:^|;)\s*fill\s*:\s*none\s*(?:;|$)/i.test(style) || (node.getAttribute('opacity') || '').trim() === '0' || /(?:^|;)\s*opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)/i.test(style)) {
      warnings.push(`D13: ${title} (“${port.element}”) has no paintable fill area.`);
    }
  });
}

function isNumber(value) { return typeof value === 'number' && Number.isFinite(value); }
async function fileExists(file) { try { await fs.access(fileSystemPath(file)); return true; } catch { return false; } }

async function safeDirectories(folder) {
  try {
    return (await fs.readdir(fileSystemPath(folder), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch { return []; }
}

async function pruneAssetlessFolders(root) {
  const removed = [];
  if (!isDeviceAssetsRoot(root)) return removed;
  const vendorEntries = await readDirectoryEntries(root);
  for (const vendorEntry of vendorEntries.filter((entry) => entry.isDirectory())) {
    const vendorFolder = path.join(root, vendorEntry.name);
    const modelEntries = await readDirectoryEntries(vendorFolder);
    for (const modelEntry of modelEntries.filter((entry) => entry.isDirectory())) {
      const modelFolder = path.join(vendorFolder, modelEntry.name);
      const contents = await readDirectoryEntries(modelFolder);
      const hasManifest = contents.some((entry) => entry.isFile() && entry.name === 'device.json');
      const hasSvg = contents.some((entry) => entry.isFile() && entry.name === 'front.svg');
      if (hasManifest || hasSvg) continue;
      await fs.rm(fileSystemPath(modelFolder), { recursive: true, force: false });
      removed.push(`${vendorEntry.name}/${modelEntry.name}`);
    }
    if (!(await readDirectoryEntries(vendorFolder)).length) {
      await fs.rmdir(fileSystemPath(vendorFolder));
      removed.push(vendorEntry.name);
    }
  }
  return removed;
}

async function readDirectoryEntries(folder) {
  try { return await fs.readdir(fileSystemPath(folder), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function fileSystemPath(value) {
  return process.platform === 'win32' ? path.toNamespacedPath(value) : value;
}

function isDeviceAssetsRoot(value) {
  return path.basename(path.resolve(String(value || ''))) === 'device-assets';
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

module.exports = { ALLOWED_TAGS, SELECTABLE_TAGS, PORT_KINDS, DEVICE_TYPES, normalizeDeviceType, slugify, isValidAssetSlug, slugError, parseViewBox, validateSvg, cleanSvg, formatSvg, validateManifest, validateDeviceFolder, formatManifest, scanLibrary, pruneAssetlessFolders, fileSystemPath, isDeviceAssetsRoot, isInside };
