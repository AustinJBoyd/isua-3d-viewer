// Minimal random-access ZIP / ZIP64 reader (read-only), written for .3tz archives.
// Reads only the bytes it needs from a `source` (see sources.js). Supports STORED (0) and
// DEFLATE (8) entries; DEFLATE uses the browser's built-in DecompressionStream.

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

export const METHOD_STORED = 0;
export const METHOD_DEFLATE = 8;

export class ZipError extends Error {
  constructor(msg) { super(msg); this.name = 'ZipError'; }
}

const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u64 = (v, o) => {
  const n = v.getBigUint64(o, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('ZIP64 value too large');
  return Number(n);
};

// IBM code page 437, upper half (ZIP default when the UTF-8 flag is not set).
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const utf8 = new TextDecoder('utf-8', { fatal: false });

export function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return utf8.decode(bytes);
  let ascii = true;
  for (const b of bytes) if (b >= 0x80) { ascii = false; break; }
  if (ascii) return utf8.decode(bytes);
  // Many tools write UTF-8 without setting the flag; accept it if it decodes cleanly.
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* not UTF-8 */ }
  return Array.from(bytes, (b) => (b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80])).join('');
}

/** Parse ZIP64 extended information extra field (id 0x0001) for the fields flagged as 0xFFFFFFFF. */
function applyZip64Extra(extra, fields) {
  const v = dv(extra);
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = v.getUint16(p, true);
    const size = v.getUint16(p + 2, true);
    if (id === 0x0001) {
      let q = p + 4;
      for (const key of ['usize', 'csize', 'offset']) {
        if (fields[key] === U32_MAX) {
          if (q + 8 > p + 4 + size) throw new ZipError('truncated ZIP64 extra field');
          fields[key] = u64(v, q);
          q += 8;
        }
      }
      return fields;
    }
    p += 4 + size;
  }
  return fields;
}

/**
 * Locate the end of central directory (classic and ZIP64).
 * @returns {Promise<{cdOffset:number, cdSize:number, count:number, zip64:boolean}>}
 */
export async function readEndOfCentralDirectory(source) {
  const tailLen = Math.min(source.size, 22 + 0xffff + 20);
  const tailStart = source.size - tailLen;
  const tail = await source.read(tailStart, tailLen);
  const v = dv(tail);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (v.getUint32(i, true) === SIG_EOCD) {
      // Accept only if the comment length is consistent with the file end.
      if (i + 22 + v.getUint16(i + 20, true) <= tail.length) { at = i; break; }
    }
  }
  if (at < 0) throw new ZipError('Not a ZIP/3TZ file (end of central directory not found).');
  let count = v.getUint16(at + 10, true);
  let cdSize = v.getUint32(at + 12, true);
  let cdOffset = v.getUint32(at + 16, true);
  let zip64 = false;
  const needs64 = count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX;
  const locAt = at - 20;
  if (locAt >= 0 && v.getUint32(locAt, true) === SIG_EOCD64_LOCATOR) {
    const eocd64Offset = u64(v, locAt + 8);
    const rec = await source.read(eocd64Offset, 56);
    const r = dv(rec);
    if (r.getUint32(0, true) !== SIG_EOCD64) throw new ZipError('Corrupt ZIP64 end of central directory record.');
    count = u64(r, 32);
    cdSize = u64(r, 40);
    cdOffset = u64(r, 48);
    zip64 = true;
  } else if (needs64) {
    throw new ZipError('ZIP64 archive but the ZIP64 locator is missing.');
  }
  if (cdOffset + cdSize > source.size) throw new ZipError('Central directory lies outside the file (truncated download?).');
  return { cdOffset, cdSize, count, zip64 };
}

/** Parse central directory records from `bytes` (starting at a record boundary). */
export function parseCentralDirectory(bytes, maxCount = Infinity) {
  const v = dv(bytes);
  const entries = [];
  let p = 0;
  while (p + 46 <= bytes.length && entries.length < maxCount) {
    if (v.getUint32(p, true) !== SIG_CENTRAL) {
      if (entries.length === 0) throw new ZipError('Central directory record signature not found.');
      break;
    }
    const flags = v.getUint16(p + 8, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const fields = applyZip64Extra(bytes.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), {
      csize: v.getUint32(p + 20, true),
      usize: v.getUint32(p + 24, true),
      offset: v.getUint32(p + 42, true),
    });
    entries.push({
      name: decodeName(bytes.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0),
      flags,
      method: v.getUint16(p + 10, true),
      crc32: v.getUint32(p + 16, true),
      csize: fields.csize,
      usize: fields.usize,
      localOffset: fields.offset,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Read and parse the whole central directory. */
export async function readCentralDirectory(source, eocd) {
  const bytes = await source.read(eocd.cdOffset, eocd.cdSize);
  return parseCentralDirectory(bytes, eocd.count);
}

/**
 * Read only the LAST central directory record (where 3TZ writers put @3dtilesIndex1@),
 * without reading the whole directory (which can be tens of MB for big archives).
 */
export async function readLastCentralEntry(source, eocd, scanBytes = 4096) {
  const len = Math.min(eocd.cdSize, scanBytes);
  const start = eocd.cdOffset + eocd.cdSize - len;
  const bytes = await source.read(start, len);
  const v = dv(bytes);
  for (let i = bytes.length - 46; i >= 0; i--) {
    if (v.getUint32(i, true) !== SIG_CENTRAL) continue;
    const nameLen = v.getUint16(i + 28, true);
    const extraLen = v.getUint16(i + 30, true);
    const commentLen = v.getUint16(i + 32, true);
    if (i + 46 + nameLen + extraLen + commentLen !== bytes.length) continue; // must end exactly at CD end
    return parseCentralDirectory(bytes.subarray(i), 1)[0];
  }
  return null;
}

/** Parse the local file header at `offset`; returns where the entry data starts. */
export async function readLocalHeader(source, offset) {
  let head = await source.read(offset, Math.min(30 + 512, source.size - offset));
  let v = dv(head);
  if (head.length < 30 || v.getUint32(0, true) !== SIG_LOCAL) {
    throw new ZipError(`No local file header at offset ${offset}.`);
  }
  const nameLen = v.getUint16(26, true);
  const extraLen = v.getUint16(28, true);
  if (30 + nameLen + extraLen > head.length) {
    head = await source.read(offset, 30 + nameLen + extraLen);
    v = dv(head);
  }
  const flags = v.getUint16(6, true);
  const fields = applyZip64Extra(head.subarray(30 + nameLen, 30 + nameLen + extraLen), {
    csize: v.getUint32(18, true),
    usize: v.getUint32(22, true),
    offset: 0,
  });
  return {
    name: decodeName(head.subarray(30, 30 + nameLen), (flags & 0x800) !== 0),
    flags,
    method: v.getUint16(8, true),
    csize: fields.csize,
    usize: fields.usize,
    dataOffset: offset + 30 + nameLen + extraLen,
    // Bit 3: sizes are in a data descriptor after the data, so the local sizes are unusable.
    hasDataDescriptor: (flags & 0x8) !== 0,
  };
}

async function streamToBytes(stream) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('This browser lacks DecompressionStream, needed for compressed (DEFLATE) entries. Use a current Chrome, Edge or Firefox.');
  }
  return streamToBytes(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
}

export async function gunzip(bytes) {
  return streamToBytes(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
}

export const isGzip = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

/**
 * Read and decompress an entry's data.
 * @param {object} local result of readLocalHeader
 * @param {object} [central] central directory entry (authoritative sizes)
 */
export async function readEntryData(source, local, central) {
  if (local.flags & 0x1) throw new ZipError(`Entry "${local.name}" is encrypted; not supported.`);
  const csize = central ? central.csize : local.csize;
  const method = central ? central.method : local.method;
  if (!central && local.hasDataDescriptor && local.csize === 0) {
    throw new ZipError('sizes only in data descriptor; central directory needed');
  }
  const raw = await source.read(local.dataOffset, csize);
  if (raw.length !== csize) throw new ZipError(`Entry "${local.name}" is truncated.`);
  if (method === METHOD_STORED) return raw;
  if (method === METHOD_DEFLATE) return inflateRaw(raw);
  throw new ZipError(`Entry "${local.name}" uses compression method ${method} (only STORED and DEFLATE are supported). Re-export the archive with standard ZIP compression.`);
}
