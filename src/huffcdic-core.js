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
    // Flat TypedArrays for dict1 (256 entries, indexed by top 8 bits of code).
    // Using TypedArrays instead of an object array avoids pointer chasing in
    // the 33M-iteration decompression inner loop and fits in L1 cache.
    this.dict1Codelen = new Uint8Array(256);
    this.dict1Term    = new Uint8Array(256); // 1 = terminal, 0 = non-terminal
    this.dict1Maxcode = new Uint32Array(256);
    // min/max code arrays for non-terminal codeword lookup (indices 1..32).
    this.mincodeArr = new Uint32Array(33);
    this.maxcodeArr = new Uint32Array(33);
    this.dict = [];
    // Pre-allocated output buffer reused across top-level decompress() calls
    // (JS fallback path only; WASM path uses its own linear memory).
    this._decompOutBuf = new Uint8Array(131072);
  }

  // ── WASM acceleration ─────────────────────────────────────────────────────
  // _wasmBase64: base64-encoded huff-decoder.wasm binary (injected at build).
  // Set to null to disable WASM and always use the JS fallback.
  static _wasmBase64   = null;  // set by build-time injection
  static _wasmExports  = null;  // WebAssembly.Instance exports (shared)
  static _wasmMem      = null;  // Uint8Array view of WASM linear memory

  // Called once from run() after loadAllCdic(). Instantiates the WASM module
  // (once per session) and populates its linear memory with the HUFF tables
  // and CDIC phrase data for the current file.
  async _setupWasm() {
    const b64 = HuffCdicBase._wasmBase64;
    if (!b64) return; // WASM not embedded or previously disabled

    try {
      // Instantiate the module only once; subsequent files reuse the instance.
      if (!HuffCdicBase._wasmExports) {
        const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const { instance } = await WebAssembly.instantiate(bin, {});
        HuffCdicBase._wasmExports = instance.exports;
        HuffCdicBase._wasmMem    = new Uint8Array(instance.exports.mem.buffer);
      }
      const exp = HuffCdicBase._wasmExports;
      const mem = HuffCdicBase._wasmMem;

      // ── Copy HUFF tables into WASM memory ────────────────────────────────
      mem.set(this.dict1Codelen, exp.CL_OFF.value);
      mem.set(this.dict1Term,    exp.CT_OFF.value);
      mem.set(new Uint8Array(this.dict1Maxcode.buffer), exp.CM_OFF.value);
      mem.set(new Uint8Array(this.mincodeArr.buffer),   exp.MN_OFF.value);
      mem.set(new Uint8Array(this.maxcodeArr.buffer),   exp.MX_OFF.value);

      // ── Copy CDIC phrase data into WASM memory ────────────────────────────
      // Layout: cdicOffsets[i] (u32 LE) + cdicLengths[i] (u16 LE) + flat data.
      const DO_OFF = exp.DO_OFF.value;
      const DL_OFF = exp.DL_OFF.value;
      const DD_OFF = exp.DD_OFF.value;
      const DD_CAP = exp.DD_CAP.value;

      // Pre-flight: check the total phrase data fits in the WASM allocation.
      let totalData = 0;
      for (const p of this.dict) if (p) totalData += p.length;
      if (totalData > DD_CAP) {
        // Dictionary too large for WASM memory layout – fall back to JS.
        addLog('ℹ️  CDIC data exceeds WASM capacity – using JS fallback.');
        HuffCdicBase._wasmBase64 = null;
        return;
      }

      // Write offset table, length table and flat phrase bytes.
      const offView = new DataView(mem.buffer, DO_OFF);
      const lenView = new DataView(mem.buffer, DL_OFF);
      let dataOff = 0;
      for (let i = 0; i < this.dict.length; i++) {
        const phrase = this.dict[i];
        offView.setUint32(i * 4, dataOff, /*le=*/true);
        if (phrase && phrase.length > 0) {
          lenView.setUint16(i * 2, phrase.length, /*le=*/true);
          mem.set(phrase, DD_OFF + dataOff);
          dataOff += phrase.length;
        } else {
          lenView.setUint16(i * 2, 0, true);
        }
      }
      exp.setDictLen(this.dict.length);
    } catch (e) {
      // Any failure (old browser, unsupported WASM, etc.) → JS fallback.
      HuffCdicBase._wasmBase64 = null;
      HuffCdicBase._wasmExports = null;
    }
  }

  t(key, fallback, vars) {
    if (typeof i18nText === "function") return i18nText(key, fallback, vars);
    return String(fallback || key).replace(/\{(\w+)}/g, (_, k) =>
      vars && vars[k] !== undefined ? String(vars[k]) : `{${k}}`,
    );
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
      out = out.subarray(0, keep);
    }

    if (multibyte) {
      const tail = out.length ? out[out.length - 1] : 0;
      const num = (tail & 3) + 1;
      const keep = Math.max(0, out.length - num);
      out = out.subarray(0, keep);
    }

    return out;
  }

  _normalizeExtraDataFlags(raw, sourceLabel) {
    if (raw === 0xffff) {
      // For sentinel/noisy values, start in conservative mode immediately.
      addLog(
        this.t(
          "logExtraDataSentinel",
          "⚠️ {source}: ExtraDataFlags is 0xFFFF (sentinel/noisy), forcing conservative strip mode 0x1.",
          {
            source: sourceLabel,
          },
        ),
      );
      return 0x0001;
    }
    // MOBI ExtraDataFlags trailer layout uses low bits; high bits are often noisy/vendor-specific.
    const masked = raw & 0x001f;
    if (masked !== raw) {
      addLog(
        this.t(
          "logExtraDataMask",
          "⚠️ {source}: masking ExtraDataFlags 0x{from} -> 0x{to}",
          {
            source: sourceLabel,
            from: raw.toString(16),
            to: masked.toString(16),
          },
        ),
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
        this.t(
          "logTextRecordsClamp",
          "⚠️ text_records ({headerCount}) exceeds HUFF bound ({huffBound}); clamping.",
          {
            headerCount,
            huffBound,
          },
        ),
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
    const hdrLen  = this.u32(recBase + 0x14);
    const mobiVer = this.u32(recBase + 0x68);
    const encoding = hdrLen >= 0x10 ? this.u32(recBase + 0x1c) : 0;

    const verLabel = mobiVer >= 8 ? 'KF8' : mobiVer >= 6 ? 'MOBI6' : `MOBI${mobiVer}`;
    const encLabel = encoding === 65001 || encoding === 0
      ? 'UTF-8'
      : encoding === 1252 ? 'Windows-1252' : `encoding ${encoding}`;
    addLog(this.t('logMobiFormat', 'MOBI: {label} (v{ver}), encoding: {enc}',
      { label: verLabel, ver: mobiVer, enc: encLabel }));

    let flags = 0x0001;
    if (hdrLen >= 0xe4 && mobiVer >= 5) {
      const raw = this.u16(recBase + 0xf2);
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
            }
          }
        }
        pos += len;
      }
    }

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
      throw new Error(this.t("errInvalidHuffHeader", "invalid huff header"));
    }

    const off1 = this.u32(hOff + 8);
    const off2 = this.u32(hOff + 12);
    // Populate flat TypedArray tables (one entry per top-byte value 0-255).
    for (let i = 0; i < 256; i++) {
      const v = this.u32(hOff + off1 + i * 4);
      const codelen = v & 0x1f;
      const term = !!(v & 0x80);
      if (codelen === 0)
        throw new Error(
          this.t(
            "errInvalidHuffTableZeroCodeLen",
            "invalid huff table: zero codelen",
          ),
        );
      if (codelen <= 8 && !term)
        throw new Error(
          this.t(
            "errInvalidHuffTableShortNonTerminal",
            "invalid huff table: short non-terminal code",
          ),
        );
      const mxraw = (v >>> 8) >>> 0;
      const maxcode =
        Number((BigInt(mxraw + 1) << BigInt(32 - codelen)) - 1n) >>> 0;
      this.dict1Codelen[i] = codelen;
      this.dict1Term[i]    = term ? 1 : 0;
      this.dict1Maxcode[i] = maxcode;
    }
    this.mincodeArr = new Uint32Array(33);
    this.maxcodeArr = new Uint32Array(33);
    for (let i = 1; i <= 32; i++) {
      const rawMin = this.u32(hOff + off2 + (i - 1) * 8);
      const rawMax = this.u32(hOff + off2 + (i - 1) * 8 + 4);
      const shift = 32 - i;
      this.mincodeArr[i] = Number(BigInt(rawMin) << BigInt(shift)) >>> 0;
      this.maxcodeArr[i] =
        Number((BigInt(rawMax + 1) << BigInt(shift)) - 1n) >>> 0;
    }
    addLog(
      this.t("logHuffLoaded", "HUFF loaded. off1=0x{off1} off2=0x{off2}", {
        off1: off1.toString(16),
        off2: off2.toString(16),
      }),
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
      throw new Error(this.t("errInvalidCdicHeader", "invalid cdic header"));
    }

    const phrases = this.u32(rOff + 8);
    const bits = this.u32(rOff + 12);
    const n = Math.min(1 << bits, phrases - this.dict.length);
    for (let j = 0; j < n; j++) {
      const off = this.u16(rOff + 16 + j * 2);
      const blen = this.u16(rOff + 16 + off);
      const flag = !!(blen & 0x8000);
      const slen = blen & 0x7fff;
      const slice = this.raw.subarray(rOff + 18 + off, rOff + 18 + off + slen);
      // Store as [slice, flagBit] to defer expansion until loadAllCdic finishes.
      this.dict.push(flag ? slice : { slice, flag: false });
    }
  }

  // ── Load all consecutive CDIC records after a HUFF record ────────────────
  // After all records are loaded, pre-expand every non-terminal (compressed)
  // CDIC entry so the hot decompress loop only ever sees plain Uint8Arrays.
  // This eliminates the per-symbol flag check and {slice,flag} object wrapper
  // from ~33M inner-loop iterations, improving cache locality significantly.
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
    // Pre-expand all non-terminal entries (flag=false means still compressed).
    // After this loop, every this.dict[i] is a plain Uint8Array.
    const dict = this.dict;
    for (let i = 0; i < dict.length; i++) {
      const e = dict[i];
      if (e && !(e instanceof Uint8Array)) {
        // Guard against circular references: set null before recursing so any
        // re-entrant access to dict[i] hits the null-break and returns empty.
        dict[i] = null;
        dict[i] = this.decompress(e.slice, false);
      }
    }
    addLog(
      this.t(
        "logCdicLoaded",
        "Loaded {count} CDIC records -> {symbols} symbols in dictionary.",
        {
          count,
          symbols: this.dict.length,
        },
      ),
    );
  }

  // ── HUFF/CDIC decompression ────────────────────────────────────────────────
  // Hot-path optimisation: the original used BigInt for 64-bit bitstream
  // arithmetic. BigInt is ~10x slower than 32-bit integer ops in V8.
  // We represent the 64-bit sliding window as two 32-bit ints (hi, lo) and
  // compute the 32-bit code extraction with plain bitwise ops instead.
  //
  // We also eliminate the "padded" Uint8Array copy by using bounds-checked
  // reads of the raw data directly: the slow branch only fires for the last
  // ~4 reads per record, saving 53K allocations per conversion.
  //
  // dict1 is now stored as three flat Uint8/Uint32Arrays instead of an object
  // array, eliminating property-lookup overhead and pointer chasing in the
  // 33M-iteration inner loop.
  //
  // Top-level calls (isTopLevel = true, the default) write directly into a
  // pre-allocated this._decompOutBuf, returning a zero-copy subarray view.
  // This avoids 53K × (new Array chunks + new Uint8Array result + copy loop),
  // reducing ~212 MB of temporary allocations and major GC pressure.
  // Recursive calls (CDIC expansion) use the legacy chunks path and are rare.
  decompress(data, isTopLevel = true) {
    if (data.length === 0 || this.dict.length === 0) return new Uint8Array(0);

    // ── WASM fast path (top-level calls only) ────────────────────────────────
    // Pre-conditions: WASM is initialised and the input fits in the 8 KB input
    // buffer.  Recursive CDIC expansion always uses the JS path (isTopLevel=false),
    // but after _setupWasm() pre-expands all entries the recursive path is never
    // reached during normal decompression.
    if (isTopLevel && HuffCdicBase._wasmExports) {
      const exp = HuffCdicBase._wasmExports;
      const mem = HuffCdicBase._wasmMem;
      const IN_OFF  = exp.IN_OFF.value;
      const OUT_OFF = exp.OUT_OFF.value;
      if (data.length <= 8192) {
        mem.set(data, IN_OFF);
        const outLen = exp.decompress(data.length);
        if (outLen >= 0) return mem.subarray(OUT_OFF, OUT_OFF + outLen);
        // outLen < 0 means a fatal WASM error – fall through to JS path
      }
    }

    const dlen = data.length;

    // Read 4 bytes big-endian at byte offset p.
    // Fast path (p+3 < dlen): direct byte access.
    // Slow path (near end of data): byte-by-byte with zero padding.
    const read32 = (p) => {
      if (p + 3 < dlen) {
        return ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0;
      }
      return (
        ((p     < dlen ? data[p]     : 0) << 24) |
        ((p + 1 < dlen ? data[p + 1] : 0) << 16) |
        ((p + 2 < dlen ? data[p + 2] : 0) << 8)  |
         (p + 3 < dlen ? data[p + 3] : 0)
      ) >>> 0;
    };

    // Cache TypedArray references in locals to avoid repeated property lookups.
    const dict1Codelen = this.dict1Codelen;
    const dict1Term    = this.dict1Term;
    const dict1Maxcode = this.dict1Maxcode;
    const mincodeArr   = this.mincodeArr;
    const maxcodeArr   = this.maxcodeArr;
    const dict         = this.dict;

    let bitsleft = dlen * 8;
    let pos = 0;

    // Initialise 64-bit window as two big-endian uint32 halves.
    let hi = read32(0);
    let lo = read32(4);
    // n = bits remaining in the current "hi" half (1..32).
    let n = 32;

    if (isTopLevel) {
      // ── Fast path: write directly into the pre-allocated output buffer ──────
      // Avoids 53K × (chunks array + Uint8Array allocation + copy loop).
      // The caller immediately decodes the returned subarray to a string, so the
      // buffer is safe to reuse for the next record.
      let outBuf = this._decompOutBuf;
      let outLen = 0;

      while (true) {
        if (n <= 0) { pos += 4; hi = lo; lo = read32(pos + 4); n += 32; }
        const code = (n === 32) ? hi : (((hi << (32 - n)) | (lo >>> n)) >>> 0);
        const idx = code >>> 24;
        let codelen = dict1Codelen[idx];
        let maxcode = dict1Maxcode[idx];
        if (!dict1Term[idx]) {
          while (code < mincodeArr[codelen]) codelen++;
          maxcode = maxcodeArr[codelen];
        }
        n -= codelen; bitsleft -= codelen;
        if (bitsleft < 0) break;
        const r = ((maxcode - code) >>> (32 - codelen)) >>> 0;
        if (r >= dict.length) break;
        const slice = dict[r];
        if (!slice) break;
        const needed = outLen + slice.length;
        if (needed > outBuf.length) {
          // Grow the reusable buffer (rare: only if a record expands beyond 128 KB).
          const bigger = new Uint8Array(Math.max(outBuf.length * 2, needed));
          bigger.set(outBuf.subarray(0, outLen));
          outBuf = this._decompOutBuf = bigger;
        }
        outBuf.set(slice, outLen);
        outLen += slice.length;
      }
      return outBuf.subarray(0, outLen); // zero-copy view, valid until next call
    }

    // ── Legacy/recursive path: used only during CDIC expansion ─────────────
    const chunks = [];
    let outLen = 0;

    while (true) {
      if (n <= 0) { pos += 4; hi = lo; lo = read32(pos + 4); n += 32; }
      const code = (n === 32) ? hi : (((hi << (32 - n)) | (lo >>> n)) >>> 0);
      const idx = code >>> 24;
      let codelen = dict1Codelen[idx];
      let maxcode = dict1Maxcode[idx];
      if (!dict1Term[idx]) {
        while (code < mincodeArr[codelen]) codelen++;
        maxcode = maxcodeArr[codelen];
      }
      n -= codelen; bitsleft -= codelen;
      if (bitsleft < 0) break;
      const r = ((maxcode - code) >>> (32 - codelen)) >>> 0;
      if (r >= dict.length) break;
      let entry = dict[r];
      if (!entry) break;
      // During recursive CDIC expansion (called from loadAllCdic pre-expansion),
      // some entries may still be unexpanded objects. Expand them lazily here.
      if (!(entry instanceof Uint8Array)) {
        dict[r] = null;
        const expanded = this.decompress(entry.slice, false);
        entry = expanded;
        dict[r] = entry;
      }
      chunks.push(entry);
      outLen += entry.length;
    }

    const result = new Uint8Array(outLen);
    let off = 0;
    for (const c of chunks) { result.set(c, off); off += c.length; }
    return result;
  }

  // ── Parse MOBI ORTH+INFL binary indexes → inflection form map ──────────────
  // Delegates to the shared parseMobiIndexes() function (mobi-index-core.js).
  // ORDT decoding is handled inside parseMobiIndexes itself, so we do NOT pass
  // finalMap keys here – those are in HTML extraction order, not ORTH ordinal
  // order, and would cause wrong headword↔group mappings.
  //
  // synMap is passed as outputMap so inflected forms are written directly,
  // avoiding a large intermediate Map of 2M+ entries.
  parseMobiIndexes() {
    const synMap = this.synMap || null;
    return parseMobiIndexes(this.raw, this.recs, addLog, null, synMap);
  }
}
