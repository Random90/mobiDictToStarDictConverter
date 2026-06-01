// stardict-dictzip-core.js
// Produces and reads dictzip (.dict.dz) files for use with StarDict.
//
// Dictzip is a gzip-compatible format that stores a random-access index
// (the "RA" extra field) in the gzip header.  The compressed payload is a
// single raw DEFLATE stream where each chunk boundary is byte-aligned via
// Z_SYNC_FLUSH, exactly as the reference `dictzip` C tool produces.
//
// Compression relies on pako (embedded at build time via @@include).
// Decompression uses the browser's native DecompressionStream API.
//
// Gzip format: RFC 1952  |  DEFLATE: RFC 1951
// Reference dictzip tool: https://linux.die.net/man/1/dictzip

// ---------------------------------------------------------------------------
// Public API – Compression
// ---------------------------------------------------------------------------

/**
 * Compress `data` (Uint8Array) into a proper dictzip stream.
 *
 * Uses pako.Deflate with Z_SYNC_FLUSH between chunks so the output is a
 * single valid raw DEFLATE stream with byte-aligned chunk boundaries,
 * matching the format produced by the reference dictzip C tool.
 *
 * @param {Uint8Array} data        – raw uncompressed bytes
 * @param {function}  [onProgress] – optional (done, total) progress callback
 * @returns {Promise<Uint8Array>}  – the .dict.dz file content
 */
async function compressDictzip(data, onProgress) {
  // Standard dictzip chunk length (must fit in uint16).
  const CHUNK_SIZE = 58315;

  // pako flush-mode constants (same numeric values as zlib)
  const Z_SYNC_FLUSH = 2; // byte-align + emit empty stored block (00 00 ff ff)
  const Z_FINISH = 4; // finalize stream with BFINAL=1

  // ── 1. Split into chunks ─────────────────────────────────────────────────
  const rawChunks = [];
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    rawChunks.push(data.subarray(i, Math.min(i + CHUNK_SIZE, data.length)));
  }
  if (rawChunks.length === 0) rawChunks.push(new Uint8Array(0));

  // ── 2. Compress with pako into ONE continuous raw DEFLATE stream ──────────
  // Non-last chunks: Z_SYNC_FLUSH  → appends "00 00 ff ff" sync marker,
  //                                  keeps deflate context alive for next chunk.
  // Last chunk:      Z_FINISH      → writes final block (BFINAL=1), ends stream.
  const deflator = new pako.Deflate({ level: 6, raw: true });
  const outputParts = [];
  const chunkSizes = [];
  let totalOutput = 0;

  deflator.onData = (part) => {
    outputParts.push(part);
    totalOutput += part.length;
  };

  for (let i = 0; i < rawChunks.length; i++) {
    const isLast = i === rawChunks.length - 1;
    const before = totalOutput;
    deflator.push(rawChunks[i], isLast ? Z_FINISH : Z_SYNC_FLUSH);
    if (deflator.err) throw new Error("Dictzip deflate error: " + deflator.msg);
    chunkSizes.push(totalOutput - before);
    if (onProgress) onProgress(i + 1, rawChunks.length);
  }

  // Validate: each SIZE entry must fit in uint16 (max 65535 bytes).
  for (let i = 0; i < chunkSizes.length; i++) {
    if (chunkSizes[i] > 65535) {
      throw new Error(
        `Compressed chunk ${i} is ${chunkSizes[i]} bytes – exceeds uint16 limit.`,
      );
    }
  }

  // Assemble compressed payload
  const compressedData = new Uint8Array(totalOutput);
  let pos = 0;
  for (const p of outputParts) {
    compressedData.set(p, pos);
    pos += p.length;
  }

  // ── 3. Build gzip header with RA extra field ──────────────────────────────
  //
  // FLG = FEXTRA(0x04) | FNAME(0x08) = 0x0c  (same as reference dictzip tool)
  // OS  = 0x03  (Unix)
  //
  // RA subfield layout (all values little-endian uint16):
  //   SI1='R' SI2='A'  LEN(2)  VER=1(2)  CHLEN(2)  CHCNT(2)  SIZE[i](2)×CHCNT
  //
  const fname = "dictionary.dict"; // null-terminated filename (like reference)
  const fnameBytes = new TextEncoder().encode(fname); // without null
  const raDataLen = 2 + 2 + 2 + 2 * rawChunks.length; // VER+CHLEN+CHCNT+sizes
  const extraLen = 4 + raDataLen; // SI1+SI2+LEN(2)+raDataLen
  // gzip fixed header(10) + XLEN(2) + extra(extraLen) + fname + NUL(1)
  const headerLen = 10 + 2 + extraLen + fnameBytes.length + 1;

  const header = new Uint8Array(headerLen);
  const hv = new DataView(header.buffer);
  let hp = 0;

  hv.setUint8(hp++, 0x1f); // ID1
  hv.setUint8(hp++, 0x8b); // ID2
  hv.setUint8(hp++, 0x08); // CM = deflate
  hv.setUint8(hp++, 0x0c); // FLG = FEXTRA | FNAME
  hv.setUint32(hp, 0, true);
  hp += 4; // MTIME = 0
  hv.setUint8(hp++, 0x02); // XFL = max compression
  hv.setUint8(hp++, 0x03); // OS  = Unix

  hv.setUint16(hp, extraLen, true);
  hp += 2; // XLEN

  // RA extra sub-field
  hv.setUint8(hp++, 0x52); // SI1 = 'R'
  hv.setUint8(hp++, 0x41); // SI2 = 'A'
  hv.setUint16(hp, raDataLen, true);
  hp += 2; // LEN
  hv.setUint16(hp, 1, true);
  hp += 2; // VER = 1
  hv.setUint16(hp, CHUNK_SIZE, true);
  hp += 2; // CHLEN
  hv.setUint16(hp, rawChunks.length, true);
  hp += 2; // CHCNT
  for (const sz of chunkSizes) {
    hv.setUint16(hp, sz, true);
    hp += 2; // SIZE[i]
  }

  // FNAME (null-terminated)
  header.set(fnameBytes, hp);
  hp += fnameBytes.length;
  hv.setUint8(hp++, 0x00); // NUL terminator

  // ── 4. gzip trailer: CRC32(4 LE) + ISIZE(4 LE) ───────────────────────────
  const crc = _crc32(data);
  const trailer = new Uint8Array(8);
  const tv = new DataView(trailer.buffer);
  tv.setUint32(0, crc, true);
  tv.setUint32(4, data.length >>> 0, true);

  // ── 5. Assemble ───────────────────────────────────────────────────────────
  const total = header.length + compressedData.length + trailer.length;
  const result = new Uint8Array(total);
  pos = 0;
  result.set(header, pos);
  pos += header.length;
  result.set(compressedData, pos);
  pos += compressedData.length;
  result.set(trailer, pos);

  return result;
}

// ---------------------------------------------------------------------------
// Public API – Decompression  (used by the validator to read .dict.dz files)
// ---------------------------------------------------------------------------

/**
 * Decompress a dictzip or plain-gzip buffer back to its original bytes.
 *
 * Handles:
 *  • Proper dictzip (.dict.dz with RA extra field) – the compressed payload
 *    is a single raw DEFLATE stream; decompressed in one shot.
 *  • Plain gzip (.dict.gz / .dict.dz without RA field) – uses
 *    DecompressionStream("gzip") for the whole stream.
 *  • Uncompressed – returns the input buffer unchanged.
 *
 * @param {ArrayBuffer} buffer  – raw bytes of the .dict.dz file
 * @returns {Promise<ArrayBuffer>} – the decompressed dict data
 */
async function decompressDictzip(buffer) {
  const bytes = new Uint8Array(buffer);

  // Not gzip → return as-is
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return buffer;
  }

  // ── Parse gzip header ─────────────────────────────────────────────────────
  const flg = bytes[3];
  const FEXTRA = 0x04;
  const FNAME = 0x08;
  const FCOMMENT = 0x10;
  const FHCRC = 0x02;

  let pos = 10;
  let hasRA = false;

  if (flg & FEXTRA) {
    const xlen = bytes[pos] | (bytes[pos + 1] << 8);
    pos += 2;
    const extraEnd = pos + xlen;
    let ep = pos;
    while (ep + 4 <= extraEnd) {
      const si1 = bytes[ep];
      const si2 = bytes[ep + 1];
      const subLen = bytes[ep + 2] | (bytes[ep + 3] << 8);
      if (si1 === 0x52 && si2 === 0x41) hasRA = true; // 'R' 'A'
      ep += 4 + subLen;
    }
    pos = extraEnd;
  }

  if (flg & FNAME) {
    while (pos < bytes.length && bytes[pos] !== 0) pos++;
    pos++;
  }
  if (flg & FCOMMENT) {
    while (pos < bytes.length && bytes[pos] !== 0) pos++;
    pos++;
  }
  if (flg & FHCRC) {
    pos += 2;
  }

  // Compressed payload sits between header end and the 8-byte gzip trailer
  const compressedPayload = bytes.subarray(pos, bytes.length - 8);

  if (hasRA) {
    // Dictzip: the payload is ONE continuous raw DEFLATE stream.
    // Decompress the whole payload at once.
    const sizeMB = (compressedPayload.length / 1048576).toFixed(1);
    return (await _inflateRaw(compressedPayload)).buffer;
  } else {
    // Plain gzip (no RA field) – decompress as a complete gzip stream.
    return await _decompressGzip(buffer);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Decompress a raw DEFLATE stream using the browser DecompressionStream API. */
async function _inflateRaw(data) {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(data);
  writer.close();
  const parts = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(totalLen);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

/** Decompress a standard gzip stream using the browser DecompressionStream API. */
async function _decompressGzip(buffer) {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(new Uint8Array(buffer));
  writer.close();
  const parts = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(totalLen);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out.buffer;
}

/** Standard CRC-32 (ISO 3309 / ITU-T V.42) as required by RFC 1952 gzip. */
function _crc32(data) {
  if (!_crc32._table) {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    _crc32._table = t;
  }
  const table = _crc32._table;
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
