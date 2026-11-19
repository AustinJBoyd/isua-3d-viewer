// Page side of the Service Worker bridge: registers sw.js and answers its requests from the
// data sources (archives / folders) opened in this page.

import { mimeFor } from './archive.js';

const sources = new Map(); // id -> provider with get(path) -> Uint8Array|null
let status = { ok: false, reason: 'not initialised' };

export const VIRTUAL_PREFIX = '__3tz__';

export function registerSource(provider) {
  const id = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^a-z0-9]/gi, '').slice(0, 12);
  sources.set(id, provider);
  return id;
}

export function unregisterSource(id) { sources.delete(id); }

export function virtualUrl(id, path) {
  const enc = path.split('/').map(encodeURIComponent).join('/');
  return new URL(`${VIRTUAL_PREFIX}/${id}/${enc}`, document.baseURI).href;
}

async function onMessage(event) {
  const msg = event.data;
  if (!msg || msg.type !== 'isua-3tz-get') return;
  const port = event.ports[0];
  const provider = sources.get(msg.id);
  if (!provider) { port.postMessage({ unknownSource: true, status: 404 }); return; }
  try {
    const bytes = await provider.get(msg.path);
    if (!bytes) { port.postMessage({ status: 404, error: `Not in the data source: ${msg.path}` }); return; }
    const body = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    port.postMessage({ status: 200, body, contentType: mimeFor(msg.path) }, [body]);
  } catch (e) {
    console.error('3tz read failed', msg.path, e);
    provider.onError?.(e, msg.path);
    port.postMessage({ status: 500, error: String(e?.message || e) });
  }
}

/** @returns {Promise<{ok:boolean, reason?:string}>} */
export async function initServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    status = { ok: false, reason: location.protocol === 'file:'
      ? 'This page was opened as a file (file://). Local .3tz files and folders need the viewer served over http://localhost or https: run "python -m isuaphoto viewer".'
      : 'This browser has no Service Worker support here (e.g. a Firefox private window). Opening local .3tz files and folders is disabled; remote tileset.json URLs still work.' };
    return status;
  }
  if (!window.isSecureContext) {
    status = { ok: false, reason: 'Service Workers need https or http://localhost. Local .3tz files and folders are disabled on this address.' };
    return status;
  }
  try {
    navigator.serviceWorker.onmessage = onMessage; // also starts the message queue
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 4000);
        navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
    if (!navigator.serviceWorker.controller) {
      status = { ok: false, needsReload: true, reason: 'The page was force-reloaded (Ctrl+Shift+R / Ctrl+F5), which bypasses the Service Worker. Reload normally (F5) to open local files.' };
      return status;
    }
    status = { ok: true };
  } catch (e) {
    status = { ok: false, reason: `Service Worker registration failed: ${e.message}` };
  }
  return status;
}

export const serviceWorkerStatus = () => status;
