// Survey catalog: an optional catalog.json next to index.html lists the models and overlays that sit in the same
// deposit (links relative to the viewer page). When the viewer is hosted inside the deposit (e.g. on ERDA), the
// "Add survey" menu offers them, so a user can add a survey without typing its address.
// Pure functions only, so they can be tested in Node.

/**
 * Check and normalize a parsed catalog.json.
 * Format: { "surveys": [{ "name": "...", "url": "..." }], "overlays": [{ "name": "...", "url": "...", "autoload": true? }] }
 * An overlay with "autoload": true is shown as soon as the viewer opens next to the deposit.
 * Entries without a name or url are dropped. Returns { surveys, overlays } (possibly empty arrays).
 */
export function parseCatalog(obj) {
  const clean = (list, kind) => (Array.isArray(list) ? list : [])
    .filter((e) => e && typeof e.name === 'string' && e.name.trim() && typeof e.url === 'string' && e.url.trim())
    .map((e) => ({ kind, name: e.name.trim(), url: e.url.trim(), autoload: e.autoload === true }));
  if (!obj || typeof obj !== 'object') return { surveys: [], overlays: [] };
  return { surveys: clean(obj.surveys, 'survey'), overlays: clean(obj.overlays, 'overlay') };
}

/** Absolute form of a catalog link, resolved against the viewer page. */
export function resolveLink(url, base) {
  return new URL(url, base).href;
}

/**
 * Catalog surveys that are not loaded yet. `loadedUrls` are the links of the open models (absolute or relative);
 * all are compared in absolute form.
 */
export function notLoaded(surveys, loadedUrls, base) {
  const have = new Set(loadedUrls.filter(Boolean).map((u) => resolveLink(u, base)));
  return surveys.filter((s) => !have.has(resolveLink(s.url, base)));
}
