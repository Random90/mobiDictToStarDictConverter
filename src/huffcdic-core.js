// ─────────────────────────────────────────────────────────────────────────────
// HuffCdicBase – shared HUFF/CDIC decompression logic
// Used by mobiKF8HuffConverter.html and Tools/MobiReader-Huff-KF8.html
// DO NOT edit the compiled HTML files directly – edit this file and the
// templates, then run:  node build.js
// ─────────────────────────────────────────────────────────────────────────────
class HuffCdicBase {
    constructor(buffer) {
        this.buffer      = buffer;
        this.raw         = new Uint8Array(buffer);
        this.recs        = [];
        this.dict1       = [];
        this.mincodeArr  = new Array(33).fill(0);
        this.maxcodeArr  = new Array(33).fill(0);
        this.dict        = [];
    }

    // ── Low-level readers ─────────────────────────────────────────────────────
    u32(o) { const r = this.raw; return ((r[o]<<24)|(r[o+1]<<16)|(r[o+2]<<8)|r[o+3]) >>> 0; }
    u16(o) { return ((this.raw[o]<<8)|this.raw[o+1]) >>> 0; }

    // ── PDB record list ───────────────────────────────────────────────────────
    // Populates this.recs with file offsets and returns the array.
    buildRecords() {
        const n = this.u16(76);
        this.recs = [];
        for (let i = 0; i < n; i++) this.recs.push(this.u32(78 + i * 8));
        return this.recs;
    }

    // ── Find ExtraDataFlags ───────────────────────────────────────────────────
    // Works for both hybrid KF8 (EXTH tag 535 override) and pure KF8 files.
    findExtraDataFlags() {
        const recs = this.recs;
        const r0 = recs[0];
        let mobi = r0 + 16;
        if (!(this.raw[mobi]===0x4D && this.raw[mobi+1]===0x4F &&
              this.raw[mobi+2]===0x42 && this.raw[mobi+3]===0x49)) {
            mobi = r0;
        }

        const hdrLen   = this.u32(mobi + 4);
        const mobiType = this.u32(mobi + 8);
        addLog(`Record 0: MOBI type=${mobiType}, headerLen=0x${hdrLen.toString(16)}`);

        let flags = 0x0001;
        if (hdrLen >= 0xF4) {
            const raw = this.u16(mobi + 0xF2);
            addLog(`ExtraDataFlags from MOBI header (offset 0xF2): 0x${raw.toString(16)}`);
            flags = (raw <= 0x001F) ? raw : 0x0001;
            if (raw > 0x001F) addLog(`⚠️ Suspicious flags (0x${raw.toString(16)}), capping to 0x0001`);
        }

        // Check EXTH tag 535 – overrides for hybrid files
        const exthOff = mobi + hdrLen;
        if (this.raw[exthOff]===0x45 && this.raw[exthOff+1]===0x58 &&
            this.raw[exthOff+2]===0x54 && this.raw[exthOff+3]===0x48) {

            const exthLen = this.u32(exthOff + 4);
            const numRec  = this.u32(exthOff + 8);
            let   pos     = exthOff + 12;

            for (let i = 0; i < numRec && pos + 8 <= exthOff + exthLen; i++) {
                const tag = this.u32(pos);
                const len = this.u32(pos + 4);
                if (tag === 535 && len === 12) {
                    const kf8Bound  = this.u32(pos + 8);
                    addLog(`KF8 boundary record: ${kf8Bound}`);
                    const kf8RecIdx = kf8Bound + 1;
                    if (kf8RecIdx < recs.length) {
                        const kf8Off  = recs[kf8RecIdx];
                        let   kf8Mobi = kf8Off + 16;
                        if (!(this.raw[kf8Mobi]===0x4D && this.raw[kf8Mobi+1]===0x4F &&
                              this.raw[kf8Mobi+2]===0x42 && this.raw[kf8Mobi+3]===0x49))
                            kf8Mobi = kf8Off;
                        const kl = this.u32(kf8Mobi + 4);
                        if (kl >= 0xF4) {
                            flags = this.u16(kf8Mobi + 0xF2);
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
        let trim = 0;
        for (let j = 0; j < 15; j++) {
            if ((flags >> (j + 1)) & 1) {
                let size = 0;
                let pos  = data.length - 1 - trim;
                let v    = data[pos], shift = 7;
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

    // ── Load HUFF record ──────────────────────────────────────────────────────
    loadHuff(hOff) {
        const off1 = this.u32(hOff + 8);
        const off2 = this.u32(hOff + 12);
        this.dict1 = [];
        for (let i = 0; i < 256; i++) {
            const v       = this.u32(hOff + off1 + i * 4);
            const codelen = v & 0x1F;
            const term    = !!(v & 0x80);
            const mxraw   = (v >>> 8) >>> 0;
            const maxcode = Number((BigInt(mxraw + 1) << BigInt(32 - codelen)) - 1n) >>> 0;
            this.dict1.push({ codelen, term, maxcode });
        }
        this.mincodeArr = new Array(33).fill(0);
        this.maxcodeArr = new Array(33).fill(0);
        for (let i = 1; i <= 32; i++) {
            const rawMin = this.u32(hOff + off2 + (i - 1) * 8);
            const rawMax = this.u32(hOff + off2 + (i - 1) * 8 + 4);
            const shift  = 32 - i;
            this.mincodeArr[i] = Number(BigInt(rawMin) << BigInt(shift)) >>> 0;
            this.maxcodeArr[i] = Number((BigInt(rawMax + 1) << BigInt(shift)) - 1n) >>> 0;
        }
        addLog(`HUFF loaded. off1=0x${off1.toString(16)} off2=0x${off2.toString(16)}`);
    }

    // ── Load one CDIC record ──────────────────────────────────────────────────
    loadCdic(rOff) {
        const phrases = this.u32(rOff + 8);
        const bits    = this.u32(rOff + 12);
        const n       = Math.min(1 << bits, phrases - this.dict.length);
        for (let j = 0; j < n; j++) {
            const off   = this.u16(rOff + 16 + j * 2);
            const blen  = this.u16(rOff + 16 + off);
            const flag  = !!(blen & 0x8000);
            const slen  = blen & 0x7FFF;
            const slice = this.raw.slice(rOff + 18 + off, rOff + 18 + off + slen);
            this.dict.push({ slice, flag });
        }
    }

    // ── Load all consecutive CDIC records after a HUFF record ────────────────
    loadAllCdic(huffIdx) {
        const recs = this.recs;
        let count = 0;
        for (let i = huffIdx + 1; i < recs.length; i++) {
            const rOff  = recs[i];
            const magic = String.fromCharCode(this.raw[rOff], this.raw[rOff+1], this.raw[rOff+2], this.raw[rOff+3]);
            if (magic !== 'CDIC') break;
            this.loadCdic(rOff);
            count++;
        }
        addLog(`Loaded ${count} CDIC records → ${this.dict.length} symbols in dictionary.`);
    }

    // ── HUFF/CDIC decompression ────────────────────────────────────────────────
    decompress(data) {
        if (data.length === 0 || this.dict.length === 0) return new Uint8Array(0);

        const padded = new Uint8Array(data.length + 8);
        padded.set(data);

        const readU32 = (p) =>
            ((padded[p]<<24)|(padded[p+1]<<16)|(padded[p+2]<<8)|padded[p+3]) >>> 0;

        let bitsleft = data.length * 8;
        let pos = 0;
        let xhi = readU32(0);
        let xlo = readU32(4);
        let n   = 32;

        const getCode = () => {
            if (n === 32) return xhi;
            return (((xhi << (32 - n)) >>> 0) | (xlo >>> n)) >>> 0;
        };

        const advance = () => {
            pos += 4;
            xhi  = xlo;
            xlo  = (pos + 4 < padded.length) ? readU32(pos + 4) : 0;
            n   += 32;
        };

        const chunks = [];
        let outLen = 0;

        while (true) {
            if (n <= 0) advance();
            const code = getCode();

            const e     = this.dict1[code >>> 24];
            let codelen = e.codelen;
            let maxcode = e.maxcode;

            if (!e.term) {
                while (code < this.mincodeArr[codelen]) codelen++;
                maxcode = this.maxcodeArr[codelen];
            }

            n        -= codelen;
            bitsleft -= codelen;
            if (bitsleft < 0) break;
            if (n <= 0) advance();

            const r = ((maxcode - code) >>> (32 - codelen)) >>> 0;
            if (r >= this.dict.length) break;

            let entry = this.dict[r];
            if (!entry.flag) {
                const expanded = this.decompress(entry.slice);
                entry = { slice: expanded, flag: true };
                this.dict[r] = entry;
            }
            chunks.push(entry.slice);
            outLen += entry.slice.length;
        }

        const result = new Uint8Array(outLen);
        let off = 0;
        for (const c of chunks) { result.set(c, off); off += c.length; }
        return result;
    }
}

