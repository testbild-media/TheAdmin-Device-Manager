(function exposeAssetSlug(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.assetSlug = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const WINDOWS_RESERVED_NAMES = new Set([
    'con', 'prn', 'aux', 'nul',
    'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
    'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
  ]);

  function slugify(value) {
    let text = String(value || '').trim().toLowerCase();
    text = text
      .replace(/[äæ]/g, 'ae')
      .replace(/[öœ]/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ø/g, 'o')
      .replace(/ß/g, 'ss')
      .replace(/ð/g, 'd')
      .replace(/þ/g, 'th');
    text = text.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    text = text.replace(/\+/g, '-plus');
    text = text.replace(/[^a-z0-9_-]/g, '-');
    text = text.replace(/-{2,}/g, '-');
    return text.replace(/^[-_]+|[-_]+$/g, '');
  }

  function isValidAssetSlug(value) {
    const slug = String(value || '');
    return /^[a-z0-9_-]+$/.test(slug)
      && !/^[-_]|[-_]$/.test(slug)
      && !slug.includes('--')
      && !WINDOWS_RESERVED_NAMES.has(slug);
  }

  function slugError(field, value) {
    const slug = slugify(value);
    if (!slug) return `${field} cannot be mapped to a folder name because the result is empty.`;
    if (WINDOWS_RESERVED_NAMES.has(slug)) return `${field} maps to Windows-reserved folder name “${slug}”.`;
    return isValidAssetSlug(slug) ? null : `${field} cannot be mapped to a valid device-assets folder name.`;
  }

  return { WINDOWS_RESERVED_NAMES, slugify, isValidAssetSlug, slugError };
});
