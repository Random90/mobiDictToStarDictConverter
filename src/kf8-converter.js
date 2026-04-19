// Main converter class for KF8/HUFF dictionaries.
class KF8Converter extends HuffCdicBase {
    constructor(buffer, options = {}) {
        super(buffer);
        this.options  = { style: 'nice', generateSyn: true, ...options };
        this.finalMap = new Map();   // word -> styled definition HTML
        this.synMap   = new Map();   // alternate_form -> canonical_word
        this.entrySeen = new Map();  // word -> Set(fingerprint) for overlap dedupe
        this.synStats = { idxBlocks: 0, idxIformsSeen: 0, idxIformsAdded: 0, phraseTailAdded: 0 };
    }

    _sanitizeEntryHtml(html) {
        if (!html) return html;
        // Legacy Mobipocket width attributes on <p> are invalid in modern HTML output.
        return html.replace(/\swidth\s*=\s*["'][^"']*["']/gi, '');
    }

    _ingestEntry(word, def, synHtml = '') {
        if (!word || !def) return;
        const key = word.trim();
        if (!key) return;

        def = this._sanitizeEntryHtml(def);

        const fp = def.replace(/\s+/g, ' ').trim();
        if (!fp) return;

        let seen = this.entrySeen.get(key);
        if (!seen) {
            seen = new Set();
            this.entrySeen.set(key, seen);
        }
        if (seen.has(fp)) return;
        seen.add(fp);

        if (!this.finalMap.has(key)) {
            this.finalMap.set(key, def);
        } else {
            const merged = this.finalMap.get(key) + '<hr/>' + def;
            this.finalMap.set(key, merged);
        }

        this._collectSyns(key, synHtml || def);
    }

    // Extract entries from a HTML chunk (both idx:entry and h2 styles)
    extractEntriesFrom(html, isFinal = false) {
        const styleFn = STYLES[this.options.style] || STYLES.nice;

        // Method 1: KF8 idx:entry
        const entryRe = /<idx:entry\b[^>]*>([\s\S]*?)<\/idx:entry>/gi;
        let m;
        while ((m = entryRe.exec(html)) !== null) {
            const block  = m[0];
            const orthM  = block.match(/<idx:orth\b[^>]*>/i);
            if (!orthM) continue;
            const valueM = orthM[0].match(/\bvalue="([^"]+)"/i);
            if (!valueM) continue;
            const word = valueM[1].trim();
            if (!word || word.length >= 120) continue;
            let def = block
                .replace(/<idx:entry[^>]*>/gi, '')
                .replace(/<\/idx:entry>/gi, '')
                .replace(/<idx:orth[^>]*>[\s\S]*?<\/idx:orth>/gi, '')
                .replace(/<idx:infl[\s\S]*?<\/idx:infl>/gi, '')
                .trim();
            def = styleFn(word, `<span><b>${word}</b></span> ${def}`);
            // Keep raw idx block for synonym extraction (idx:iform inflections).
            this._ingestEntry(word, def, block);
        }

        // Method 2: h2-based (JEM / older Mobipocket dictionary style)
        const parts = html.split(/<h2\b/i);
        for (let k = 1; k < parts.length; k++) {
            const seg      = parts[k];
            const tagEnd   = seg.indexOf('>');
            if (tagEnd === -1) continue;
            const h2Close  = seg.indexOf('</h2>', tagEnd);
            if (h2Close === -1) continue;

            const h2Content = seg.substring(tagEnd + 1, h2Close);
            const rawText   = h2Content.replace(/<[^>]+>/g, '');
            const word      = rawText.split('[')[0].trim();
            if (!word || word.length >= 100) continue;

            const after    = seg.substring(h2Close + 5);
            const boundary = after.search(/<h2\b|<hr\b/i);
            if (!isFinal && boundary === -1) continue;

            const defContent = boundary >= 0 ? after.substring(0, boundary) : after;
            const rawHtml    = `<h2>${h2Content}</h2>${defContent}`;
            const def        = styleFn(word, rawHtml);
            this._ingestEntry(word, def, defContent);
        }

        // Method 3: <p width="-20"><span><b>headword</b></span>...</p>
        const hrParts = html.split(/<hr\s*\/?>/i);
        for (let k = 0; k < hrParts.length; k++) {
            const seg = hrParts[k];
            if (!/<p\b[^>]*width\s*=\s*["']?-20/i.test(seg)) continue;

            const pClose = seg.indexOf('</p>');
            if (!isFinal && pClose === -1) continue;

            const pOpen    = seg.search(/<p\b[^>]*width\s*=\s*["']?-20/i);
            const pEnd     = pClose >= 0 ? pClose + 4 : seg.length;
            if (pOpen < 0) continue;
            let pContent = seg.substring(pOpen, pEnd);

            // Defensive guard: reject overlap/boundary fragments unless headword starts the paragraph.
            const headAtStart = pContent.match(/^\s*<p\b[^>]*>\s*<span\s*>\s*<b>([\s\S]*?)<\/b>\s*<\/span>/i);
            if (!headAtStart) continue;

            const headInner = headAtStart[1].trim();
            let word = '';
            if (headInner.includes('<')) {
                // Boundary-fragment paragraphs sometimes leak POS markup into the headword field.
                const plain = headInner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                const candidate = plain.split('/')[0].trim();
                if (!candidate || candidate.length >= 120) continue;
                if (/\/\s*(?:adj|adv|n|v|prep|conj|pron|interj|biol|fin|am)\.?\b/i.test(plain)) continue;
                word = candidate;
                pContent = pContent.replace(
                    /(^\s*<p\b[^>]*>\s*<span\s*>\s*<b>)[\s\S]*?(<\/b>\s*<\/span>)/i,
                    `$1${word}$2`
                );
            } else {
                word = headInner.replace(/\s+/g, ' ').trim();
                if (/\/\s*(?:adj|adv|n|v|prep|conj|pron|interj|biol|fin|am)\.?\b/i.test(word)) continue;
            }

            if (!word || word.length >= 120) continue;

            const def = styleFn(word, pContent);
            this._ingestEntry(word, def, pContent);
        }
    }

    // Synonym collection helper
    _collectSyns(canonicalWord, html) {
        if (!this.options.generateSyn) return;

        const normalizeCandidate = (raw) => {
            if (!raw) return '';
            return raw
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/gi, ' ')
                .replace(/&amp;/gi, '&')
                .replace(/&quot;/gi, '"')
                .replace(/&#39;/gi, "'")
                .normalize('NFKC')
                .replace(/^[\s,;:()\[\]{}"'`]+|[\s,;:()\[\]{}"'`]+$/g, '')
                .replace(/\s+/g, ' ')
                .trim();
        };

        const maybeAddSyn = (candidate) => {
            const alt = normalizeCandidate(candidate);
            if (!alt) return false;
            if (alt.length < 2 || alt.length > 80) return false;
            if (/^\d+$/.test(alt)) return false;
            if (alt.toLowerCase() === canonicalWord.toLowerCase()) return false;
            if (!this.synMap.has(alt)) {
                this.synMap.set(alt, canonicalWord);
                return true;
            }
            return false;
        };

        const looksLikeInflectionOf = (candidate, base) => {
            const c = (candidate || '').toLowerCase();
            const b = (base || '').toLowerCase();
            if (!c || !b || c === b) return false;
            if (c === b + 's' || c === b + 'ed' || c === b + 'ing') return true;
            if (/(s|x|z|ch|sh|o)$/.test(b) && c === b + 'es') return true;
            if (b.endsWith('y') && b.length > 2 && !/[aeiou]y$/.test(b) && c === b.slice(0, -1) + 'ies') return true;
            return false;
        };

        // 1. Subscript-stripped variant: word1 / word2 -> word
        const stripped = canonicalWord.replace(/[\u2080-\u2089\u00B9\u00B2\u00B3\u2070]$/, '').trim();
        if (stripped !== canonicalWord && stripped.length > 1 && !this.synMap.has(stripped))
            this.synMap.set(stripped, canonicalWord);

        // 1b. KF8 inflections from idx metadata, e.g. <idx:iform value="workers">
        if (/<idx:entry\b/i.test(html)) this.synStats.idxBlocks++;
        const extractIformValue = (attrs, inner) => {
            const vm = attrs.match(/\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
            return vm ? (vm[1] || vm[2] || vm[3] || '') : (inner || '');
        };
        const iformPairRe = /<idx:iform\b([^>]*)>([\s\S]*?)<\/idx:iform>/gi;
        let ifm;
        while ((ifm = iformPairRe.exec(html)) !== null) {
            this.synStats.idxIformsSeen++;
            if (maybeAddSyn(extractIformValue(ifm[1] || '', ifm[2] || ''))) this.synStats.idxIformsAdded++;
        }
        const iformSelfRe = /<idx:iform\b([^>]*)\/>/gi;
        while ((ifm = iformSelfRe.exec(html)) !== null) {
            this.synStats.idxIformsSeen++;
            if (maybeAddSyn(extractIformValue(ifm[1] || '', ''))) this.synStats.idxIformsAdded++;
        }

        // 2. Sub-phrase <span><b>phrase</b></span> entries (multi-word or different from headword)
        for (const m of html.matchAll(/<span\s*>\s*<b>([\s\S]*?)<\/b>\s*<\/span>/gi)) {
            const phrase = m[1].replace(/<[^>]+>/g, '').trim();
            if (!phrase || phrase.toLowerCase() === canonicalWord.toLowerCase()) continue;
            if (phrase.length < 2 || phrase.length > 80) continue;
            if (!this.synMap.has(phrase)) this.synMap.set(phrase, canonicalWord);

            // Fallback for dictionaries that strip idx:iform metadata: derive tail inflection from phrases.
            // Example: "core workers" -> add "workers" as alias of "worker".
            const toks = phrase.split(/\s+/).filter(Boolean);
            if (toks.length >= 2) {
                const tail = toks[toks.length - 1].replace(/^[^A-Za-z0-9'-]+|[^A-Za-z0-9'-]+$/g, '');
                if (looksLikeInflectionOf(tail, canonicalWord) && maybeAddSyn(tail)) this.synStats.phraseTailAdded++;
            }
        }

        // 3. Plural markers in parentheses, e.g. (<i>l.m.</i> <b>visionaries</b>)
        for (const m of html.matchAll(/\(\s*<i[^>]*>\s*(?:l\.?\s*m\.?|liczba\s+mnoga|plural|pl\.?)\s*<\/i>\s*<b[^>]*>([\s\S]*?)<\/b>\s*\)/gi)) {
            maybeAddSyn(m[1]);
        }

        // 4. "tez X" / "also X" alternate forms
        for (const m of html.matchAll(/\((?:też|also)\s+<b[^>]*>([\s\S]*?)<\/b>/gi)) {
            maybeAddSyn(m[1]);
        }

        // 5. Plain <b>X</b> where X looks like a compound (contains space)
        for (const m of html.matchAll(/<b[^>]*>([\s\S]*?)<\/b>/gi)) {
            const phrase = normalizeCandidate(m[1]);
            if (!phrase.includes(' ')) continue;          // only multi-word
            if (phrase.toLowerCase() === canonicalWord.toLowerCase()) continue;
            if (phrase.length > 80 || /^\d/.test(phrase)) continue;
            if (!this.synMap.has(phrase)) this.synMap.set(phrase, canonicalWord);
        }
    }

    // Streaming decompress + extract
    streamDecompress(textRecordMax, extraFlags) {
        return new Promise(resolve => {
            const utf8    = new TextDecoder('utf-8', { fatal: false });
            const OVERLAP = 16384;
            let   overlap = '';
            let   i       = 1;
            const BATCH   = 80;
            let   firstDecodedLogged = false;
            const endExclusive = textRecordMax + 1;

            const processChunk = () => {
                const lim = Math.min(i + BATCH, endExclusive);
                for (; i < lim; i++) {
                    const start = this.recs[i];
                    const end   = (i + 1 < this.recs.length) ? this.recs[i + 1] : this.buffer.byteLength;
                    let   data  = this.raw.slice(start, end);
                    data        = this.stripTrailing(data, extraFlags);
                    const dec   = this.decompress(data);
                    const text  = utf8.decode(dec, { stream: true });

                    if (!firstDecodedLogged && text.length > 0) {
                        firstDecodedLogged = true;
                        const preview = text.substring(0, 300).replace(/[\r\n]+/g, ' ');
                        addLog(`First record decoded (${dec.length} bytes). Preview:\n  ${preview}`);
                    }

                    const chunk = overlap + text;
                    this.extractEntriesFrom(chunk, false);
                    overlap = chunk.length > OVERLAP ? chunk.slice(-OVERLAP) : chunk;
                }

                if (i < endExclusive) {
                    if ((i % 500) < BATCH)
                        addLog(`Decompressing: ${i}/${textRecordMax}... entries so far: ${this.finalMap.size}`);
                    setTimeout(processChunk, 0);
                } else {
                    this.extractEntriesFrom(overlap, true);
                    addLog(`Extraction complete: ${this.finalMap.size} unique entries.`);
                    resolve();
                }
            };
            processChunk();
        });
    }

    // Main pipeline
    async run() {
        this.buildRecords();
        addLog(`PDB records: ${this.recs.length}`);

        const extraFlags = this.findExtraDataFlags();

        // Find HUFF record
        let huffIdx = -1;
        for (let i = 0; i < this.recs.length; i++) {
            const o = this.recs[i];
            if (this.raw[o]===72 && this.raw[o+1]===85 && this.raw[o+2]===70 && this.raw[o+3]===70) {
                huffIdx = i; break;
            }
        }
        if (huffIdx === -1) { addLog('ERROR: No HUFF record found.'); return this.finalMap; }
        const textRecordMax = this.getTextRecordMax(huffIdx);
        addLog(`HUFF record: ${huffIdx}  (text records: 1-${textRecordMax})`);

        this.loadHuff(this.recs[huffIdx]);
        this.loadAllCdic(huffIdx);

        if (this.dict.length === 0) {
            addLog('ERROR: Symbol dictionary is empty. Cannot decompress.');
            return this.finalMap;
        }

        await this.streamDecompress(textRecordMax, extraFlags);
        if (this.options.generateSyn) {
            addLog(`idx:entry blocks seen: ${this.synStats.idxBlocks}, idx:iform seen: ${this.synStats.idxIformsSeen}, idx:iform added: ${this.synStats.idxIformsAdded}, phrase-tail inflections: ${this.synStats.phraseTailAdded}`);
        }
        addLog(`Synonyms collected: ${this.synMap.size}`);
        return { finalMap: this.finalMap, synMap: this.synMap };
    }
}

