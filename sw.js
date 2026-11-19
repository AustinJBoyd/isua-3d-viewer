// Service Worker for the Isua 3D Tiles viewer.
//
// It answers requests under <viewer>/__3tz__/<sourceId>/<path inside the tileset> by asking the
// page that owns <sourceId> (a local .3tz, a local folder, or a remote .3tz read with Range
// requests) for the bytes. The worker itself keeps no state: browsers stop idle workers after
// ~30 s, which would lose any File objects kept here. All archive reading happens in the page.
// See docs/DECISIONS.md (WP1) for why this approach was chosen.

const PREFIX = '/__3tz__/';
const TIMEOUT_MS = 180000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const i = url.pathname.indexOf(PREFIX);
  if (i < 0) return;
  const rest = url.pathname.slice(i + PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return;
  const id = rest.slice(0, slash);
  let path;
  try { path = decodeURIComponent(rest.slice(slash + 1)); } catch { path = rest.slice(slash + 1); }
  event.respondWith(serve(event, id, path));
});

function ask(client, id, path) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve({ status: 504, error: 'timeout waiting for the viewer page' }), TIMEOUT_MS);
    channel.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
    client.postMessage({ type: 'isua-3tz-get', id, path }, [channel.port2]);
  });
}

async function serve(event, id, path) {
  const candidates = [];
  if (event.clientId) {
    const c = await self.clients.get(event.clientId);
    if (c) candidates.push(c);
  }
  for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
    if (!candidates.some((x) => x.id === c.id)) candidates.push(c);
  }
  let last = { status: 404, error: 'No open viewer page knows this data source. Re-open the file in the viewer.' };
  for (const client of candidates) {
    const r = await ask(client, id, path);
    if (r && !r.unknownSource) { last = r; break; }
  }
  const headers = { 'Cache-Control': 'no-store' };
  if (last.status === 200) {
    headers['Content-Type'] = last.contentType || 'application/octet-stream';
    return new Response(last.body, { status: 200, headers });
  }
  headers['Content-Type'] = 'text/plain; charset=utf-8';
  return new Response(last.error || `HTTP ${last.status}`, { status: last.status || 500, headers });
}
