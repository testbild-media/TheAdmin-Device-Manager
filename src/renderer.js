const ALLOWED = new Set(['svg','path','rect','circle','ellipse','line','polyline','polygon','g','text','tspan','title','desc','defs','style','use','symbol','lineargradient','radialgradient','stop','pattern','clippath','mask']);
const SELECTABLE = new Set(['path','rect','circle','ellipse','line','polyline','polygon','g','use']);
const KINDS = ['ethernet', 'sfp', 'qsfp', 'console', 'power', 'other'];
const TYPE_LABELS = {
  access_point: 'Access Point', camera: 'Camera', firewall: 'Firewall', nvr: 'NVR', other: 'Other',
  patch_panel: 'Patch Panel', printer: 'Printer', router: 'Router', server: 'Server', switch: 'Switch',
  ups: 'UPS', workstation: 'Workstation'
};

const state = { root: null, libraryRoot: null, libraryKind: null, archivePath: null, metadata: null, devices: [], currentId: null, manifest: null, svg: '', dirty: false, activePort: null, activeLayer: -1, layers: [], collapsedTree: new Set() };
const $ = (selector) => document.querySelector(selector);
const elements = {
  createLibrary: $('#create-library'), openUserLibrary: $('#open-user-library'), openExternalLibrary: $('#open-external-library'), editLibrary: $('#edit-library'), mergeLibrary: $('#merge-library'), exportLibrary: $('#export-library'), showLibrary: $('#show-library'), libraryMenu: $('#library-menu'),
  create: $('#new-device'), deleteDevice: $('#delete-device'), save: $('#save-device'), path: $('#library-path'), count: $('#device-count'), collapseTree: $('#collapse-tree'),
  tree: $('#device-tree'), title: $('#device-title'), dirty: $('#dirty-badge'), emptyCanvas: $('#empty-canvas'), content: $('#canvas-content'),
  preview: $('#svg-preview'), replaceSvg: $('#replace-svg'), layerList: $('#layer-list'), layerCount: $('#layer-count'), layerFilter: $('#layer-filter'),
  editorEmpty: $('#editor-empty'), form: $('#manifest-form'), viewBox: $('#viewbox-value'), formErrors: $('#form-errors'), ports: $('#ports-list'), portsToAdd: $('#ports-to-add'), addPort: $('#add-port'), toast: $('#toast'),
  libraryDialog: $('#library-editor'), libraryForm: $('#library-editor-form'), libraryDialogTitle: $('#library-editor-title'), libraryDialogDescription: $('#library-editor-description'), libraryName: $('#library-name'), libraryAuthor: $('#library-author'), libraryVersion: $('#library-version'), libraryError: $('#library-editor-error'), libraryCancel: $('#library-editor-cancel'), librarySubmit: $('#library-editor-submit'),
  mergeDialog: $('#merge-dialog'), mergeForm: $('#merge-form'), mergeConflicts: $('#merge-conflicts'), mergeCancel: $('#merge-cancel'), mergeSubmit: $('#merge-submit')
};

elements.createLibrary.addEventListener('click', createLibrary);
elements.openUserLibrary.addEventListener('click', openUserLibrary);
elements.openExternalLibrary.addEventListener('click', openExternalLibrary);
elements.editLibrary.addEventListener('click', editLibrary);
elements.mergeLibrary.addEventListener('click', mergeLibrary);
elements.exportLibrary.addEventListener('click', exportLibrary);
elements.showLibrary.addEventListener('click', showLibrary);
elements.create.addEventListener('click', createDevice);
elements.deleteDevice.addEventListener('click', deleteDevice);
elements.save.addEventListener('click', saveDevice);
elements.replaceSvg.addEventListener('click', replaceSvg);
elements.addPort.addEventListener('click', addPort);
elements.portsToAdd.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addPort(); } });
elements.collapseTree.addEventListener('click', collapseTree);
elements.layerFilter.addEventListener('input', renderLayers);
elements.form.addEventListener('input', onFormInput);
elements.layerList.addEventListener('keydown', onLayerKey);
elements.preview.addEventListener('click', onSvgClick);
window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!elements.save.disabled) saveDevice(); }
});
window.deviceStudio.onSaveBeforeClose(async () => window.deviceStudio.finishCloseAfterSave(await saveDevice()));
initializeLibrary();

async function initializeLibrary() {
  try {
    const result = await window.deviceStudio.startupLibrary();
    if (!result.ok) { notify(result.error, true); return; }
    if (result.data.needsSetup) { clearLibrary(); await createLibrary(true); return; }
    applyLibrary(result.data);
  } catch (error) { notify(`The user library could not be opened.\n${error.message}`, true); }
}

function applyLibrary(result) {
  state.root = result.root; state.libraryRoot = result.libraryRoot; state.libraryKind = result.libraryKind; state.archivePath = result.archivePath; state.metadata = result.metadata; state.devices = result.devices; state.currentId = null; state.manifest = null; state.svg = ''; state.dirty = false;
  state.collapsedTree.clear();
  updateLibraryHeader(); elements.create.disabled = false; elements.deleteDevice.disabled = true; elements.save.disabled = true;
  [elements.editLibrary, elements.mergeLibrary, elements.exportLibrary, elements.showLibrary].forEach((button) => { button.disabled = false; });
  clearEditor(); updateDirty(); renderTree(); runAdvancedLibraryValidation(result.root);
  reportRemovedFolders(result.removedFolders);
}

function clearLibrary() {
  state.root = null; state.libraryRoot = null; state.libraryKind = null; state.archivePath = null; state.metadata = null; state.devices = []; state.currentId = null; state.manifest = null; state.svg = ''; state.dirty = false;
  elements.path.textContent = 'No library opened'; elements.path.title = '';
  elements.create.disabled = true; elements.deleteDevice.disabled = true; elements.save.disabled = true;
  [elements.editLibrary, elements.mergeLibrary, elements.exportLibrary, elements.showLibrary].forEach((button) => { button.disabled = true; });
  clearEditor(); updateDirty(); renderTree();
}

function updateLibraryHeader() {
  const location = state.libraryKind === 'archive' ? state.archivePath : state.libraryRoot;
  elements.path.textContent = `${state.metadata.name} · v${state.metadata.version}`;
  elements.path.title = location || '';
}

async function createLibrary(firstRun = false) {
  if (!firstRun && !canLeave()) return;
  closeLibraryMenu();
  const metadata = await promptLibraryMetadata({
    title: 'Create user library', description: 'The default devices will be downloaded from the main branch.',
    submitLabel: 'Create library', required: firstRun, initial: { name: 'My Device Library', author: '', version: '1.0.0' }
  });
  if (!metadata) return;
  await runLibraryAction(window.deviceStudio.createLibrary(metadata), 'Creating library and fetching default devices…', (data) => { if (data) applyLibrary(data); });
}

async function openUserLibrary() {
  if (!canLeave()) return;
  closeLibraryMenu();
  await runLibraryAction(window.deviceStudio.openUserLibrary(), 'Opening user library…', async (data) => {
    if (data?.needsSetup) await createLibrary(true); else if (data) applyLibrary(data);
  });
}

async function openExternalLibrary() {
  if (!canLeave()) return;
  closeLibraryMenu();
  await runLibraryAction(window.deviceStudio.openExternalLibrary(), 'Opening and validating external library…', (data) => { if (data) applyLibrary(data); });
}

async function editLibrary() {
  if (!state.metadata || !canLeave()) return;
  closeLibraryMenu();
  const metadata = await promptLibraryMetadata({ title: 'Edit library', description: 'Device count and update date are maintained automatically.', submitLabel: 'Save library', initial: state.metadata });
  if (!metadata) return;
  await runLibraryAction(window.deviceStudio.editLibrary(metadata), 'Saving library metadata…', (data) => { if (data) applyLibrary(data); });
}

async function exportLibrary() {
  if (!state.metadata || !canLeave()) return;
  closeLibraryMenu();
  await runLibraryAction(window.deviceStudio.exportLibrary(), 'Creating ADLIB copy…', (data) => { if (data) notify(`Library exported to\n${data.path}`); });
}

async function showLibrary() {
  closeLibraryMenu();
  await runLibraryAction(window.deviceStudio.showLibrary(), 'Opening library folder…');
}

async function deleteDevice() {
  if (!state.currentId || !canLeave()) return;
  await runLibraryAction(window.deviceStudio.deleteDevice(state.currentId), 'Deleting device…', (data) => { if (data) { applyLibrary(data); notify('Device deleted.'); } });
}

async function mergeLibrary() {
  if (!state.metadata || !canLeave()) return;
  closeLibraryMenu();
  const preparedResult = await window.deviceStudio.prepareMerge();
  if (!preparedResult.ok) { notify(preparedResult.error, true); return; }
  const prepared = preparedResult.data;
  if (!prepared) return;
  const decisions = prepared.conflicts.length ? await promptMergeDecisions(prepared.conflicts) : {};
  if (!decisions) { await window.deviceStudio.cancelMerge(prepared.token); return; }
  await runLibraryAction(window.deviceStudio.commitMerge({ token: prepared.token, decisions }), 'Merging and validating libraries…', (data) => {
    if (data) { applyLibrary(data); notify(`Merge complete. Processed ${data.mergedCount} incoming device${data.mergedCount === 1 ? '' : 's'}.`); }
  });
}

async function runLibraryAction(promise, progress, onSuccess = null) {
  notify(progress);
  try {
    const result = await promise;
    if (!result.ok) { notify(result.error || 'The operation failed.', true); return null; }
    if (onSuccess) await onSuccess(result.data);
    return result.data;
  } catch (error) { notify(error.message, true); return null; }
}

function promptLibraryMetadata({ title, description, submitLabel, initial, required = false }) {
  elements.libraryDialogTitle.textContent = title;
  elements.libraryDialogDescription.textContent = description;
  elements.librarySubmit.textContent = submitLabel;
  elements.libraryName.value = initial?.name || '';
  elements.libraryAuthor.value = initial?.author || '';
  elements.libraryVersion.value = initial?.version || '1.0.0';
  elements.libraryError.textContent = ''; elements.libraryError.classList.add('hidden');
  elements.libraryCancel.classList.toggle('hidden', required);
  elements.libraryDialog.showModal();
  elements.libraryName.focus();
  return new Promise((resolve) => {
    const finish = (value) => {
      elements.libraryForm.removeEventListener('submit', submit);
      elements.libraryCancel.removeEventListener('click', cancel);
      elements.libraryDialog.removeEventListener('cancel', cancel);
      elements.libraryDialog.close(); resolve(value);
    };
    const submit = (event) => {
      event.preventDefault();
      const value = { name: elements.libraryName.value.trim(), author: elements.libraryAuthor.value.trim(), version: elements.libraryVersion.value.trim() };
      const errors = [];
      if (!value.name) errors.push('Library name is required.');
      if (!value.author) errors.push('Author is required.');
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)) errors.push('Version must use semantic versioning, for example 1.0.0.');
      if (errors.length) { elements.libraryError.textContent = errors.join('\n'); elements.libraryError.classList.remove('hidden'); return; }
      finish(value);
    };
    const cancel = (event) => { event.preventDefault(); if (!required) finish(null); };
    elements.libraryForm.addEventListener('submit', submit);
    elements.libraryCancel.addEventListener('click', cancel);
    elements.libraryDialog.addEventListener('cancel', cancel);
  });
}

function promptMergeDecisions(conflicts) {
  elements.mergeConflicts.replaceChildren(...conflicts.map((conflict, index) => {
    const row = el('div', 'merge-conflict');
    const details = el('div'); details.innerHTML = `<strong>${escapeHtml(conflict.label)}</strong><small>${escapeHtml(conflict.id)}</small>`;
    const current = document.createElement('label'); current.className = 'merge-choice'; current.innerHTML = `<input type="radio" name="merge-${index}" value="current"${conflict.suggested === 'current' ? ' checked' : ''}><span>Keep current<small>${escapeHtml(formatDate(conflict.currentModified))}</small></span>`;
    const incoming = document.createElement('label'); incoming.className = 'merge-choice'; incoming.innerHTML = `<input type="radio" name="merge-${index}" value="incoming"${conflict.suggested === 'incoming' ? ' checked' : ''}><span>Use incoming<small>${escapeHtml(formatDate(conflict.incomingModified))}</small></span>`;
    row.append(details, current, incoming); row.dataset.id = conflict.id; return row;
  }));
  elements.mergeDialog.showModal();
  return new Promise((resolve) => {
    const finish = (value) => { elements.mergeForm.removeEventListener('submit', submit); elements.mergeCancel.removeEventListener('click', cancel); elements.mergeDialog.removeEventListener('cancel', cancel); elements.mergeDialog.close(); resolve(value); };
    const submit = (event) => { event.preventDefault(); const decisions = {}; [...elements.mergeConflicts.children].forEach((row, index) => { decisions[row.dataset.id] = row.querySelector(`input[name="merge-${index}"]:checked`).value; }); finish(decisions); };
    const cancel = (event) => { event.preventDefault(); finish(null); };
    elements.mergeForm.addEventListener('submit', submit); elements.mergeCancel.addEventListener('click', cancel); elements.mergeDialog.addEventListener('cancel', cancel);
  });
}

function closeLibraryMenu() { elements.libraryMenu.open = false; }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString(); }

function reportRemovedFolders(removedFolders) {
  const message = removedFoldersMessage(removedFolders);
  if (message) notify(message);
}

function removedFoldersMessage(removedFolders) {
  if (!Array.isArray(removedFolders) || !removedFolders.length) return '';
  const deviceFolders = removedFolders.filter((folder) => folder.includes('/')).length;
  const vendorFolders = removedFolders.length - deviceFolders;
  return `Cleanup removed ${deviceFolders} assetless device folder${deviceFolders === 1 ? '' : 's'} and ${vendorFolders} empty vendor folder${vendorFolders === 1 ? '' : 's'}.`;
}

async function runAdvancedLibraryValidation(root) {
  const devices = state.devices.filter((device) => device.loadable && device.validation?.status !== 'error');
  for (const device of devices) {
    if (state.root !== root) return;
    try {
      const loaded = await window.deviceStudio.loadDevice(root, device.id);
      const conflicts = await analyzeSvgOverlaps(loaded.svg, loaded.manifest.ports || []);
      device.validation.errors = device.validation.errors.filter((message) => !message.startsWith('ADV2:'));
      device.validation.errors.push(...conflicts.map(formatOverlapConflict));
      device.validation.status = device.validation.errors.length ? 'error' : device.validation.warnings.length ? 'warning' : 'valid';
    } catch { /* The standard validation already reports unreadable assets. */ }
  }
  if (state.root === root) renderTree();
}

function renderTree() {
  elements.count.textContent = state.devices.length;
  const invalidCount = state.devices.filter((device) => device.validation?.status === 'error').length;
  elements.count.title = invalidCount ? `${invalidCount} invalid device${invalidCount === 1 ? '' : 's'}` : 'All devices passed';
  elements.tree.classList.toggle('empty', !state.devices.length);
  elements.collapseTree.disabled = !state.devices.length;
  if (!state.devices.length) { elements.tree.innerHTML = '<p>No devices in this library yet.</p>'; return; }
  const groups = new Map();
  state.devices.forEach((device) => {
    if (!groups.has(device.vendor)) groups.set(device.vendor, new Map());
    const types = groups.get(device.vendor);
    if (!types.has(device.type)) types.set(device.type, []);
    types.get(device.type).push(device);
  });
  elements.tree.replaceChildren(...[...groups.entries()].map(([vendor, types]) => treeGroup(vendor, types)));
}

function treeGroup(vendor, types) {
  const wrap = el('div', 'tree-vendor');
  const total = [...types.values()].reduce((sum, devices) => sum + devices.length, 0);
  const children = el('div', 'tree-children'); const button = toggleButton(vendor, total, `vendor:${vendor}`, children);
  [...types.entries()].sort(([a], [b]) => a.localeCompare(b, 'de')).forEach(([type, devices]) => {
    const typeWrap = el('div', 'tree-type'); const typeChildren = el('div', 'tree-children'); const typeButton = toggleButton(TYPE_LABELS[type] || type, devices.length, `type:${vendor}\0${type}`, typeChildren);
    devices.forEach((device) => {
      const entry = el('div', 'tree-device-entry');
      const status = device.validation?.status || 'valid';
      const item = el('button', `tree-device ${status}${device.id === state.currentId ? ' active' : ''}`); item.type = 'button';
      item.innerHTML = `<span class="status-dot" aria-hidden="true"></span><span class="tree-device-name">${escapeHtml(device.model)}</span>${status !== 'valid' ? `<span class="diagnostic-count">${device.validation.errors.length + device.validation.warnings.length}</span>` : ''}`;
      item.title = status === 'valid' ? 'Validation passed' : status === 'warning' ? 'Passed with warnings' : 'Validation failed';
      if (device.loadable) item.addEventListener('click', () => loadDevice(device.id));
      else { item.disabled = true; item.title += ' – files cannot be opened in the editor'; }
      entry.append(item);
      const messages = [...(device.validation?.errors || []).map((text) => ({ level: 'error', text })), ...(device.validation?.warnings || []).map((text) => ({ level: 'warning', text }))];
      if (messages.length) {
        const diagnostics = document.createElement('details'); diagnostics.className = 'tree-diagnostics'; diagnostics.open = true;
        const summary = document.createElement('summary'); summary.textContent = `${device.validation.errors.length} error${device.validation.errors.length === 1 ? '' : 's'} · ${device.validation.warnings.length} warning${device.validation.warnings.length === 1 ? '' : 's'}`; diagnostics.append(summary);
        const list = document.createElement('ul');
        messages.forEach((message) => { const row = document.createElement('li'); row.className = message.level; row.textContent = message.text; list.append(row); });
        diagnostics.append(list); entry.append(diagnostics);
      }
      typeChildren.append(entry);
    });
    typeWrap.append(typeButton, typeChildren); children.append(typeWrap);
  });
  wrap.append(button, children); return wrap;
}

function toggleButton(label, count, key, children) {
  const button = el('button', 'tree-toggle'); button.type = 'button'; button.innerHTML = `<span class="chevron">▾</span><span>${escapeHtml(label)}</span><small>${count}</small>`;
  const initiallyCollapsed = state.collapsedTree.has(key);
  button.classList.toggle('collapsed', initiallyCollapsed); children.classList.toggle('hidden', initiallyCollapsed);
  button.addEventListener('click', () => {
    const collapsed = !state.collapsedTree.has(key);
    if (collapsed) state.collapsedTree.add(key); else state.collapsedTree.delete(key);
    button.classList.toggle('collapsed', collapsed); children.classList.toggle('hidden', collapsed);
  });
  return button;
}

function collapseTree() {
  state.devices.forEach((device) => {
    state.collapsedTree.add(`vendor:${device.vendor}`);
    state.collapsedTree.add(`type:${device.vendor}\0${device.type}`);
  });
  renderTree();
}

async function loadDevice(id) {
  if (id === state.currentId || !canLeave()) return;
  try {
    const result = await window.deviceStudio.loadDevice(state.root, id);
    state.currentId = id; state.manifest = prepareManifest(result.manifest, result.svg); state.svg = result.svg; state.dirty = false; state.activePort = state.manifest.ports.length ? 0 : null;
    elements.deleteDevice.disabled = false; showEditor(); renderTree();
  } catch (error) { notify(error.message, true); }
}

function prepareManifest(manifest, svg) {
  let viewBox = Array.isArray(manifest.viewBox) && manifest.viewBox.length === 4 ? manifest.viewBox : [0, 0, 1, 1];
  try { viewBox = parseSvgViewBox(svg); } catch { /* The diagnostic remains visible in the tree. */ }
  return {
    formatVersion: 1,
    vendor: String(manifest.vendor || ''),
    model: String(manifest.model || ''),
    type: manifest.type == null ? '' : String(manifest.type),
    viewBox,
    ports: Array.isArray(manifest.ports) ? manifest.ports.filter((port) => port && typeof port === 'object' && !Array.isArray(port)).map((port) => ({
      label: String(port.label ?? ''), kind: KINDS.includes(port.kind) ? port.kind : 'other', element: String(port.element ?? '')
    })) : []
  };
}

function parseSvgViewBox(svg) {
  const documentNode = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const values = documentNode.documentElement.getAttribute('viewBox').trim().split(/[\s,]+/).map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) throw new Error('Invalid viewBox');
  return values;
}

async function createDevice() {
  if (!canLeave()) return;
  try {
    const chosen = await chooseSvgFile(); if (!chosen) return;
    state.currentId = null; state.svg = chosen.svg; state.manifest = { formatVersion: 1, vendor: '', model: '', type: 'switch', viewBox: chosen.viewBox, ports: [] };
    state.dirty = true; state.activePort = null; elements.deleteDevice.disabled = true; showEditor(); renderTree(); $('[name="vendor"]').focus();
    reportSvgCleanup(chosen);
  } catch (error) { notify(error.message, true); }
}

async function replaceSvg() {
  try {
    const chosen = await chooseSvgFile(); if (!chosen) return;
    state.svg = chosen.svg;
    state.manifest.viewBox = chosen.viewBox;
    elements.viewBox.textContent = chosen.viewBox.join('  ');
    renderSvg(); markDirty(); reportSvgCleanup(chosen);
  } catch (error) { notify(error.message, true); }
}

async function chooseSvgFile() {
  const result = await window.deviceStudio.chooseSvg();
  if (!result.ok) throw new Error(result.error || 'The SVG could not be imported.');
  return result.data;
}

function reportSvgCleanup(chosen) {
  const cleanupCount = chosen.cleanup ? chosen.cleanup.removedElements + chosen.cleanup.removedAttributes + chosen.cleanup.removedMetadataNodes : 0;
  if (cleanupCount) notify(`SVG cleaned: ${chosen.cleanup.removedElements} elements, ${chosen.cleanup.removedAttributes} attributes, and ${chosen.cleanup.removedMetadataNodes} metadata nodes removed.`);
}

function showEditor() {
  elements.emptyCanvas.classList.add('hidden'); elements.content.classList.remove('hidden'); elements.editorEmpty.classList.add('hidden'); elements.form.classList.remove('hidden');
  elements.replaceSvg.classList.remove('hidden');
  elements.save.disabled = false; elements.title.textContent = state.manifest.model || 'New device';
  elements.form.vendor.value = state.manifest.vendor || ''; elements.form.model.value = state.manifest.model || ''; elements.form.type.value = normalizeType(state.manifest.type);
  state.manifest.type = elements.form.type.value;
  clearFormErrors();
  elements.viewBox.textContent = state.manifest.viewBox.join('  '); updateDirty(); renderSvg(); renderPorts();
}

function clearEditor() {
  elements.emptyCanvas.classList.remove('hidden'); elements.content.classList.add('hidden'); elements.editorEmpty.classList.remove('hidden'); elements.form.classList.add('hidden');
  elements.replaceSvg.classList.add('hidden');
  elements.title.textContent = 'No device selected'; elements.dirty.classList.add('hidden'); elements.deleteDevice.disabled = true; elements.preview.replaceChildren();
}

function renderSvg() {
  let documentNode;
  try { documentNode = new DOMParser().parseFromString(state.svg, 'image/svg+xml'); sanitizeSvg(documentNode); } catch (error) { notify(error.message, true); return; }
  const svg = documentNode.documentElement; svg.removeAttribute('width'); svg.removeAttribute('height'); svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  elements.preview.replaceChildren(document.importNode(svg, true)); collectLayers(); highlightActive();
}

function sanitizeSvg(doc) {
  if (doc.querySelector('parsererror')) throw new Error('The SVG is not valid XML.');
  [...doc.querySelectorAll('*')].forEach((node) => {
    const tag = node.localName.toLowerCase();
    if (!ALLOWED.has(tag)) { node.remove(); return; }
    if (tag === 'style' && /@import|url\(\s*['"]?(?:https?:|data:|\/\/)/i.test(node.textContent)) { node.remove(); return; }
    [...node.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase(); const value = attribute.value.trim();
      if (name.startsWith('on') || ((name === 'href' || name.endsWith(':href')) && value && !value.startsWith('#'))) node.removeAttribute(attribute.name);
      if (name === 'style' && /@import|url\(\s*['"]?(?:https?:|data:|\/\/)/i.test(value)) node.removeAttribute(attribute.name);
    });
  });
}

function collectLayers() {
  const svg = elements.preview.querySelector('svg');
  state.layers = [...svg.querySelectorAll('*')].filter((node) => SELECTABLE.has(node.localName.toLowerCase()) && !isSvgLayer(node)).map((node, index) => ({ node, index, tag: node.localName.toLowerCase(), id: node.id || '' }));
  state.activeLayer = -1; elements.layerCount.textContent = state.layers.length; renderLayers();
}

function isSvgLayer(node) {
  if (node.localName.toLowerCase() !== 'g') return false;
  const groupMode = node.getAttribute('inkscape:groupmode') || node.getAttributeNS('http://www.inkscape.org/namespaces/inkscape', 'groupmode');
  return groupMode === 'layer' || /^layer(?:[-_.]?\d+)?$/i.test(node.id || '');
}

function renderLayers() {
  const query = elements.layerFilter.value.trim().toLowerCase(); const assigned = new Set(state.manifest?.ports.map((port) => port.element) || []);
  const shown = state.layers.filter((layer) => !query || layer.id.toLowerCase().includes(query) || layer.tag.includes(query));
  elements.layerList.replaceChildren(...shown.map((layer) => {
    const row = el('div', `layer-row${layer.index === state.activeLayer ? ' active' : ''}`); row.dataset.index = layer.index; row.tabIndex = -1;
    row.innerHTML = `<span class="layer-tag">&lt;${layer.tag}&gt;</span><span class="layer-id">${escapeHtml(layer.id || '(no ID)')}</span><span class="assigned-dot">${assigned.has(layer.id) ? '●' : ''}</span>`;
    row.addEventListener('click', () => selectLayer(layer.index, false, true)); row.addEventListener('dblclick', () => assignLayer(layer.index)); return row;
  }));
}

function onSvgClick(event) {
  const target = event.target.closest([...SELECTABLE].join(',')); if (!target || target === elements.preview.querySelector('svg')) return;
  if (isSvgLayer(target)) return;
  const layer = state.layers.find((entry) => entry.node === target); if (layer) selectLayer(layer.index, true, true);
}

function selectLayer(index, assign, focusList = false) {
  state.activeLayer = index; renderLayers(); highlightNode(state.layers[index]?.node);
  elements.layerList.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  if (focusList) elements.layerList.focus({ preventScroll: true });
  if (assign) assignLayer(index);
}

async function assignLayer(index) {
  if (state.activePort === null) { notify('Select a port first.', true); return; }
  const layer = state.layers[index]; if (!layer) return;
  const assignedPortIndex = state.activePort;
  const previousElement = state.manifest.ports[assignedPortIndex].element;
  let generatedId = false;
  if (!layer.node.id) {
    const base = `port-${slug(state.manifest.ports[state.activePort].label || state.activePort + 1)}`; let id = base; let suffix = 2;
    while (elements.preview.querySelector(`[id="${cssEscape(id)}"]`)) id = `${base}-${suffix++}`;
    layer.node.id = id; layer.id = id; generatedId = true; commitPreviewSvg();
  }
  const duplicatePort = state.manifest.ports.findIndex((port, portIndex) => portIndex !== assignedPortIndex && String(port.element || '').trim() === layer.node.id);
  if (duplicatePort >= 0) { notify(`SVG element “${layer.node.id}” is already assigned to port ${duplicatePort + 1}.`, true); return; }
  state.manifest.ports[assignedPortIndex].element = layer.node.id;
  const conflicts = await analyzeSvgOverlaps(state.svg, state.manifest.ports);
  const conflict = conflicts.find((entry) => entry.portIndex === assignedPortIndex || entry.otherPortIndex === assignedPortIndex);
  if (conflict) {
    state.manifest.ports[assignedPortIndex].element = previousElement;
    if (generatedId) { elements.preview.querySelector(`[id="${cssEscape(layer.node.id)}"]`)?.removeAttribute('id'); commitPreviewSvg(); }
    renderPorts(); renderLayers(); highlightActive(); notify(formatOverlapConflict(conflict), true); return;
  }
  markDirty(); renderPorts(); renderLayers(); highlightActive();
}

function commitPreviewSvg() {
  const svg = elements.preview.querySelector('svg'); svg.querySelectorAll('.device-highlight').forEach((node) => node.classList.remove('device-highlight'));
  state.svg = new XMLSerializer().serializeToString(svg); collectLayers();
}

function renderPorts() {
  elements.ports.replaceChildren(...state.manifest.ports.map((port, index) => {
    const card = el('div', `port-card${index === state.activePort ? ' active' : ''}`); card.dataset.index = index;
    const kindOptions = KINDS.map((kind) => `<option value="${kind}"${kind === port.kind ? ' selected' : ''}>${kind}</option>`).join('');
    card.innerHTML = `<span class="port-number" title="Port ${index + 1}">${index + 1}</span><input class="port-label" aria-label="Port ${index + 1} label" value="${escapeAttribute(port.label)}" placeholder="Label"><select class="port-kind" aria-label="Port ${index + 1} kind">${kindOptions}</select><input class="port-element${port.element ? '' : ' missing'}" aria-label="Port ${index + 1} SVG element ID" value="${escapeAttribute(port.element || '')}" data-previous="${escapeAttribute(port.element || '')}" placeholder="Unassigned"><button type="button" class="remove-port" title="Remove port ${index + 1}">✕</button>`;
    card.addEventListener('click', () => {
      if (state.activePort === index) return;
      state.activePort = index;
      elements.ports.querySelectorAll('.port-card').forEach((item) => item.classList.toggle('active', Number(item.dataset.index) === index));
      highlightActive();
    });
    card.querySelector('.port-label').addEventListener('input', (event) => { port.label = event.target.value; markDirty(); });
    card.querySelector('.port-kind').addEventListener('change', (event) => { port.kind = event.target.value; markDirty(); });
    const elementInput = card.querySelector('.port-element');
    elementInput.addEventListener('input', (event) => { port.element = event.target.value; event.target.classList.toggle('missing', !port.element); markDirty(); renderLayers(); highlightActive(); });
    elementInput.addEventListener('change', async (event) => {
      const value = event.target.value.trim();
      const duplicatePort = state.manifest.ports.findIndex((candidate, candidateIndex) => candidateIndex !== index && String(candidate.element || '').trim() === value && value);
      if (duplicatePort >= 0) {
        port.element = event.target.dataset.previous || '';
        event.target.value = port.element;
        event.target.classList.toggle('missing', !port.element);
        notify(`SVG element “${value}” is already assigned to port ${duplicatePort + 1}.`, true);
        renderLayers(); highlightActive(); return;
      }
      const conflicts = await analyzeSvgOverlaps(state.svg, state.manifest.ports);
      const conflict = conflicts.find((entry) => entry.portIndex === index || entry.otherPortIndex === index);
      if (conflict) {
        port.element = event.target.dataset.previous || '';
        event.target.value = port.element;
        event.target.classList.toggle('missing', !port.element);
        notify(formatOverlapConflict(conflict), true); renderLayers(); highlightActive(); return;
      }
      event.target.dataset.previous = value;
    });
    card.querySelector('.remove-port').addEventListener('click', (event) => { event.stopPropagation(); state.manifest.ports.splice(index, 1); state.activePort = state.manifest.ports.length ? Math.min(index, state.manifest.ports.length - 1) : null; markDirty(); renderPorts(); highlightActive(); });
    return card;
  }));
}

function addPort() {
  const count = Number(elements.portsToAdd.value);
  if (!Number.isInteger(count) || count < 1 || count > 256) { notify('Number to add must be a whole number between 1 and 256.', true); elements.portsToAdd.focus(); return; }
  const start = state.manifest.ports.length;
  for (let offset = 0; offset < count; offset += 1) state.manifest.ports.push({ label: String(start + offset + 1), kind: 'ethernet', element: '' });
  elements.portsToAdd.value = '1';
  markDirty(); renderPorts(); highlightActive();
}

function onFormInput(event) {
  if (!event.target.name) return;
  state.manifest[event.target.name] = event.target.value; event.target.classList.remove('field-invalid'); clearFormErrors(); elements.title.textContent = state.manifest.model || 'New device'; markDirty();
}

function highlightActive() {
  const id = state.activePort === null ? '' : state.manifest.ports[state.activePort]?.element; highlightNode(id ? elements.preview.querySelector(`[id="${cssEscape(id)}"]`) : null);
  if (id) { const layer = state.layers.find((entry) => entry.id === id); if (layer) { state.activeLayer = layer.index; renderLayers(); } }
}

function highlightNode(node) {
  elements.preview.querySelectorAll('.device-highlight').forEach((item) => item.classList.remove('device-highlight')); if (node) node.classList.add('device-highlight');
}

function onLayerKey(event) {
  if (!['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) return; event.preventDefault();
  const visible = [...elements.layerList.querySelectorAll('.layer-row')].map((row) => Number(row.dataset.index)); if (!visible.length) return;
  let position = visible.indexOf(state.activeLayer);
  if (event.key === 'Enter') { if (position >= 0) assignLayer(visible[position]); return; }
  position = event.key === 'ArrowDown' ? Math.min(position + 1, visible.length - 1) : Math.max(position < 0 ? 0 : position - 1, 0); selectLayer(visible[position], false, true);
}

async function saveDevice() {
  syncForm();
  const validationErrors = await validateEditor();
  if (validationErrors.length) { showFormErrors(validationErrors); notify('Review the highlighted fields.', true); return false; }
  try {
    const result = await window.deviceStudio.saveDevice({ root: state.root, originalId: state.currentId, manifest: state.manifest, svg: state.svg });
    if (!result.ok) { showFormErrors(String(result.error || 'Save failed.').split('\n')); notify(result.error || 'Save failed.', true); return false; }
    const saved = result.data;
    state.currentId = saved.id; state.manifest = saved.manifest; state.devices = saved.devices; state.dirty = false; clearFormErrors(); updateDirty(); renderTree(); renderPorts(); runAdvancedLibraryValidation(state.root);
    state.metadata = saved.metadata; updateLibraryHeader(); elements.deleteDevice.disabled = false;
    const cleanupMessage = removedFoldersMessage(saved.removedFolders); notify(`Device saved.${cleanupMessage ? `\n${cleanupMessage}` : ''}`); return true;
  } catch (error) { notify(error.message, true); return false; }
}

function syncForm() { state.manifest.vendor = elements.form.vendor.value; state.manifest.model = elements.form.model.value; state.manifest.type = elements.form.type.value; }
async function validateEditor() {
  clearFormErrors();
  const errors = [];
  if (!state.manifest.vendor.trim()) { errors.push('Vendor is required.'); elements.form.vendor.classList.add('field-invalid'); }
  else { const error = window.assetSlug.slugError('Vendor', state.manifest.vendor); if (error) { errors.push(error); elements.form.vendor.classList.add('field-invalid'); } }
  if (!state.manifest.model.trim()) { errors.push('Model name is required.'); elements.form.model.classList.add('field-invalid'); }
  else { const error = window.assetSlug.slugError('Model', state.manifest.model); if (error) { errors.push(error); elements.form.model.classList.add('field-invalid'); } }
  if (!Object.hasOwn(TYPE_LABELS, state.manifest.type)) { errors.push('Select a device type.'); elements.form.type.classList.add('field-invalid'); }
  if (!state.manifest.ports.length) errors.push('At least one port is required.');
  const labels = new Set();
  const elementReferences = new Set();
  state.manifest.ports.forEach((port, index) => {
    const label = String(port.label || '').trim();
    if (!label) errors.push(`Port ${index + 1}: Label is required.`);
    else if (labels.has(label)) errors.push(`Port ${index + 1}: Label “${label}” is duplicated.`);
    else labels.add(label);
    if (!KINDS.includes(port.kind)) errors.push(`Port ${index + 1}: Kind is invalid.`);
    const element = String(port.element || '').trim();
    if (!element) errors.push(`Port ${index + 1}: SVG element is required.`);
    else if (elementReferences.has(element)) errors.push(`Port ${index + 1}: SVG element “${element}” is already assigned to another port.`);
    else elementReferences.add(element);
    if (element && !elements.preview.querySelector(`[id="${cssEscape(element)}"]`)) errors.push(`Port ${index + 1}: SVG element “${port.element}” does not exist.`);
  });
  const overlapConflicts = await analyzeSvgOverlaps(state.svg, state.manifest.ports);
  errors.push(...overlapConflicts.map(formatOverlapConflict));
  return errors;
}

function formatOverlapConflict(conflict) {
  return `ADV2: Port “${conflict.label}” element “${conflict.targetId}” overlaps port “${conflict.otherLabel}” element “${conflict.coveringId}”.`;
}

async function analyzeSvgOverlaps(svgText, ports) {
  if (!Array.isArray(ports) || !ports.some((port) => String(port?.element || '').trim())) return [];
  const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) return [];
  sanitizeSvg(parsed);
  const host = document.createElement('div'); host.className = 'advanced-scan-host';
  const svg = document.importNode(parsed.documentElement, true);
  svg.removeAttribute('width'); svg.removeAttribute('height'); svg.setAttribute('width', '1000'); svg.setAttribute('height', '1000');
  host.append(svg); document.body.append(host);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try { return findOverlapConflicts(svg, ports); }
  finally { host.remove(); }
}

function findOverlapConflicts(svg, ports) {
  const conflicts = [];
  const selected = ports.map((port, portIndex) => {
    const targetId = String(port?.element || '').trim();
    if (!targetId) return null;
    const target = svg.querySelector(`[id="${cssEscape(targetId)}"]`); if (!target) return null;
    const targetBox = transformedBox(target); if (!targetBox) return null;
    return { port, portIndex, targetId, target, targetBox };
  }).filter(Boolean);

  for (let firstIndex = 0; firstIndex < selected.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < selected.length; secondIndex += 1) {
      const first = selected[firstIndex]; const second = selected[secondIndex];
      const intersection = intersectBoxes(first.targetBox, second.targetBox);
      if (intersection && geometriesOverlap(first.target, second.target, intersection)) {
        conflicts.push({ type: 'port-overlap', portIndex: first.portIndex, otherPortIndex: second.portIndex, label: String(first.port.label ?? first.portIndex + 1), targetId: first.targetId, otherLabel: String(second.port.label ?? second.portIndex + 1), coveringId: second.targetId });
      }
    }
  }

  return conflicts;
}

function transformedBox(node) {
  try {
    const box = node.getBBox(); const matrix = node.getCTM();
    if (!matrix || box.width <= 0 || box.height <= 0) return null;
    const points = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix));
    const xs = points.map((point) => point.x); const ys = points.map((point) => point.y);
    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  } catch { return null; }
}

function intersectBoxes(a, b) {
  const result = { left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom) };
  return result.right > result.left && result.bottom > result.top ? result : null;
}

function geometriesOverlap(target, candidate, box) {
  const columns = Math.min(24, Math.max(6, Math.ceil(box.right - box.left)));
  const rows = Math.min(24, Math.max(6, Math.ceil(box.bottom - box.top)));
  for (let yIndex = 0; yIndex < rows; yIndex += 1) {
    for (let xIndex = 0; xIndex < columns; xIndex += 1) {
      const point = new DOMPoint(box.left + (xIndex + .5) * (box.right - box.left) / columns, box.top + (yIndex + .5) * (box.bottom - box.top) / rows);
      if (pointInGraphic(target, point) && pointInGraphic(candidate, point)) return true;
    }
  }
  return false;
}

function pointInGraphic(node, viewportPoint) {
  if (node.localName.toLowerCase() === 'g') return [...node.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon,use')].some((child) => pointInGraphic(child, viewportPoint));
  try {
    const matrix = node.getCTM(); if (!matrix) return false;
    const localPoint = viewportPoint.matrixTransform(matrix.inverse());
    if (typeof node.isPointInFill === 'function' && node.isPointInFill(localPoint)) return true;
    if (typeof node.isPointInStroke === 'function' && node.isPointInStroke(localPoint)) return true;
    const box = node.getBBox(); return localPoint.x >= box.x && localPoint.x <= box.x + box.width && localPoint.y >= box.y && localPoint.y <= box.y + box.height;
  } catch { return false; }
}
function showFormErrors(errors) { elements.formErrors.textContent = errors.join('\n'); elements.formErrors.classList.remove('hidden'); elements.formErrors.scrollIntoView({ block: 'nearest' }); }
function clearFormErrors() { elements.formErrors.textContent = ''; elements.formErrors.classList.add('hidden'); elements.form.querySelectorAll('.field-invalid').forEach((node) => node.classList.remove('field-invalid')); }
function normalizeType(value) { const type = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_'); return ({ accesspoint: 'access_point', patchpanel: 'patch_panel' })[type] || type; }
function markDirty() { state.dirty = true; updateDirty(); }
function updateDirty() { elements.dirty.classList.toggle('hidden', !state.dirty); window.deviceStudio.setDirty(state.dirty); }
function canLeave() { return !state.dirty || confirm('Discard unsaved changes?'); }
function notify(message, error = false) { elements.toast.textContent = message; elements.toast.classList.toggle('error', error); elements.toast.classList.remove('hidden'); clearTimeout(notify.timer); notify.timer = setTimeout(() => elements.toast.classList.add('hidden'), error ? 6500 : 2500); }
function el(tag, className, text) { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; }
function slug(value) { return String(value || '').trim().toLowerCase().replaceAll('+', 'plus').replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'port'; }
function cssEscape(value) { return CSS.escape(String(value)); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function escapeAttribute(value) { return escapeHtml(value); }
