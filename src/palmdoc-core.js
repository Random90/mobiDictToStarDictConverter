// ─────────────────────────────────────────────────────────────────────────────
// PalmDocBase – shared PalmDoc decompression logic
// Used by mobi7PalmDocConverter.html and Tools/MobiReader-PalmDoc.html
// DO NOT edit the compiled HTML files directly – edit this file and the
// templates, then run:  node build.js
// ─────────────────────────────────────────────────────────────────────────────
class PalmDocBase {
  constructor(buffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.records = []; // array of { offset }
    this.extraFlags = 0;
  }

  // ── Build record list and read ExtraDataFlags from MOBI header ────────────
  buildRecords() {
    const numRecords = this.view.getUint16(76);
    this.records = [];
    for (let i = 0; i < numRecords; i++)
      this.records.push({ offset: this.view.getUint32(78 + i * 8) });
    this.extraFlags = this.view.getUint16(this.records[0].offset + 0xf2);
    return numRecords;
  }

  // ── Strip trailing bytes as specified by ExtraDataFlags ───────────────────
  stripTrailing(data, flags) {
    if (!flags || data.length === 0) return data;
    let trim = 0;
    for (let j = 0; j < 15; j++) {
      if ((flags >> (j + 1)) & 1) {
        let size = 0,
          pos = data.length - 1 - trim;
        let v = data[pos],
          shift = 7;
        size = v & 0x7f;
        while ((v & 0x80) === 0 && pos > 0) {
          v = data[--pos];
          size |= (v & 0x7f) << shift;
          shift += 7;
        }
        trim += size;
      }
    }
    if (flags & 1) trim += (data[data.length - 1 - trim] & 3) + 1;
    return trim > 0 && trim < data.length
      ? data.subarray(0, data.length - trim)
      : data;
  }

  // ── PalmDoc LZ77 decompression ────────────────────────────────────────────
  decompressPalmDoc(data) {
    // Pre-allocate worst-case output (PalmDoc records expand to at most 4096
    // bytes, but we allocate generously).  Using a typed array + index counter
    // avoids the overhead of Array.push() + the final Array→Uint8Array copy.
    const out = new Uint8Array(data.length * 8 + 256);
    let outLen = 0;
    for (let j = 0; j < data.length; j++) {
      let b = data[j];
      if (b >= 1 && b <= 8) {
        for (let k = 0; k < b; k++) out[outLen++] = data[++j];
      } else if (b <= 127) {
        out[outLen++] = b;
      } else if (b >= 192) {
        out[outLen++] = 32;
        out[outLen++] = b ^ 128;
      } else if (b >= 128 && b <= 191) {
        let next = data[++j];
        let dist = (((b << 8) | next) >> 3) & 0x7ff;
        let len = (next & 7) + 3;
        let s = outLen - dist;
        if (s >= 0) for (let k = 0; k < len; k++) out[outLen++] = out[s + k];
      } else {
        out[outLen++] = b;
      }
    }
    return out.subarray(0, outLen);
  }

  // ── Read, strip, and decompress a single record; return UTF-8 string ──────
  getRecordText(idx) {
    if (idx < 1 || idx >= this.records.length) return "";
    const start = this.records[idx].offset;
    const end = this.records[idx + 1]
      ? this.records[idx + 1].offset
      : this.buffer.byteLength;
    let data = new Uint8Array(this.buffer, start, end - start);
    data = this.stripTrailing(data, this.extraFlags);
    const out = this.decompressPalmDoc(data);
    return new TextDecoder("utf-8").decode(out);
  }

  // ── Parse MOBI ORTH+INFL binary indexes → inflection form map ──────────────
  // Delegates to the shared parseMobiIndexes() function (mobi-index-core.js).
  // ORDT decoding is handled inside parseMobiIndexes itself, so we do NOT pass
  // finalMap keys here – those are in HTML extraction order, not ORTH ordinal
  // order, and would cause wrong headword↔group mappings.
  parseMobiIndexes(outputMap) {
    const raw = new Uint8Array(this.buffer);
    const offsets = this.records.map(r => r.offset);
    const logFn = typeof addLog === 'function' ? addLog : (typeof this.log === 'function' ? this.log : null);
    return parseMobiIndexes(raw, offsets, logFn, null, outputMap);
  }
}
