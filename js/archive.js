// 3D Tiles archive (.3tz) access: fast lookup via the "@3dtilesIndex1@" index when present
// (OGC 3D Tiles archive format, as written by 3d-tiles-tools / Agisoft Metashape), with the
// ZIP central directory as fall-back. Also a provider for unpacked tileset folders.

import { md5 } from './md5.js';
import {
  readEndOfCentralDirectory, readCentralDirectory, readLastCentralEntry,
  readLocalHeader, readEntryData, ZipError, isGzip, gunzip,
} from './zip.js';

export const INDEX_NAME = '@3dtilesIndex1@';
const ENTRY_SIZE = 24; // 16-byte MD5 of the path + uint64 LE offset of the local file header

/**
 * Compare two 16-byte MD5 digests in index order: first the low little-endian uint64
 * (bytes 0..7), then the high one (bytes 8..15). This is the order 3d-tiles-tools sorts by.
 */
export function compareHash(a, aOff, b, bOff = 0) {
  for (const base of [0, 8]) {
    for (let i = base + 7; i >= base; i--) {
      const d = a[aOff + i] - b[bOff + i];
      if (d !== 0) return d;
    }
  }
  return 0;
}

/** Parse the raw index bytes. Re-sorts if needed so binary search is always valid. */
export function parseIndex(bytes) {
  if (bytes.length % ENTRY_SIZE !== 0) throw new ZipError(`${INDEX_NAME} has invalid length ${bytes.length}.`);
  const n = bytes.length / ENTRY_SIZE;
  let data = bytes;
  let sorted = true;
  for (let i = 1; i < n && sorted; i++) {
    if (compareHash(data, i * ENTRY_SIZE, data, (i - 1) * ENTRY_SIZE) < 0) sorted = false;
  }
  if (!sorted) {
    const order = Array.from({ length: n }, (_, i) => i)
      .sort((x, y) => compareHash(bytes, x * ENTRY_SIZE, bytes, y * ENTRY_SIZE));
    data = new Uint8Array(bytes.length);
    order.forEach((src, dst) => data.set(bytes.subarray(src * ENTRY_SIZE, (src + 1) * ENTRY_SIZE), dst * ENTRY_SIZE));
  }
  return { data, count: n, wasSorted: sorted };
}

/** Binary search for `path` in a parsed index. Returns the local header offset or -1. */
export function lookupIndex(index, path) {
  const h = md5(path);
  const { data } = index;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let lo = 0, hi = index.count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const c = compareHash(data, mid * ENTRY_SIZE, h, 0);
    if (c === 0) return Number(view.getBigUint64(mid * ENTRY_SIZE + 16, true));
    if (c < 0) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

export function normalizePath(path) {
  let p = String(path).replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  return p.replace(/^\/+/, '');
}

const MIME = {
  json: 'application/json', geojson: 'application/geo+json', glb: 'model/gltf-binary', gltf: 'model/gltf+json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ktx2: 'image/ktx2',
  b3dm: 'application/octet-stream', i3dm: 'application/octet-stream', pnts: 'application/octet-stream',
  cmpt: 'application/octet-stream', subtree: 'application/octet-stream', bin: 'application/octet-stream',
};
export function mimeFor(path) {
  const ext = path.split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

async function maybeGunzip(bytes) {
  // 3d-tiles-tools can gzip tile payloads inside the archive; browsers need them plain.
  return isGzip(bytes) ? gunzip(bytes) : bytes;
}

export class ThreeTzArchive {
  constructor(source) {
    this.source = source;
    this.eocd = null;
    this.index = null;
    this.central = null; // Map name -> entry, loaded lazily
    this.mode = 'unknown';
    this.warnings = [];
  }

  static async open(source) {
    const a = new ThreeTzArchive(source);
    a.eocd = await readEndOfCentralDirectory(source);
    const last = await readLastCentralEntry(source, a.eocd);
    if (last && last.name === INDEX_NAME) {
      try {
        const local = await readLocalHeader(source, last.localOffset);
        a.index = parseIndex(await readEntryData(source, local, last));
        if (!a.index.wasSorted) a.warnings.push(`${INDEX_NAME} was not sorted; sorted it in memory.`);
        a.mode = 'index';
      } catch (e) {
        a.warnings.push(`Could not use ${INDEX_NAME} (${e.message}); using the ZIP central directory.`);
      }
    }
    if (!a.index) {
      await a._loadCentral();
      a.mode = 'central-directory';
    }
    return a;
  }

  async _loadCentral() {
    if (!this.central) {
      const entries = await readCentralDirectory(this.source, this.eocd);
      this.central = new Map(entries.map((e) => [e.name, e]));
    }
    return this.central;
  }

  get entryCount() {
    return this.index ? this.index.count : this.central?.size ?? 0;
  }

  /** @returns {Promise<Uint8Array|null>} decompressed bytes or null if not in the archive */
  async get(path) {
    const p = normalizePath(path);
    if (this.index) {
      for (const candidate of p === p.toLowerCase() ? [p] : [p, p.toLowerCase()]) {
        const off = lookupIndex(this.index, candidate);
        if (off < 0) continue;
        const local = await readLocalHeader(this.source, off);
        if (local.name !== candidate && local.name !== p) continue; // hash collision or bad index
        if (local.hasDataDescriptor && local.csize === 0) break; // need central directory sizes
        return maybeGunzip(await readEntryData(this.source, local));
      }
      // Not in the index (or index unusable for it): confirm against the central directory.
    }
    const central = await this._loadCentral();
    const entry = central.get(p);
    if (!entry) return null;
    const local = await readLocalHeader(this.source, entry.localOffset);
    return maybeGunzip(await readEntryData(this.source, local, entry));
  }

  /** Path of the root tileset JSON: "tileset.json" at the root, else the shallowest one. */
  async findTilesetPath() {
    if (this.index ? lookupIndex(this.index, 'tileset.json') >= 0 : this.central.has('tileset.json')) {
      return 'tileset.json';
    }
    const central = await this._loadCentral();
    if (central.has('tileset.json')) return 'tileset.json';
    const candidates = [...central.keys()].filter((n) => /(^|\/)tileset\.json$/i.test(n))
      .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
    return candidates[0] ?? null;
  }
}

/**
 * Unpacked tileset folder. `lookup(path)` returns a File/Blob or null; built either from a
 * FileSystemDirectoryHandle (lazy, scales to huge folders) or from a flat list of Files
 * carrying `webkitRelativePath` / a relative path.
 */
export class FolderProvider {
  constructor(name, lookup, tilesetPath = 'tileset.json') {
    this.name = name;
    this.lookup = lookup;
    this.tilesetPath = tilesetPath;
    this.mode = 'folder';
    this.warnings = [];
  }

  /** @param {Iterable<File|{file: File, path: string}>} files */
  static fromFileList(files) {
    const map = new Map();
    let top = null;
    for (const item of files) {
      const f = item.file ?? item;
      const rel = normalizePath(item.path || f.webkitRelativePath || f.name);
      const parts = rel.split('/');
      top ??= parts.length > 1 ? parts[0] : '';
      map.set(rel, f);
    }
    // webkitdirectory paths start with the chosen folder's name; strip it.
    const strip = top && [...map.keys()].every((k) => k.startsWith(`${top}/`)) ? `${top}/` : '';
    const rel = new Map([...map].map(([k, f]) => [k.slice(strip.length), f]));
    const tilesets = [...rel.keys()].filter((k) => /(^|\/)tileset\.json$/i.test(k))
      .sort((a, b) => a.split('/').length - b.split('/').length);
    if (!tilesets.length) throw new Error('No tileset.json found in the chosen folder.');
    return new FolderProvider(top || 'folder', async (p) => rel.get(p) ?? null, tilesets[0]);
  }

  static async fromDirectoryHandle(dir) {
    const lookup = async (p) => {
      const parts = p.split('/').filter(Boolean);
      try {
        let d = dir;
        for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part);
        return await (await d.getFileHandle(parts.at(-1))).getFile();
      } catch {
        return null;
      }
    };
    let tilesetPath = 'tileset.json';
    if (!(await lookup(tilesetPath))) {
      tilesetPath = null;
      for await (const [name, h] of dir.entries()) { // one level down, e.g. a folder named after the survey
        if (h.kind === 'directory' && (await lookup(`${name}/tileset.json`))) { tilesetPath = `${name}/tileset.json`; break; }
      }
      if (!tilesetPath) throw new Error('No tileset.json in the chosen folder (or one level below).');
    }
    return new FolderProvider(dir.name, lookup, tilesetPath);
  }

  async get(path) {
    const f = await this.lookup(normalizePath(path));
    return f ? maybeGunzip(new Uint8Array(await f.arrayBuffer())) : null;
  }

  async findTilesetPath() { return this.tilesetPath; }
}
