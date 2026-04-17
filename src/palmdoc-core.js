// ─────────────────────────────────────────────────────────────────────────────
// PalmDocBase – shared PalmDoc decompression logic
// Used by mobi7PalmDocConverter.html and Tools/MobiReader-PalmDoc.html
// DO NOT edit the compiled HTML files directly – edit this file and the
// templates, then run:  node build.js
// ─────────────────────────────────────────────────────────────────────────────
class PalmDocBase {
    constructor(buffer) {
        this.buffer  = buffer;
        this.view    = new DataView(buffer);
        this.records = [];      // array of { offset }
        this.extraFlags = 0;
    }

    // ── Build record list and read ExtraDataFlags from MOBI header ────────────
    buildRecords() {
        const numRecords = this.view.getUint16(76);
        this.records = [];
        for (let i = 0; i < numRecords; i++)
            this.records.push({ offset: this.view.getUint32(78 + i * 8) });
        this.extraFlags = this.view.getUint16(this.records[0].offset + 0xF2);
        return numRecords;
    }

    // ── Strip trailing bytes as specified by ExtraDataFlags ───────────────────
    stripTrailing(data, flags) {
        if (!flags || data.length === 0) return data;
        let trim = 0;
        for (let j = 0; j < 15; j++) {
            if ((flags >> (j + 1)) & 1) {
                let size = 0, pos = data.length - 1 - trim;
                let v = data[pos], shift = 7;
                size = v & 0x7F;
                while ((v & 0x80) === 0 && pos > 0) {
                    v = data[--pos];
                    size |= (v & 0x7F) << shift;
                    shift += 7;
                }
                trim += size;
            }
        }
        if (flags & 1) trim += (data[data.length - 1 - trim] & 3) + 1;
        return (trim > 0 && trim < data.length) ? data.slice(0, data.length - trim) : data;
    }

    // ── PalmDoc LZ77 decompression ────────────────────────────────────────────
    decompressPalmDoc(data) {
        let out = [];
        for (let j = 0; j < data.length; j++) {
            let b = data[j];
            if (b >= 1 && b <= 8) {
                for (let k = 0; k < b; k++) out.push(data[++j]);
            } else if (b <= 127) {
                out.push(b);
            } else if (b >= 192) {
                out.push(32);
                out.push(b ^ 128);
            } else if (b >= 128 && b <= 191) {
                let next = data[++j];
                let dist = (((b << 8) | next) >> 3) & 0x7FF;
                let len  = (next & 7) + 3;
                let s    = out.length - dist;
                if (s >= 0) for (let k = 0; k < len; k++) out.push(out[s + k]);
            } else {
                out.push(b);
            }
        }
        return new Uint8Array(out);
    }

    // ── Read, strip, and decompress a single record; return UTF-8 string ──────
    getRecordText(idx) {
        if (idx < 1 || idx >= this.records.length) return '';
        const start = this.records[idx].offset;
        const end   = this.records[idx + 1] ? this.records[idx + 1].offset : this.buffer.byteLength;
        let data = new Uint8Array(this.buffer.slice(start, end));
        data = this.stripTrailing(data, this.extraFlags);
        const out = this.decompressPalmDoc(data);
        return new TextDecoder('utf-8').decode(out);
    }
}

