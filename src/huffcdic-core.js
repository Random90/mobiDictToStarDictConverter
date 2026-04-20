// ─────────────────────────────────────────────────────────────────────────────
// HuffCdicBase – shared HUFF/CDIC decompression logic
// Used by mobiKF8HuffConverter.html and Tools/MobiReader-Huff-KF8.html
// DO NOT edit the compiled HTML files directly – edit this file and the
// templates, then run:  node build.js
// ─────────────────────────────────────────────────────────────────────────────
class HuffCdicBase {
  constructor(buffer) {
    this.buffer = buffer;
    this.raw = new Uint8Array(buffer);
    this.recs = [];
    this.dict1 = [];
    this.mincodeArr = new Array(33).fill(0);
    this.maxcodeArr = new Array(33).fill(0);
    this.dict = [];
  }

  _stripTrailingWithFlags(data, flags) {
    // KindleUnpack parity: count trailer entries from set bits > 0 and trim one entry per count.
    const multibyte = flags & 1;
    let trailers = 0;
    let tmp = flags >>> 1;
    while (tmp > 0) {
      if (tmp & 1) trailers++;
      tmp >>>= 1;
    }

    const getSizeOfTrailingDataEntry = (buf) => {
      if (buf.length === 0) return 0;
      let num = 0;
      const start = Math.max(0, buf.length - 4);
      for (let i = start; i < buf.length; i++) {
        const v = buf[i];
        if (v & 0x80) num = 0;
        num = ((num << 7) | (v & 0x7f)) >>> 0;
      }
      return num;
    };

    let out = data;
    for (let i = 0; i < trailers; i++) {
      const num = getSizeOfTrailingDataEntry(out);
      const keep = Math.max(0, out.length - num);
      out = out.slice(0, keep);
    }

    if (multibyte) {
      const tail = out.length ? out[out.length - 1] : 0;
      const num = (tail & 3) + 1;
      const keep = Math.max(0, out.length - num);
      out = out.slice(0, keep);
    }

    return out;
  }

  _normalizeExtraDataFlags(raw, sourceLabel) {
    if (raw === 0xffff) {
      // For sentinel/noisy values, start in conservative mode immediately.
      addLog(
        `⚠️ ${sourceLabel}: ExtraDataFlags is 0xFFFF (sentinel/noisy), forcing conservative strip mode 0x1.`,
      );
      return 0x0001;
    }
    // MOBI ExtraDataFlags trailer layout uses low bits; high bits are often noisy/vendor-specific.
    const masked = raw & 0x001f;
    if (masked !== raw) {
      addLog(
        `⚠️ ${sourceLabel}: masking ExtraDataFlags 0x${raw.toString(16)} -> 0x${masked.toString(16)}`,
      );
    }
    return masked || 0x0001;
  }

  // ── Low-level readers ─────────────────────────────────────────────────────
  u32(o) {
    const r = this.raw;
    return ((r[o] << 24) | (r[o + 1] << 16) | (r[o + 2] << 8) | r[o + 3]) >>> 0;
  }
  u16(o) {
    return ((this.raw[o] << 8) | this.raw[o + 1]) >>> 0;
  }

  _getRecord0Base() {
    const r0 = this.recs[0];
    let mobi = r0 + 16;
    if (
      !(
        this.raw[mobi] === 0x4d &&
        this.raw[mobi + 1] === 0x4f &&
        this.raw[mobi + 2] === 0x42 &&
        this.raw[mobi + 3] === 0x49
      )
    ) {
      mobi = r0;
    }
    return mobi === r0 + 16 ? r0 : mobi;
  }

  // PalmDOC text_records is the authoritative end of text payload.
  getTextRecordMax(huffIdx) {
    const recBase = this._getRecord0Base();
    const headerCount = this.u16(recBase + 0x08);
    const huffBound = Math.max(0, huffIdx - 1);

    if (!headerCount) return huffBound;
    if (headerCount > huffBound) {
      addLog(
        `⚠️ text_records (${headerCount}) exceeds HUFF bound (${huffBound}); clamping.`,
      );
      return huffBound;
    }
    return headerCount;
  }

  // ── PDB record list ───────────────────────────────────────────────────────
  // Populates this.recs with file offsets and returns the array.
  buildRecords() {
    const n = this.u16(76);
    this.recs = [];
    for (let i = 0; i < n; i++) this.recs.push(this.u32(78 + i * 8));
    return this.recs;
  }

  // ── Find ExtraDataFlags ───────────────────────────────────────────────────
  // KindleUnpack-parity lookup for pure and hybrid KF8 files (EXTH tag 121 boundary override).
  findExtraDataFlags() {
    const recs = this.recs;
    const recBase = this._getRecord0Base();

    // KindleUnpack header offsets are relative to the record start (PalmDOC + MOBI block).
    const hdrLen = this.u32(recBase + 0x14);
    const mobiType = this.u32(recBase + 0x18);
    const mobiVer = this.u32(recBase + 0x68);
    addLog(
      `Record 0: MOBI type=${mobiType}, headerLen=0x${hdrLen.toString(16)}`,
    );

    let flags = 0x0001;
    if (hdrLen >= 0xe4 && mobiVer >= 5) {
      const raw = this.u16(recBase + 0xf2);
      addLog(
        `ExtraDataFlags from MOBI header (offset 0xF2): 0x${raw.toString(16)}`,
      );
      flags = this._normalizeExtraDataFlags(raw, "MOBI header");
    }

    // EXTH tag 121 points to the KF8 boundary; when present, use KF8 section flags.
    const exthOff = recBase + 16 + hdrLen;
    if (
      this.raw[exthOff] === 0x45 &&
      this.raw[exthOff + 1] === 0x58 &&
      this.raw[exthOff + 2] === 0x54 &&
      this.raw[exthOff + 3] === 0x48
    ) {
      const exthLen = this.u32(exthOff + 4);
      const numRec = this.u32(exthOff + 8);
      let pos = exthOff + 12;

      for (let i = 0; i < numRec && pos + 8 <= exthOff + exthLen; i++) {
        const tag = this.u32(pos);
        const len = this.u32(pos + 4);
        if (tag === 121 && len === 12) {
          const kf8Bound = this.u32(pos + 8);
          addLog(`KF8 boundary record: ${kf8Bound}`);
          const kf8RecIdx = kf8Bound + 1;
          if (kf8RecIdx < recs.length) {
            const kf8Off = recs[kf8RecIdx];
            let kf8Mobi = kf8Off + 16;
            if (
              !(
                this.raw[kf8Mobi] === 0x4d &&
                this.raw[kf8Mobi + 1] === 0x4f &&
                this.raw[kf8Mobi + 2] === 0x42 &&
                this.raw[kf8Mobi + 3] === 0x49
              )
            )
              kf8Mobi = kf8Off;
            const kf8Base = kf8Mobi === kf8Off + 16 ? kf8Off : kf8Mobi;
            const kl = this.u32(kf8Base + 0x14);
            const kv = this.u32(kf8Base + 0x68);
            if (kl >= 0xe4 && kv >= 5) {
              const raw = this.u16(kf8Base + 0xf2);
              flags = this._normalizeExtraDataFlags(raw, "KF8 override");
              addLog(`KF8 section flags override: 0x${flags.toString(16)}`);
            }
          }
        }
        pos += len;
      }
    }

    addLog(`Final ExtraDataFlags: 0x${flags.toString(16)}`);
    return flags;
  }

  // ── Strip trailing bytes ───────────────────────────────────────────────────
  stripTrailing(data, flags) {
    if (!flags || data.length === 0) return data;
    return this._stripTrailingWithFlags(data, flags);
  }

  // ── Load HUFF record ──────────────────────────────────────────────────────
  loadHuff(hOff) {
    if (
      this.raw[hOff] !== 0x48 ||
      this.raw[hOff + 1] !== 0x55 ||
      this.raw[hOff + 2] !== 0x46 ||
      this.raw[hOff + 3] !== 0x46 ||
      this.raw[hOff + 4] !== 0x00 ||
      this.raw[hOff + 5] !== 0x00 ||
      this.raw[hOff + 6] !== 0x00 ||
      this.raw[hOff + 7] !== 0x18
    ) {
      throw new Error("invalid huff header");
    }

    const off1 = this.u32(hOff + 8);
    const off2 = this.u32(hOff + 12);
    this.dict1 = [];
    for (let i = 0; i < 256; i++) {
      const v = this.u32(hOff + off1 + i * 4);
      const codelen = v & 0x1f;
      const term = !!(v & 0x80);
      if (codelen === 0) throw new Error("invalid huff table: zero codelen");
      if (codelen <= 8 && !term)
        throw new Error("invalid huff table: short non-terminal code");
      const mxraw = (v >>> 8) >>> 0;
      const maxcode =
        Number((BigInt(mxraw + 1) << BigInt(32 - codelen)) - 1n) >>> 0;
      this.dict1.push({ codelen, term, maxcode });
    }
    this.mincodeArr = new Array(33).fill(0);
    this.maxcodeArr = new Array(33).fill(0);
    for (let i = 1; i <= 32; i++) {
      const rawMin = this.u32(hOff + off2 + (i - 1) * 8);
      const rawMax = this.u32(hOff + off2 + (i - 1) * 8 + 4);
      const shift = 32 - i;
      this.mincodeArr[i] = Number(BigInt(rawMin) << BigInt(shift)) >>> 0;
      this.maxcodeArr[i] =
        Number((BigInt(rawMax + 1) << BigInt(shift)) - 1n) >>> 0;
    }
    addLog(
      `HUFF loaded. off1=0x${off1.toString(16)} off2=0x${off2.toString(16)}`,
    );
  }

  // ── Load one CDIC record ──────────────────────────────────────────────────
  loadCdic(rOff) {
    if (
      this.raw[rOff] !== 0x43 ||
      this.raw[rOff + 1] !== 0x44 ||
      this.raw[rOff + 2] !== 0x49 ||
      this.raw[rOff + 3] !== 0x43 ||
      this.raw[rOff + 4] !== 0x00 ||
      this.raw[rOff + 5] !== 0x00 ||
      this.raw[rOff + 6] !== 0x00 ||
      this.raw[rOff + 7] !== 0x10
    ) {
      throw new Error("invalid cdic header");
    }

    const phrases = this.u32(rOff + 8);
    const bits = this.u32(rOff + 12);
    const n = Math.min(1 << bits, phrases - this.dict.length);
    for (let j = 0; j < n; j++) {
      const off = this.u16(rOff + 16 + j * 2);
      const blen = this.u16(rOff + 16 + off);
      const flag = !!(blen & 0x8000);
      const slen = blen & 0x7fff;
      const slice = this.raw.slice(rOff + 18 + off, rOff + 18 + off + slen);
      this.dict.push({ slice, flag });
    }
  }

  // ── Load all consecutive CDIC records after a HUFF record ────────────────
  loadAllCdic(huffIdx) {
    const recs = this.recs;
    let count = 0;
    for (let i = huffIdx + 1; i < recs.length; i++) {
      const rOff = recs[i];
      const magic = String.fromCharCode(
        this.raw[rOff],
        this.raw[rOff + 1],
        this.raw[rOff + 2],
        this.raw[rOff + 3],
      );
      if (magic !== "CDIC") break;
      this.loadCdic(rOff);
      count++;
    }
    addLog(
      `Loaded ${count} CDIC records → ${this.dict.length} symbols in dictionary.`,
    );
  }

  // ── HUFF/CDIC decompression ────────────────────────────────────────────────
  decompress(data) {
    if (data.length === 0 || this.dict.length === 0) return new Uint8Array(0);

    const padded = new Uint8Array(data.length + 8);
    padded.set(data);

    const readU64 = (p) => {
      let x = 0n;
      for (let i = 0; i < 8; i++) x = (x << 8n) | BigInt(padded[p + i]);
      return x;
    };

    let bitsleft = data.length * 8;
    let pos = 0;
    let x = readU64(0);
    let n = 32;

    const chunks = [];
    let outLen = 0;

    while (true) {
      if (n <= 0) {
        pos += 4;
        x = readU64(pos);
        n += 32;
      }

      const code = Number((x >> BigInt(n)) & 0xffffffffn) >>> 0;

      const e = this.dict1[code >>> 24];
      let codelen = e.codelen;
      let maxcode = e.maxcode;

      if (!e.term) {
        while (code < this.mincodeArr[codelen]) codelen++;
        maxcode = this.maxcodeArr[codelen];
      }

      n -= codelen;
      bitsleft -= codelen;
      if (bitsleft < 0) break;

      const r = ((maxcode - code) >>> (32 - codelen)) >>> 0;
      if (r >= this.dict.length) break;

      let entry = this.dict[r];
      if (!entry) break;
      if (!entry.flag) {
        // KindleUnpack sets temporary None sentinel before recursive expansion.
        this.dict[r] = null;
        const expanded = this.decompress(entry.slice);
        entry = { slice: expanded, flag: true };
        this.dict[r] = entry;
      }
      chunks.push(entry.slice);
      outLen += entry.slice.length;
    }

    const result = new Uint8Array(outLen);
    let off = 0;
    for (const c of chunks) {
      result.set(c, off);
      off += c.length;
    }
    return result;
  }
}
