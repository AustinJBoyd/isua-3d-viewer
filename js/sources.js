// Random-access byte sources. Everything that reads a .3tz goes through
// `source.read(offset, length) -> Promise<Uint8Array>` so the same ZIP code works on a
// local File (Blob.slice, nothing loaded up front) and on a remote URL (HTTP Range requests).

export class BlobSource {
  /** @param {Blob} blob */
  constructor(blob, name = blob.name || 'archive') {
    this.blob = blob;
    this.size = blob.size;
    this.name = name;
    this.bytesRead = 0;
    this.requests = 0;
  }

  async read(offset, length) {
    const end = Math.min(this.size, offset + length);
    if (offset < 0 || offset > end) throw new RangeError(`read outside file: ${offset}+${length}`);
    this.requests++;
    const buf = new Uint8Array(await this.blob.slice(offset, end).arrayBuffer());
    this.bytesRead += buf.length;
    return buf;
  }
}

export class RangeNotSupportedError extends Error {
  constructor(msg) { super(msg); this.name = 'RangeNotSupportedError'; }
}

/**
 * Reads a remote file with HTTP Range requests, never downloading it whole.
 * Small reads are served from an LRU cache of aligned blocks (the ZIP headers are read in
 * many small pieces); large reads (tile payloads) go straight to the server.
 */
export class HttpRangeSource {
  constructor(url, size, { fetchImpl, blockSize, maxBlocks }) {
    this.url = url;
    this.size = size;
    this.name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'remote.3tz');
    this.fetchImpl = fetchImpl;
    this.blockSize = blockSize;
    this.maxBlocks = maxBlocks;
    this.blocks = new Map(); // block index -> Promise<Uint8Array>
    this.bytesRead = 0;
    this.requests = 0;
  }

  /**
   * Find the file size (HEAD Content-Length, else a 1-byte Range request's Content-Range)
   * and check that Range requests really return 206.
   */
  static async open(url, { fetchImpl = globalThis.fetch.bind(globalThis), blockSize = 64 * 1024, maxBlocks = 512 } = {}) {
    let size = NaN;
    try {
      const head = await fetchImpl(url, { method: 'HEAD', cache: 'no-store' });
      if (head.status === 404) throw new Error(`Not found (HTTP 404): ${url}`);
      if (head.ok) size = Number(head.headers.get('content-length'));
    } catch (e) {
      if (/404/.test(e.message)) throw e;
      // HEAD can be refused by some servers; fall through to the Range probe.
    }
    const src = new HttpRangeSource(url, Number.isFinite(size) && size > 0 ? size : Infinity, { fetchImpl, blockSize, maxBlocks });
    const probe = await src._fetchRange(0, 1, true);
    if (!(src.size < Infinity)) {
      if (!(probe.total > 0)) {
        throw new Error('Could not determine the file size: the server sends neither Content-Length on HEAD nor an exposed Content-Range header.');
      }
      src.size = probe.total;
    }
    return src;
  }

  async _fetchRange(start, endExclusive, wantTotal = false) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this.requests++;
    const res = await this.fetchImpl(this.url, {
      headers: { Range: `bytes=${start}-${endExclusive - 1}` },
      cache: 'no-store',
      signal: controller?.signal,
    });
    if (res.status === 200) {
      controller?.abort(); // do not download the whole archive
      throw new RangeNotSupportedError('The server ignored the Range header (answered 200 with the whole file instead of 206). Remote .3tz streaming needs byte-range support.');
    }
    if (res.status === 416) throw new RangeError(`Requested range not satisfiable: ${start}-${endExclusive - 1}`);
    if (res.status !== 206) throw new Error(`HTTP ${res.status} for range ${start}-${endExclusive - 1}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    this.bytesRead += buf.length;
    let total;
    if (wantTotal) {
      const cr = res.headers.get('content-range');
      const m = cr && /\/(\d+)\s*$/.exec(cr);
      total = m ? Number(m[1]) : undefined;
    }
    const expected = Math.min(endExclusive, this.size) - start;
    if (Number.isFinite(expected) && buf.length !== expected) {
      throw new Error(`Server returned ${buf.length} bytes for a ${expected}-byte range`);
    }
    return { buf, total };
  }

  _block(i) {
    let p = this.blocks.get(i);
    if (p) { this.blocks.delete(i); this.blocks.set(i, p); return p; } // LRU touch
    const start = i * this.blockSize;
    p = this._fetchRange(start, Math.min(this.size, start + this.blockSize)).then((r) => r.buf);
    p.catch(() => this.blocks.delete(i));
    this.blocks.set(i, p);
    while (this.blocks.size > this.maxBlocks) this.blocks.delete(this.blocks.keys().next().value);
    return p;
  }

  async read(offset, length) {
    const end = Math.min(this.size, offset + length);
    if (offset < 0 || offset > end) throw new RangeError(`read outside file: ${offset}+${length}`);
    if (end === offset) return new Uint8Array(0);
    if (end - offset > 2 * this.blockSize) return (await this._fetchRange(offset, end)).buf;
    const first = Math.floor(offset / this.blockSize);
    const last = Math.floor((end - 1) / this.blockSize);
    const parts = await Promise.all(Array.from({ length: last - first + 1 }, (_, k) => this._block(first + k)));
    const out = new Uint8Array(end - offset);
    let pos = 0;
    parts.forEach((blk, k) => {
      const blockStart = (first + k) * this.blockSize;
      const from = Math.max(offset, blockStart) - blockStart;
      const to = Math.min(end, blockStart + blk.length) - blockStart;
      out.set(blk.subarray(from, to), pos);
      pos += to - from;
    });
    return out;
  }
}
