// Shareable view state in the URL hash, e.g.
//   #cam=-50.0001,65.1702,350,12.5,-35,0&ts=https%3A%2F%2Fexample.org%2Fa.3tz%7C-31.2&osm=0
// cam = lon, lat, height (m), heading, pitch, roll (deg); one `ts` per remote tileset as
// "<url>|<vertical offset m>"; osm / globe = 0 or 1. Only remote URLs can be shared:
// local files and folders exist only on the viewer's own computer.

export function parseHash(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const state = { tilesets: [], camera: null, osm: null, globe: null };
  const cam = params.get('cam');
  if (cam) {
    const v = cam.split(',').map(Number);
    if (v.length >= 3 && v.slice(0, 3).every(Number.isFinite)) {
      state.camera = { lon: v[0], lat: v[1], height: v[2], heading: v[3] || 0, pitch: Number.isFinite(v[4]) ? v[4] : -90, roll: v[5] || 0 };
    }
  }
  for (const t of params.getAll('ts')) {
    const i = t.lastIndexOf('|');
    const offset = i >= 0 ? Number(t.slice(i + 1)) : 0;
    const url = i >= 0 && Number.isFinite(offset) ? t.slice(0, i) : t;
    if (url) state.tilesets.push({ url, offset: Number.isFinite(offset) ? offset : 0 });
  }
  for (const k of ['osm', 'globe']) if (params.has(k)) state[k] = params.get(k) !== '0';
  return state;
}

export function buildHash(state) {
  const params = new URLSearchParams();
  if (state.camera) {
    const c = state.camera;
    params.set('cam', [c.lon.toFixed(7), c.lat.toFixed(7), c.height.toFixed(1), c.heading.toFixed(1), c.pitch.toFixed(1), c.roll.toFixed(1)].join(','));
  }
  for (const t of state.tilesets || []) params.append('ts', `${t.url}|${Math.round(Number(t.offset || 0) * 100) / 100}`);
  for (const k of ['osm', 'globe']) if (state[k] === false) params.set(k, '0');
  return `#${params.toString()}`;
}
