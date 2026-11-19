// Remote-URL diagnostics: can this browser stream a tileset / .3tz from that server?
// Every check is a real request made the same way the viewer would make it, and the result is
// explained in plain language together with what to ask the host for.

const OK = 'ok', WARN = 'warn', FAIL = 'fail', INFO = 'info';

function kindOf(url) {
  const path = url.pathname.toLowerCase();
  if (/\.(3tz|zip)$/.test(path)) return 'archive';
  if (/\.json$/.test(path)) return 'tileset';
  return 'unknown';
}

const isLocalHost = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');

/**
 * @param {string} rawUrl
 * @param {{fetchImpl?: Function, pageOrigin?: string, pageProtocol?: string}} [opts]
 */
export async function diagnoseUrl(rawUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch.bind(globalThis);
  const pageOrigin = opts.pageOrigin ?? globalThis.location?.origin ?? 'null';
  const pageProtocol = opts.pageProtocol ?? globalThis.location?.protocol ?? 'https:';
  const checks = [];
  const add = (id, status, label, detail) => checks.push({ id, status, label, detail });
  const report = { url: rawUrl, checks, kind: 'unknown', modes: { tilesetJson: false, archive3tz: false }, askHost: [], summary: '' };

  let url;
  try { url = new URL(rawUrl); } catch {
    add('url', FAIL, 'URL', 'This is not a valid web address. It must start with https:// (or http://).');
    report.summary = 'Invalid URL.';
    return report;
  }
  report.kind = kindOf(url);
  const sameOrigin = url.origin === pageOrigin;
  add('url', INFO, 'URL', `${report.kind === 'archive' ? '3D Tiles archive (.3tz)' : report.kind === 'tileset' ? 'Unpacked tileset (tileset.json)' : 'Unknown file type (expected .3tz or tileset.json)'}; ${sameOrigin ? 'same server as this viewer (CORS not needed)' : `different server than this viewer (${pageOrigin}), so CORS is needed`}.`);

  if (pageProtocol === 'https:' && url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    add('mixed', FAIL, 'Secure connection', 'This viewer is loaded over https but the data URL is plain http. Browsers block that ("mixed content"). Use the https:// address of the file.');
    report.askHost.push('Serve the file over https.');
  }

  // 1. Reachability + CORS (HEAD, as the viewer does to learn the file size).
  let head = null;
  let corsOk = false;
  try {
    head = await fetchImpl(url.href, { method: 'HEAD', mode: 'cors', cache: 'no-store' });
    corsOk = true;
  } catch (e) {
    let reachable = false;
    try {
      await fetchImpl(url.href, { method: 'GET', mode: 'no-cors', cache: 'no-store' });
      reachable = true;
    } catch { /* not reachable at all */ }
    if (reachable) {
      add('cors', FAIL, 'CORS (Access-Control-Allow-Origin)', 'The server answers, but does not allow web pages from other sites to read the file (no Access-Control-Allow-Origin header). The browser therefore blocks the viewer.');
      report.askHost.push('Add the response header "Access-Control-Allow-Origin: *" (or the viewer\'s address) for this path, also on HEAD requests and on 206 Partial Content responses.');
    } else {
      add('reach', FAIL, 'Reachability', `The server could not be reached (${e.message}). Check the address, your internet connection, or whether the link is public.`);
    }
  }

  if (head) {
    if (head.status === 405 || head.status === 501) {
      add('head', WARN, 'HEAD request', `The server refuses HEAD requests (HTTP ${head.status}). The viewer will try to get the file size from a Range request instead.`);
    } else if (!head.ok) {
      const why = head.status === 404 ? 'File not found (404). Check the link.'
        : head.status === 401 || head.status === 403 ? `Access denied (HTTP ${head.status}). The link is probably not public, or needs a login.`
          : `HTTP ${head.status}.`;
      add('head', FAIL, 'Reachability', why);
    } else {
      add('reach', OK, 'Reachability', `The server answers (HTTP ${head.status})${head.redirected ? `, after a redirect to ${head.url}` : ''}.`);
    }
    add('cors', OK, 'CORS (Access-Control-Allow-Origin)', sameOrigin ? 'Not needed: same server as the viewer.' : 'Allowed: the browser lets this viewer read responses from this server.');
    const ar = head.headers.get('accept-ranges');
    if (ar && /bytes/i.test(ar)) add('accept-ranges', OK, 'Accept-Ranges', 'The server says it supports byte ranges ("Accept-Ranges: bytes").');
    else if (ar) add('accept-ranges', WARN, 'Accept-Ranges', `The server says "Accept-Ranges: ${ar}". Byte ranges may not work.`);
    else add('accept-ranges', sameOrigin ? WARN : INFO, 'Accept-Ranges', sameOrigin ? 'No Accept-Ranges header. The Range test below is decisive.' : 'Header not visible to the viewer (it is not in Access-Control-Expose-Headers). Not a problem by itself: the Range test below is decisive.');
  }

  // 2. Range request (what .3tz streaming needs).
  let size = head && head.ok ? Number(head.headers.get('content-length')) : NaN;
  if (Number.isFinite(size) && size > 0) add('content-length', OK, 'Content-Length', `File size is visible: ${formatBytes(size)}.`);
  else if (head && head.ok) add('content-length', WARN, 'Content-Length', 'The file size is not visible on a HEAD request.');

  let range206 = false, contentRangeVisible = false, magicOk = null;
  if (corsOk || sameOrigin) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    try {
      const res = await fetchImpl(url.href, { headers: { Range: 'bytes=0-15' }, mode: 'cors', cache: 'no-store', signal: ctl?.signal });
      if (res.status === 206) {
        range206 = true;
        const bytes = new Uint8Array(await res.arrayBuffer());
        add('range', OK, 'Range requests (HTTP 206)', 'A request for the first 16 bytes returned only those bytes (206 Partial Content). Streaming works.');
        const cr = res.headers.get('content-range');
        const m = cr && /\/(\d+)\s*$/.exec(cr);
        if (m) {
          contentRangeVisible = true;
          if (!(size > 0)) size = Number(m[1]);
          add('content-range', OK, 'Content-Range', `Visible to the viewer (${cr}).`);
        } else {
          add('content-range', size > 0 ? INFO : WARN, 'Content-Range', `Not visible to the viewer (not listed in Access-Control-Expose-Headers).${size > 0 ? ' Not needed, because Content-Length is visible.' : ' The viewer cannot learn the file size.'}`);
        }
        if (report.kind === 'archive') magicOk = bytes[0] === 0x50 && bytes[1] === 0x4b;
        if (report.kind === 'tileset') magicOk = /^\s*\{/.test(new TextDecoder().decode(bytes));
      } else if (res.status === 200) {
        ctl?.abort();
        add('range', FAIL, 'Range requests (HTTP 206)', 'The server ignored the Range header and started sending the whole file (HTTP 200). Remote .3tz streaming needs Range support. An unpacked tileset.json still works.');
        report.askHost.push('Enable HTTP byte-range requests (answer "Range: bytes=…" with 206 Partial Content).');
      } else {
        add('range', FAIL, 'Range requests (HTTP 206)', `Unexpected answer HTTP ${res.status} to a Range request.`);
      }
    } catch (e) {
      add('range', FAIL, 'Range requests (HTTP 206)', `The Range request was blocked or failed (${e.message}). If HEAD worked, the server probably rejects the CORS preflight for the "Range" header.`);
      report.askHost.push('Allow the "Range" request header in CORS: "Access-Control-Allow-Headers: Range" (and answer OPTIONS preflight requests).');
    }
    if (magicOk === false) {
      add('content', WARN, 'Content check', report.kind === 'archive'
        ? 'The first bytes are not a ZIP/3TZ signature. The link may point to an HTML page (e.g. a download/landing page) instead of the file itself. Use the direct file link.'
        : 'The first bytes do not look like JSON. The link may point to an HTML page instead of the file itself.');
    } else if (magicOk === true) {
      add('content', OK, 'Content check', report.kind === 'archive' ? 'Starts with a ZIP signature, as a .3tz should.' : 'Starts like a JSON document.');
    }
  }

  const sizeKnown = size > 0;
  if (!sizeKnown && range206) {
    report.askHost.push('Expose the size headers to web pages: "Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges".');
  }
  const reachableOk = (corsOk || sameOrigin) && !(head && !head.ok && head.status !== 405 && head.status !== 501);
  report.modes.tilesetJson = reachableOk && magicOk !== false;
  report.modes.archive3tz = reachableOk && range206 && sizeKnown && magicOk !== false;

  const lines = [];
  if (report.kind !== 'tileset') lines.push(`Stream this .3tz directly: ${report.modes.archive3tz ? 'YES' : 'NO'}`);
  if (report.kind !== 'archive') lines.push(`Load as unpacked tileset.json: ${report.modes.tilesetJson ? 'YES' : 'NO'}`);
  if (report.kind === 'archive' && !report.modes.archive3tz) {
    lines.push('Alternatives: download the .3tz and open it from disk (no unpacking needed), or run "python -m isuaphoto serve-3tz <file>" locally.');
  }
  report.summary = lines.join('\n');
  report.askHost = [...new Set(report.askHost)];
  return report;
}

export function formatBytes(n) {
  if (!(n >= 0)) return '?';
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** Plain-language e-mail text for the data host (e.g. support@erda.dk). */
export function hostRequestText(report) {
  if (!report.askHost.length) return '';
  return [
    'Hello,',
    '',
    `We would like to view a 3D model stored at ${report.url} directly in a web browser (a CesiumJS viewer hosted on another site), without downloading the whole file.`,
    'For that, the browser needs the following on this file (or folder):',
    '',
    ...report.askHost.map((s) => `- ${s}`),
    '',
    'In short: CORS headers "Access-Control-Allow-Origin: *", "Access-Control-Allow-Headers: Range", "Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges", and byte-range (HTTP 206) support. The data are public (CC BY 4.0).',
    '',
    'Thank you!',
  ].join('\n');
}
