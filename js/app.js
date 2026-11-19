// Isua 3D Viewer: CesiumJS front end. No build step; ES modules loaded directly by the browser.

import { BlobSource, HttpRangeSource } from './sources.js';
import { ThreeTzArchive, FolderProvider } from './archive.js';
import { ZipError } from './zip.js';
import { initServiceWorker, registerSource, unregisterSource, virtualUrl } from './swbridge.js';
import { ecefToGeodetic, ecefToEnu, enuToEcef, toUtm, planeSquare } from './geomath.js';
import { evaluate, summary, toCsv, toGeoJson, centroidOf } from './measurements.js';
import { parseHash, buildHash } from './urlstate.js';
import { diagnoseUrl, hostRequestText, formatBytes } from './diagnostics.js';
import { setupNavigation } from './navigation.js';

const $ = (sel) => document.querySelector(sel);
const STORAGE_KEY = 'isua-viewer-measurements-v1';
const ISUA = { lon: -50.0, lat: 65.17 };

// ------------------------------------------------------------------ messages
function notify(text, level = 'info', { timeout = level === 'error' ? 0 : 8000 } = {}) {
  const box = $('#messages');
  const div = document.createElement('div');
  div.className = `msg ${level}`;
  div.textContent = text;
  const close = document.createElement('button');
  close.textContent = '×';
  close.title = 'Dismiss';
  close.onclick = () => div.remove();
  div.append(close);
  box.prepend(div);
  while (box.children.length > 6) box.lastChild.remove();
  if (timeout) setTimeout(() => div.remove(), timeout);
  (level === 'error' ? console.error : console.log)(`[viewer] ${text}`);
  return div;
}

if (!window.Cesium) {
  notify('CesiumJS could not be loaded from cdn.jsdelivr.net. Check the internet connection (or whether a firewall blocks jsdelivr), then reload. '
    + 'To use the viewer without internet, run once: python -m isuaphoto viewer-offline', 'error');
  throw new Error('Cesium missing');
}
const Cesium = window.Cesium;

// ------------------------------------------------------------------ viewer
let viewer;
try {
  viewer = new Cesium.Viewer('cesium', {
    baseLayer: false, // no Cesium ion imagery
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    baseLayerPicker: false,
    geocoder: false, // the default geocoder needs an ion token
    timeline: false,
    animation: false,
    sceneModePicker: false,
    homeButton: true,
    navigationHelpButton: false, // replaced by the Navigation section (it matches the chosen mouse layout)
    fullscreenButton: true,
    infoBox: true,
    selectionIndicator: true,
    contextOptions: { webgl: { preserveDrawingBuffer: true } }, // screenshots
  });
} catch (e) {
  notify(`3D graphics (WebGL) could not start: ${e.message}. Try another browser or enable hardware acceleration.`, 'error');
  throw e;
}
const scene = viewer.scene;
scene.globe.baseColor = Cesium.Color.fromCssColorString('#3d4a55');
viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
const osmLayer = viewer.imageryLayers.addImageryProvider(new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }));
viewer.homeButton.viewModel.command.beforeExecute.addEventListener((e) => { e.cancel = true; flyHome(); });

function flyHome() {
  const visible = state.tilesets.filter((t) => t.tileset.show);
  if (visible.length) {
    viewer.camera.flyToBoundingSphere(Cesium.BoundingSphere.fromBoundingSpheres(visible.map((t) => t.tileset.boundingSphere)), { duration: 1.2 });
  } else viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(ISUA.lon, ISUA.lat, 25000), duration: 1.2 });
}

const state = {
  tilesets: [], // {id, name, kind, tileset, shareUrl, offset, baseCenter, sourceId, source, tilesLoaded, failed}
  overlays: [], // {id, name, ds}
  measurements: [],
  tool: 'inspect',
  pending: [], // picked ECEF points for the active tool
  lastPick: null,
  sw: { ok: false, reason: 'starting' },
};
let seq = 0;
const nextId = () => ++seq;

// Exposed for the end-to-end test and for power users in the browser console.
window.isua = { viewer, state, Cesium, openUrl: (u, o) => openUrl(u, o), addMeasurementPoints: (t, pts) => commitMeasurement(t, pts) };

// ------------------------------------------------------------------ performance
// Detail = Cesium's maximumScreenSpaceError (pixels of geometric error allowed on screen): 8 high, 16 normal
// (Cesium's default), 32 fast. While the camera moves, the error may be doubled ("coarser while moving"), so fewer
// and lighter tiles are drawn during motion; full detail is restored when the camera stops.
const perf = { sse: 16, coarserWhileMoving: true, moving: false };
try {
  const saved = JSON.parse(localStorage.getItem('isua-perf') || '{}');
  if ([8, 16, 32].includes(saved.sse)) perf.sse = saved.sse;
  if (typeof saved.coarserWhileMoving === 'boolean') perf.coarserWhileMoving = saved.coarserWhileMoving;
} catch (e) { /* storage unavailable: defaults */ }
function currentSse() { return perf.moving && perf.coarserWhileMoving ? perf.sse * 2 : perf.sse; }
function applySse() {
  const v = currentSse();
  for (const t of state.tilesets) t.tileset.maximumScreenSpaceError = v;
  scene.requestRender();
}
function savePerf() {
  try { localStorage.setItem('isua-perf', JSON.stringify({ sse: perf.sse, coarserWhileMoving: perf.coarserWhileMoving })); } catch (e) { /* ignore */ }
}
viewer.camera.moveStart.addEventListener(() => { perf.moving = true; if (perf.coarserWhileMoving) applySse(); });
viewer.camera.moveEnd.addEventListener(() => { perf.moving = false; applySse(); });
window.isua.perf = perf;

// ------------------------------------------------------------------ tilesets
async function addTileset({ name, url, kind, shareUrl = null, offset = 0, sourceId = null, source = null, fly = true, detail = '' }) {
  let tileset;
  try {
    // enableCollision: the camera cannot pass through the model (mouse navigation).
    tileset = await Cesium.Cesium3DTileset.fromUrl(url, { maximumScreenSpaceError: currentSse(), enableCollision: true });
  } catch (e) {
    if (sourceId) unregisterSource(sourceId);
    throw new Error(`Could not load the tileset of "${name}": ${e.message || e}`);
  }
  scene.primitives.add(tileset);
  const entry = {
    id: nextId(), name, kind, url, shareUrl, offset: 0, tileset, sourceId, source, detail,
    tilesLoaded: 0, failed: 0, baseCenter: Cesium.Cartesian3.clone(tileset.boundingSphere.center),
  };
  tileset.tileLoad.addEventListener(() => { entry.tilesLoaded++; scheduleLayerStats(); });
  tileset.tileFailed.addEventListener((err) => {
    entry.failed++;
    if (entry.failed <= 3) notify(`${name}: a tile failed to load (${err.url?.split('/').pop()}): ${err.message}`, 'warn');
  });
  state.tilesets.push(entry);
  setOffset(entry, offset);
  const g = ecefToGeodetic([entry.baseCenter.x, entry.baseCenter.y, entry.baseCenter.z]);
  if (Cesium.Cartesian3.magnitude(entry.baseCenter) < 1e5) {
    notify(`"${name}" is not georeferenced (it sits at the Earth's centre). Check the export settings in Metashape (coordinate system).`, 'warn');
  } else {
    entry.detail = `${detail ? `${detail} · ` : ''}centre ${g.lat.toFixed(5)}°, ${g.lon.toFixed(5)}°, h ${g.h.toFixed(1)} m`;
  }
  renderLayers();
  if (fly) await viewer.flyTo(tileset, { duration: 1.5 });
  updateHash();
  scheduleClamp();
  notify(`Loaded "${name}" (${kind}).`, 'ok', { timeout: 4000 });
  return entry;
}

function setOffset(entry, value) {
  const v = Number(value) || 0;
  const n = Cesium.Cartesian3.magnitude(entry.baseCenter) > 1e5
    ? Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(entry.baseCenter, new Cesium.Cartesian3())
    : Cesium.Cartesian3.UNIT_Z;
  entry.tileset.modelMatrix = Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.multiplyByScalar(n, v, new Cesium.Cartesian3()));
  entry.offset = v;
  scheduleClamp();
}

function removeTileset(entry) {
  scene.primitives.remove(entry.tileset);
  if (entry.sourceId) unregisterSource(entry.sourceId);
  state.tilesets = state.tilesets.filter((t) => t !== entry);
  renderLayers();
  updateHash();
  scheduleClamp();
}

function requireServiceWorker(what) {
  if (state.sw.ok) return true;
  notify(`${what} is not available here: ${state.sw.reason}`, 'error');
  return false;
}

async function openArchive(source, name, { kind, shareUrl = null, offset = 0, fly = true }) {
  const archive = await ThreeTzArchive.open(source);
  const tilesetPath = await archive.findTilesetPath();
  if (!tilesetPath) throw new Error(`"${name}" contains no tileset.json – is it really a 3D Tiles archive?`);
  archive.warnings.forEach((w) => notify(`${name}: ${w}`, 'warn'));
  archive.onError = (e, p) => notify(`${name}: error reading ${p}: ${e.message}`, 'error');
  const sourceId = registerSource(archive);
  const lookup = archive.mode === 'index' ? `indexed (${archive.entryCount} entries)` : `central directory (${archive.entryCount} entries)`;
  return addTileset({
    name, kind, shareUrl, offset, fly, sourceId, source,
    url: virtualUrl(sourceId, tilesetPath),
    detail: `${formatBytes(source.size)}, ${lookup}${archive.eocd.zip64 ? ', ZIP64' : ''}`,
  });
}

async function openLocal3tz(file) {
  if (!requireServiceWorker('Opening local .3tz files')) return null;
  try {
    return await openArchive(new BlobSource(file), file.name, { kind: 'local .3tz' });
  } catch (e) {
    notify(`${file.name}: ${e.message}`, 'error');
    return null;
  }
}

async function openFolder(provider) {
  if (!requireServiceWorker('Opening tileset folders')) return null;
  const sourceId = registerSource(provider);
  provider.onError = (e, p) => notify(`${provider.name}: error reading ${p}: ${e.message}`, 'error');
  try {
    return await addTileset({ name: provider.name, kind: 'local folder', sourceId, url: virtualUrl(sourceId, provider.tilesetPath), detail: provider.tilesetPath });
  } catch (e) {
    notify(e.message, 'error');
    return null;
  }
}

async function openUrl(raw, { offset = 0, fly = true } = {}) {
  const url = new URL(raw, location.href).href;
  const display = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).slice(-2).join('/')) || url;
  const looksJson = /\.json$/i.test(new URL(url).pathname);
  try {
    if (!looksJson) {
      if (!state.sw.ok) throw new Error(`Streaming a remote .3tz needs the Service Worker: ${state.sw.reason}`);
      let source;
      try {
        source = await HttpRangeSource.open(url);
      } catch (e) {
        if (e instanceof TypeError) throw new Error('The server could not be read from this page (network error or missing CORS headers).');
        throw e;
      }
      try {
        return await openArchive(source, display, { kind: 'remote .3tz (HTTP Range)', shareUrl: raw, offset, fly });
      } catch (e) {
        if (!(e instanceof ZipError)) throw e;
        // Not a ZIP: maybe a tileset JSON served without a .json extension.
      }
    }
    return await addTileset({ name: display, kind: 'remote tileset.json', url, shareUrl: raw, offset, fly });
  } catch (e) {
    notify(`Could not load ${raw}: ${e.message}\nUse "Remote link diagnostics" below to see what the server allows.`, 'error');
    $('#in-diag').value = raw;
    $('#sec-diag').open = true;
    return null;
  }
}

// ------------------------------------------------------------------ GeoJSON overlays
const LABEL_KEYS = ['name', 'Name', 'sample_id', 'sample', 'Sample', 'id', 'ID', 'label', 'Label'];

async function addGeoJson(obj, name) {
  const ds = await Cesium.GeoJsonDataSource.load(obj, { markerColor: Cesium.Color.YELLOW, stroke: Cesium.Color.YELLOW, fill: Cesium.Color.YELLOW.withAlpha(0.25) });
  const clamp = $('#chk-clamp').checked;
  const toClamp = [];
  for (const e of ds.entities.values) {
    if (!e.billboard) continue;
    const pos = e.position.getValue(Cesium.JulianDate.now());
    const carto = Cesium.Cartographic.fromCartesian(pos);
    const is2d = Math.abs(carto.height) < 1e-6;
    const props = e.properties?.getValue(Cesium.JulianDate.now()) || {};
    const key = LABEL_KEYS.find((k) => props[k] !== undefined && props[k] !== null);
    e.billboard = undefined;
    if (clamp && is2d) toClamp.push({ entity: e, lon: carto.longitude, lat: carto.latitude });
    // A feature's own "marker-color" (simplestyle, e.g. colour by lithology) wins over the default yellow.
    let color = Cesium.Color.YELLOW;
    try { if (props['marker-color']) color = Cesium.Color.fromCssColorString(String(props['marker-color'])) || color; } catch (err) { /* keep yellow */ }
    e.point = new Cesium.PointGraphics({
      pixelSize: 10, color, outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    if (key) {
      e.label = new Cesium.LabelGraphics({
        text: String(props[key]), font: '13px sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -16),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        // names only within 500 m of the camera, so hundreds of points do not bury the model in text
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 500),
      });
    }
  }
  await viewer.dataSources.add(ds);
  const overlay = { id: nextId(), name, ds, toClamp, clamped: 0 };
  state.overlays.push(overlay);
  renderLayers();
  await clampOverlay(overlay);
  if (!state.tilesets.length) viewer.flyTo(ds, { duration: 1.2 });
  notify(`Overlay "${name}": ${ds.entities.values.length} features. Click a point to see its properties.`, 'ok', { timeout: 5000 });
  return overlay;
}

/**
 * Put 2D GeoJSON points on the model surface. Uses scene.sampleHeightMostDetailed (render-based,
 * loads the finest tiles at each point) rather than Cesium's HeightReference clamping, which only
 * works for tilesets created with enableCollision and only updates when tiles change.
 */
async function clampOverlay(o) {
  if (!o.toClamp.length || !scene.sampleHeightSupported) return;
  const exclude = [...o.ds.entities.values, ...measurementEntities.entities.values, ...pendingEntities.entities.values];
  const cartos = o.toClamp.map(({ lon, lat }) => new Cesium.Cartographic(lon, lat, 0));
  let res;
  try { res = await scene.sampleHeightMostDetailed(cartos, exclude); } catch (e) { console.warn('height sampling failed', e); return; }
  let n = 0;
  res.forEach((c, i) => {
    const h = Number.isFinite(c?.height) && state.tilesets.length ? c.height : 0;
    if (h !== 0) n++;
    o.toClamp[i].entity.position = Cesium.Cartesian3.fromRadians(o.toClamp[i].lon, o.toClamp[i].lat, h);
  });
  o.clamped = n;
  renderLayers();
}

let clampTimer = null;
function scheduleClamp() {
  clearTimeout(clampTimer);
  clampTimer = setTimeout(() => state.overlays.forEach((o) => clampOverlay(o)), 800);
}

async function openGeoJsonFile(file) {
  try {
    await addGeoJson(JSON.parse(await file.text()), file.name);
  } catch (e) {
    notify(`${file.name}: not valid GeoJSON (${e.message})`, 'error');
  }
}

// ------------------------------------------------------------------ layer list UI
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...children.filter((c) => c !== null && c !== undefined));
  return n;
}

const fmtOffset = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)} m`;

function renderLayers() {
  const ul = $('#layer-list');
  ul.replaceChildren();
  if (!state.tilesets.length && !state.overlays.length) {
    ul.append(el('li', { class: 'empty' }, 'Nothing loaded yet.'));
    return;
  }
  for (const t of state.tilesets) {
    const out = el('output', {}, fmtOffset(t.offset));
    const range = el('input', { type: 'range', min: -150, max: 150, step: 0.1, value: Math.max(-150, Math.min(150, t.offset)), 'aria-label': `Vertical offset for ${t.name}` });
    const num = el('input', { type: 'number', step: 0.01, value: t.offset, 'aria-label': `Vertical offset (m) for ${t.name}` });
    const apply = (v) => { setOffset(t, v); out.textContent = fmtOffset(t.offset); updateHash(); };
    range.addEventListener('input', () => { num.value = range.value; apply(range.value); });
    num.addEventListener('change', () => { range.value = num.value; apply(num.value); });
    const vis = el('input', { type: 'checkbox', title: 'Show / hide', checked: t.tileset.show, onchange: (e) => { t.tileset.show = e.target.checked; if (!t.tileset.show) t.tileset.trimLoadedTiles(); scene.requestRender(); } });
    ul.append(el('li', { class: 'layer', 'data-layer': t.id },
      el('div', { class: 'title' }, vis, el('span', { class: 'name' }, t.name),
        el('button', { type: 'button', title: 'Fly to', onclick: () => viewer.flyTo(t.tileset, { duration: 1.2 }) }, 'Fly to'),
        el('button', { type: 'button', title: 'Remove', class: 'danger', onclick: () => removeTileset(t) }, '×')),
      el('div', { class: 'meta' }, `${t.kind}${t.detail ? ` · ${t.detail}` : ''}`),
      el('div', { class: 'meta stats' }, layerStats(t)),
      el('div', { class: 'offset' }, el('span', {}, 'Vertical offset'), range, num, out)));
  }
  for (const o of state.overlays) {
    const vis = el('input', { type: 'checkbox', checked: o.ds.show, onchange: (e) => { o.ds.show = e.target.checked; } });
    ul.append(el('li', { class: 'layer' },
      el('div', { class: 'title' }, vis, el('span', { class: 'name' }, o.name),
        el('button', { type: 'button', onclick: () => viewer.flyTo(o.ds, { duration: 1.2 }) }, 'Fly to'),
        el('button', { type: 'button', class: 'danger', onclick: () => { viewer.dataSources.remove(o.ds, true); state.overlays = state.overlays.filter((x) => x !== o); renderLayers(); } }, '×')),
      el('div', { class: 'meta' }, `GeoJSON overlay · ${o.ds.entities.values.length} features${o.toClamp.length ? ` · ${o.clamped} of ${o.toClamp.length} 2D points placed on a model` : ''}`)));
  }
}

function layerStats(t) {
  let s = `tiles loaded: ${t.tilesLoaded}${t.failed ? `, failed: ${t.failed}` : ''}`;
  if (t.source?.bytesRead !== undefined && t.kind.startsWith('remote')) s += ` · streamed ${formatBytes(t.source.bytesRead)} of ${formatBytes(t.source.size)} (${t.source.requests} requests)`;
  return s;
}

let statsTimer = null;
function scheduleLayerStats() {
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    for (const t of state.tilesets) {
      const node = document.querySelector(`[data-layer="${t.id}"] .stats`);
      if (node) node.textContent = layerStats(t);
    }
  }, 500);
}

// ------------------------------------------------------------------ picking & readout
function tilesetEntryFor(picked) {
  if (!picked) return null;
  const prim = picked.tileset || picked.primitive || picked.content?.tileset;
  return state.tilesets.find((t) => t.tileset === prim) || null;
}

function pickAt(position) {
  const picked = scene.pick(position);
  const entry = tilesetEntryFor(picked);
  let cart = entry && scene.pickPositionSupported ? scene.pickPosition(position) : undefined;
  let onModel = !!cart;
  if (!cart) { cart = viewer.camera.pickEllipsoid(position); onModel = false; }
  if (!cart) return null;
  return { ecef: [cart.x, cart.y, cart.z], entry, onModel, picked };
}

function showReadout(p) {
  const g = ecefToGeodetic(p.ecef);
  const u = toUtm(g.lat, g.lon);
  const off = p.entry?.offset || 0;
  const rows = [
    ['Surface', p.onModel ? `model: ${p.entry.name}` : 'ellipsoid (no model here)'],
    ['Latitude', `${g.lat.toFixed(7)}°`],
    ['Longitude', `${g.lon.toFixed(7)}°`],
    ['Height (ellipsoidal)', `${g.h.toFixed(3)} m`],
    ...(off ? [['Height without offset', `${(g.h - off).toFixed(3)} m (offset ${fmtOffset(off)})`]] : []),
    ['UTM 22N easting', `${u.easting.toFixed(3)} m`],
    ['UTM 22N northing', `${u.northing.toFixed(3)} m`],
  ];
  $('#readout').replaceChildren(...rows.map(([k, v]) => el('tr', {}, el('td', {}, k), el('td', {}, v))));
  state.lastPick = p;
  $('#btn-save-point').disabled = false;
}

// Temporary entities for the active tool
const pendingEntities = new Cesium.CustomDataSource('pending');
const measurementEntities = new Cesium.CustomDataSource('measurements');
viewer.dataSources.add(pendingEntities);
viewer.dataSources.add(measurementEntities);
const toCart = (p) => new Cesium.Cartesian3(p[0], p[1], p[2]);
const COLORS = { point: Cesium.Color.CYAN, distance: Cesium.Color.ORANGE, plane: Cesium.Color.fromCssColorString('#ff3fa4') };

function markerEntity(ds, p, color, text) {
  return ds.entities.add({
    position: toCart(p),
    point: { pixelSize: 9, color, outlineColor: Cesium.Color.BLACK, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    label: text ? {
      text, font: '13px sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -18), disableDepthTestDistance: Number.POSITIVE_INFINITY,
      showBackground: false,
    } : undefined,
  });
}

function drawPlane(ds, points, fit, color, text) {
  const c = centroidOf(points);
  const enu = ecefToEnu(points, c);
  const r = Math.max(0.5, 1.25 * Math.max(...enu.map((q) => Math.hypot(...q))));
  const corners = planeSquare(fit.normal, r).map((q) => toCart(enuToEcef(q, c)));
  ds.entities.add({ polygon: { hierarchy: corners, perPositionHeight: true, material: color.withAlpha(0.45), outline: true, outlineColor: color } });
  const dd = Cesium.Math.toRadians(fit.dipDirection), dip = Cesium.Math.toRadians(fit.dip);
  if (!fit.isHorizontal) {
    const tip = enuToEcef([Math.sin(dd) * Math.cos(dip) * r, Math.cos(dd) * Math.cos(dip) * r, -Math.sin(dip) * r], c);
    ds.entities.add({ polyline: { positions: [toCart(c), toCart(tip)], width: 10, material: new Cesium.PolylineArrowMaterialProperty(color), depthFailMaterial: new Cesium.PolylineArrowMaterialProperty(color.withAlpha(0.5)) } });
  }
  markerEntity(ds, c, color, text);
}

function drawMeasurement(m) {
  const v = evaluate(m);
  const color = COLORS[m.type];
  const name = m.label ? `${m.id} ${m.label}` : m.id;
  if (m.type === 'point') markerEntity(measurementEntities, m.points[0], color, name);
  else if (m.type === 'distance') {
    m.points.forEach((p) => markerEntity(measurementEntities, p, color));
    measurementEntities.entities.add({ polyline: { positions: m.points.map(toCart), width: 3, material: color, depthFailMaterial: color.withAlpha(0.5) } });
    markerEntity(measurementEntities, centroidOf(m.points), color, `${name}: ${v.distance3d.toFixed(2)} m, Δh ${v.dh.toFixed(2)} m`);
  } else {
    m.points.forEach((p) => markerEntity(measurementEntities, p, color));
    drawPlane(measurementEntities, m.points, v, color, `${name}: ${v.dipDirDip}`);
  }
}

function redrawMeasurements() {
  measurementEntities.entities.removeAll();
  for (const m of state.measurements) {
    try { drawMeasurement(m); } catch (e) { console.warn('cannot draw', m, e); }
  }
}

function redrawPending() {
  pendingEntities.entities.removeAll();
  const color = COLORS[state.tool] || Cesium.Color.WHITE;
  state.pending.forEach((p, i) => markerEntity(pendingEntities, p, color, String(i + 1)));
  if (state.tool === 'plane') {
    const box = $('#plane-live');
    const save = $('#btn-plane-save');
    if (state.pending.length >= 3) {
      const v = evaluate({ type: 'plane', points: state.pending });
      drawPlane(pendingEntities, state.pending, v, color.withAlpha(0.8), v.dipDirDip);
      box.replaceChildren(
        el('div', {}, 'Dip direction / dip: ', el('b', {}, v.dipDirDip)),
        el('div', {}, 'Strike / dip (RHR): ', el('b', {}, v.strikeDip)),
        el('div', { class: 'hint' }, `n = ${v.n} points · rms misfit ${v.rms.toFixed(3)} m${v.isVertical ? ' · vertical: dip direction ambiguous (±180°)' : ''}${v.isHorizontal ? ' · horizontal: dip direction undefined' : ''}`),
        ...(v.poorlyConstrained ? [el('div', { class: 'hint', style: 'color:var(--warn)' }, 'Points are nearly on a line: the plane is poorly constrained. Spread the picks over the surface.')] : []),
      );
      save.disabled = false;
    } else {
      box.textContent = `Pick at least 3 points on the outcrop surface (${state.pending.length} so far).`;
      save.disabled = true;
    }
  }
}

function onClick(position) {
  const p = pickAt(position);
  if (!p) return;
  showReadout(p);
  if (state.tool === 'distance') {
    state.pending.push(p.ecef);
    if (state.pending.length === 2) {
      commitMeasurement('distance', state.pending, p.entry);
      state.pending = [];
    }
    redrawPending();
  } else if (state.tool === 'plane') {
    if (!p.onModel) { notify('Strike/dip: click on a model surface (that click hit the empty globe).', 'warn', { timeout: 4000 }); return; }
    state.pending.push(p.ecef);
    state.pendingTileset = p.entry;
    redrawPending();
  }
}

function commitMeasurement(type, points, entry = null, label = '') {
  const prefix = { point: 'P', distance: 'D', plane: 'S' }[type];
  const n = 1 + Math.max(0, ...state.measurements.filter((m) => m.type === type).map((m) => Number(m.id.slice(1)) || 0));
  const m = {
    id: `${prefix}${n}`, label, type, points: points.map((p) => [...p]),
    tileset: entry?.name ?? '', offset: entry?.offset ?? 0, created: new Date().toISOString(),
  };
  evaluate(m); // throws for degenerate input
  state.measurements.push(m);
  saveMeasurements();
  drawMeasurement(m);
  renderMeasurements();
  return m;
}

// ------------------------------------------------------------------ measurements UI
function renderMeasurements() {
  const tbody = $('#meas-table tbody');
  tbody.replaceChildren();
  $('#meas-count').textContent = String(state.measurements.length);
  if (!state.measurements.length) {
    tbody.append(el('tr', {}, el('td', { class: 'empty' }, 'No measurements yet.')));
    return;
  }
  for (const m of state.measurements) {
    let text;
    try { text = summary(m); } catch (e) { text = `invalid: ${e.message}`; }
    tbody.append(el('tr', {},
      el('td', { class: 'id' }, m.id),
      el('td', {}, m.label ? el('div', {}, el('i', {}, m.label)) : null, text, m.tileset ? el('div', { class: 'hint' }, m.tileset) : null),
      el('td', {}, el('button', { type: 'button', title: 'Fly to', onclick: () => viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(toCart(centroidOf(m.points)), 15), { duration: 1 }) }, '⌖'),
        el('button', { type: 'button', title: 'Delete', class: 'danger', onclick: () => { state.measurements = state.measurements.filter((x) => x !== m); saveMeasurements(); redrawMeasurements(); renderMeasurements(); } }, '×'))));
  }
}

function saveMeasurements() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.measurements)); } catch { /* storage unavailable */ }
}
function loadMeasurements() {
  try {
    const arr = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (Array.isArray(arr)) state.measurements = arr.filter((m) => m && Array.isArray(m.points) && m.points.length);
  } catch { /* ignore */ }
}

function download(blob, filename) {
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

// ------------------------------------------------------------------ URL hash state
let hashTimer = null;
function updateHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const c = viewer.camera.positionCartographic;
    const s = {
      camera: {
        lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude), height: c.height,
        heading: Cesium.Math.toDegrees(viewer.camera.heading), pitch: Cesium.Math.toDegrees(viewer.camera.pitch), roll: Cesium.Math.toDegrees(viewer.camera.roll),
      },
      tilesets: state.tilesets.filter((t) => t.shareUrl).map((t) => ({ url: t.shareUrl, offset: t.offset })),
      osm: osmLayer.show,
      globe: scene.globe.show,
    };
    history.replaceState(null, '', buildHash(s));
  }, 300);
}

async function applyHash() {
  const s = parseHash(location.hash);
  if (s.osm !== null) { osmLayer.show = s.osm; $('#chk-osm').checked = s.osm; }
  if (s.globe !== null) { scene.globe.show = s.globe; $('#chk-globe').checked = s.globe; }
  if (s.camera) {
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(s.camera.lon, s.camera.lat, s.camera.height),
      orientation: { heading: Cesium.Math.toRadians(s.camera.heading), pitch: Cesium.Math.toRadians(s.camera.pitch), roll: Cesium.Math.toRadians(s.camera.roll) },
    });
  } else {
    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(ISUA.lon, ISUA.lat, 25000) });
  }
  for (const t of s.tilesets) await openUrl(t.url, { offset: t.offset, fly: !s.camera });
}

// ------------------------------------------------------------------ diagnostics UI
async function runDiagnostics(url) {
  const out = $('#diag-out');
  out.replaceChildren(el('p', { class: 'hint' }, 'Checking…'));
  const r = await diagnoseUrl(url);
  const items = r.checks.map((c) => el('div', { class: `check-item ${c.status}` }, el('b', {}, `${c.label}: `), c.detail));
  const parts = [el('div', { class: 'summary' }, r.summary), ...items];
  if (r.askHost.length) {
    const text = hostRequestText(r);
    const ta = el('textarea', { readonly: true, 'aria-label': 'Request to the data host' });
    ta.value = text;
    parts.push(el('h3', {}, 'What to ask the host (e.g. support@erda.dk)'), ta,
      el('div', { class: 'row' }, el('button', { type: 'button', onclick: () => copyText(text, 'Request text copied.') }, 'Copy text')));
  }
  if (r.modes.archive3tz || r.modes.tilesetJson) {
    parts.push(el('div', { class: 'row' }, el('button', { type: 'button', onclick: () => openUrl(url) }, 'Load this URL')));
  }
  out.replaceChildren(...parts);
  return r;
}

async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); notify(okMsg, 'ok', { timeout: 3000 }); } catch { prompt('Copy this:', text); }
}

// ------------------------------------------------------------------ screenshot
function screenshot(scale) {
  const prev = viewer.resolutionScale;
  try {
    viewer.resolutionScale = scale;
    viewer.resize();
    viewer.render();
    viewer.canvas.toBlob((blob) => {
      if (blob) download(blob, `isua-view-${stamp()}.png`);
      else notify('Screenshot failed (canvas too large?). Try a lower resolution.', 'error');
    }, 'image/png');
  } finally {
    viewer.resolutionScale = prev;
  }
}

// ------------------------------------------------------------------ drag & drop
async function filesFromEntry(entry, prefix = '') {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    return [{ file, path: prefix + entry.name }];
  }
  const reader = entry.createReader();
  const out = [];
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const e of batch) out.push(...await filesFromEntry(e, `${prefix}${entry.name}/`));
  }
  return out;
}

async function handleDrop(dt) {
  // Grab everything synchronously: DataTransfer items expire after the event.
  const items = [...(dt.items || [])].filter((i) => i.kind === 'file');
  const handles = items.map((i) => (i.getAsFileSystemHandle ? i.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null)));
  const entries = items.map((i) => i.webkitGetAsEntry?.() ?? null);
  const files = items.map((i) => i.getAsFile());
  for (let k = 0; k < items.length; k++) {
    const handle = await handles[k];
    const entry = entries[k];
    const file = files[k];
    if (handle?.kind === 'directory') {
      try { await openFolder(await FolderProvider.fromDirectoryHandle(handle)); } catch (e) { notify(e.message, 'error'); }
    } else if (entry?.isDirectory) {
      try { await openFolder(FolderProvider.fromFileList(await filesFromEntry(entry))); } catch (e) { notify(e.message, 'error'); }
    } else if (file) {
      await openDroppedFile(file);
    }
  }
}

async function openDroppedFile(file) {
  const n = file.name.toLowerCase();
  if (n.endsWith('.3tz') || n.endsWith('.zip')) await openLocal3tz(file);
  else if (n.endsWith('.geojson')) await openGeoJsonFile(file);
  else if (n === 'tileset.json') notify('Drop the whole tileset folder, not just tileset.json (the tiles are in the folder next to it).', 'warn');
  else if (n.endsWith('.json')) await openGeoJsonFile(file);
  else notify(`${file.name}: unsupported file type (expected .3tz, a tileset folder, or .geojson).`, 'warn');
}

// ------------------------------------------------------------------ wiring
const TOOL_HELP = {
  inspect: 'Click on a model to read coordinates. Click a GeoJSON point to see its properties.',
  distance: 'Click two points: 3D distance, horizontal distance and height difference.',
  plane: 'Click 3 or more points spread over one planar surface (bedding, foliation, joint…). The plane is fitted by least squares (orthogonal regression). Backspace = undo, Enter = save, Esc = clear.',
};

function setTool(tool) {
  state.tool = tool;
  state.pending = [];
  $('#tool-help').textContent = TOOL_HELP[tool];
  $('#plane-box').hidden = tool !== 'plane';
  redrawPending();
}

function capabilities() {
  const caps = [
    ['Service Worker (local .3tz, folders, remote .3tz)', state.sw.ok, state.sw.reason],
    ['Folder picker', 'showDirectoryPicker' in window, 'not available: the browser\'s folder upload dialog is used instead'],
    ['DecompressionStream (compressed .3tz entries)', typeof DecompressionStream !== 'undefined', 'missing: update the browser'],
    ['WebGL 2', !!scene.context.webgl2, 'WebGL 1 only: may be slower'],
  ];
  $('#caps').replaceChildren(...caps.map(([name, ok, why]) => el('li', { class: ok ? 'ok' : 'warn' }, `${ok ? '✓' : '!'} ${name}${ok ? '' : ` – ${why}`}`)));
}

function wire() {
  $('#btn-panel').addEventListener('click', (e) => {
    const p = $('#panel');
    p.classList.toggle('collapsed');
    e.target.textContent = p.classList.contains('collapsed') ? '⟩' : '⟨';
    e.target.setAttribute('aria-expanded', String(!p.classList.contains('collapsed')));
    setTimeout(() => viewer.resize(), 50);
  });
  $('#in-3tz').addEventListener('change', async (e) => {
    for (const f of [...e.target.files]) await openLocal3tz(f);
    e.target.value = '';
  });
  $('#btn-folder').addEventListener('click', async () => {
    if (!requireServiceWorker('Opening tileset folders')) return;
    if ('showDirectoryPicker' in window) {
      try {
        const dir = await window.showDirectoryPicker({ id: 'isua-tileset', mode: 'read' });
        await openFolder(await FolderProvider.fromDirectoryHandle(dir));
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
        if (e.name !== 'SecurityError' && e.name !== 'TypeError') { notify(e.message, 'error'); return; }
      }
    }
    $('#in-folder').click();
  });
  $('#in-folder').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    try { await openFolder(FolderProvider.fromFileList(files)); } catch (err) { notify(err.message, 'error'); }
  });
  $('#form-url').addEventListener('submit', (e) => { e.preventDefault(); openUrl($('#in-url').value.trim()); });
  $('#in-geojson').addEventListener('change', async (e) => {
    for (const f of [...e.target.files]) await openGeoJsonFile(f);
    e.target.value = '';
  });
  document.querySelectorAll('input[name="tool"]').forEach((r) => r.addEventListener('change', () => setTool(r.value)));
  $('#btn-plane-save').addEventListener('click', savePlane);
  $('#btn-plane-undo').addEventListener('click', () => { state.pending.pop(); redrawPending(); });
  $('#btn-plane-clear').addEventListener('click', () => { state.pending = []; redrawPending(); });
  $('#btn-save-point').addEventListener('click', () => {
    if (state.lastPick) commitMeasurement('point', [state.lastPick.ecef], state.lastPick.entry, $('#in-label').value.trim());
  });
  $('#btn-csv').addEventListener('click', () => {
    if (!state.measurements.length) return notify('No measurements to export.', 'warn', { timeout: 3000 });
    download(new Blob(['﻿', toCsv(state.measurements)], { type: 'text/csv;charset=utf-8' }), `isua-measurements-${stamp()}.csv`);
  });
  $('#btn-geojson').addEventListener('click', () => {
    if (!state.measurements.length) return notify('No measurements to export.', 'warn', { timeout: 3000 });
    download(new Blob([JSON.stringify(toGeoJson(state.measurements), null, 1)], { type: 'application/geo+json' }), `isua-measurements-${stamp()}.geojson`);
  });
  $('#btn-meas-clear').addEventListener('click', () => {
    if (!state.measurements.length || !confirm(`Delete all ${state.measurements.length} measurements? Export them first if you need them.`)) return;
    state.measurements = [];
    saveMeasurements(); redrawMeasurements(); renderMeasurements();
  });
  $('#chk-osm').addEventListener('change', (e) => { osmLayer.show = e.target.checked; updateHash(); });
  $('#sel-detail').value = String(perf.sse);
  $('#chk-moving').checked = perf.coarserWhileMoving;
  $('#sel-detail').addEventListener('change', (e) => { perf.sse = Number(e.target.value); applySse(); savePerf(); });
  $('#chk-moving').addEventListener('change', (e) => { perf.coarserWhileMoving = e.target.checked; applySse(); savePerf(); });
  $('#chk-fps').addEventListener('change', (e) => { scene.debugShowFramesPerSecond = e.target.checked; });
  // Memory held by the loaded models (graphics card), so a slow-down after loading several surveys can be seen.
  setInterval(() => {
    const out = $('#perf-mem');
    if (!out || !$('#sec-perf').open) return;
    const mb = (b) => Math.round(b / 1048576);
    const parts = state.tilesets.map((t) => `${t.name.replace(/_Tiles_ITRF2020\.3tz$/, '')}: ${mb(t.tileset.totalMemoryUsageInBytes)} MB${t.tileset.show ? '' : ' (hidden)'}`);
    const total = state.tilesets.reduce((a, t) => a + t.tileset.totalMemoryUsageInBytes, 0);
    out.textContent = state.tilesets.length ? `Model memory ${mb(total)} MB (${parts.join(', ')})` : '';
  }, 2000);
  $('#chk-globe').addEventListener('change', (e) => { scene.globe.show = e.target.checked; updateHash(); });
  $('#btn-shot').addEventListener('click', () => screenshot(Number($('#sel-scale').value)));
  $('#btn-link').addEventListener('click', () => {
    updateHash();
    setTimeout(() => copyText(location.href, state.tilesets.some((t) => !t.shareUrl)
      ? 'Link copied. Note: locally opened files are not part of the link.' : 'Link copied.'), 350);
  });
  $('#form-diag').addEventListener('submit', (e) => { e.preventDefault(); runDiagnostics($('#in-diag').value.trim()); });

  document.addEventListener('keydown', (e) => {
    if (state.tool !== 'plane' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.key === 'Backspace') { state.pending.pop(); redrawPending(); e.preventDefault(); }
    if (e.key === 'Escape') { state.pending = []; redrawPending(); }
    if (e.key === 'Enter' && state.pending.length >= 3) savePlane();
  });

  const overlay = $('#drop-overlay');
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth++; overlay.hidden = false; } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); depth = 0; overlay.hidden = true; handleDrop(e.dataTransfer); });

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
  handler.setInputAction((ev) => onClick(ev.position), Cesium.ScreenSpaceEventType.LEFT_CLICK);
  viewer.camera.moveEnd.addEventListener(updateHash);
}

function savePlane() {
  if (state.pending.length < 3) return;
  commitMeasurement('plane', state.pending, state.pendingTileset, $('#in-label').value.trim());
  state.pending = [];
  redrawPending();
}

async function main() {
  wire();
  window.isua.nav = setupNavigation({ viewer, Cesium, flyHome, onChange: updateHash });
  setTool('inspect');
  loadMeasurements();
  redrawMeasurements();
  renderMeasurements();
  state.sw = await initServiceWorker();
  capabilities();
  if (!state.sw.ok) {
    $('#lbl-3tz').classList.add('disabled');
    const msg = notify(state.sw.reason, 'warn', { timeout: 0 });
    if (state.sw.needsReload) msg.append(' ', el('button', { type: 'button', style: 'position:static', onclick: () => location.reload() }, 'Reload now'));
  }
  await applyHash();
  window.isua.ready = true;
}

main().catch((e) => notify(`Viewer start-up failed: ${e.message}`, 'error'));
