// Main converter class for KF8/HUFF dictionaries.
class KF8Converter extends HuffCdicBase {
  constructor(buffer, options = {}) {
    super(buffer);
    this.options = { style: "nice", generateSyn: true, ...options };
    this.finalMap = new Map(); // word -> styled definition HTML
    this.synMap = new Map(); // alternate_form -> canonical_word
    this.entrySeen = new Map(); // word -> Set(fingerprint) for overlap dedupe
    this.synStats = {
      idxBlocks: 0,
      idxIformsSeen: 0,
      idxIformsAdded: 0,
      phraseTailAdded: 0,
    };
    this.detectedEntryFormat = null;
  }

  // FNV-1a 32-bit hash used for deduplication fingerprints.
  // Samples the full string up to 300 chars then includes the total length,
  // giving a practical collision probability < 0.1% for typical dictionaries.
  _defHash(s) {
    if (!s) return 0;
    const len = s.length;
    const cap = Math.min(len, 300);
    let h = 0x811c9dc5;
    for (let i = 0; i < cap; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    // Mix length so strings sharing the same prefix still differ.
    h ^= len;
    h = Math.imul(h, 0x01000193) >>> 0;
    return h || 1; // ensure non-zero (0 reserved as "empty/invalid")
  }

  _sanitizeEntryHtml(html) {
    if (!html) return html;
    // Fast-path: SJP2 and most header-block dicts use literal 'width="0"'.
    // String.replaceAll with a literal is ~10x faster than a regex for common cases.
    if (html.indexOf('width') === -1) return html;
    // Try the literal replacement first (covers most cases).
    html = html.replaceAll('width="0"', '').replaceAll("width='0'", '');
    // Fallback regex for other width= values (rare; e.g. width="-20", width="100%").
    if (html.indexOf('width') !== -1)
      html = html.replace(/\swidth\s*=\s*["'][^"']*["']/gi, "");
    return html;
  }

  _ingestEntry(word, def, synHtml = "") {
    if (!word || !def) return;
    const key = word.trim();
    if (!key) return;

    def = this._sanitizeEntryHtml(def);

    // Use a fast numeric hash instead of storing the full string in entrySeen.
    // This cuts ~400 MB of heap on large dictionaries (entrySeen previously
    // held a whitespace-normalised copy of every definition string).
    const fp = this._defHash(def);
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
      const merged = this.finalMap.get(key) + "<hr/>" + def;
      this.finalMap.set(key, merged);
    }

    this._collectSyns(key, synHtml || def);
  }

  _detectEntryFormat(html) {
    if (this.detectedEntryFormat) return this.detectedEntryFormat;

    if (/<idx:entry\b/i.test(html)) return "main";
    if (/<p\b[^>]*width\s*=\s*["']?-20/i.test(html)) return "main";

    const headerHeadCount = (
      html.match(/<h[1-3]\b[^>]*>\s*<b[^>]*>[\s\S]*?<\/b>\s*<\/h[1-3]>/gi) || []
    ).length;
    if (
      headerHeadCount >= 3 &&
      /<blockquote\b/i.test(html) &&
      /<hr\b/i.test(html)
    )
      return "header-block";

    if (/<h2\b/i.test(html)) return "main";
    return null;
  }

  // Extract entries from a HTML chunk (format-routed, legacy-safe)
  extractEntriesFrom(html, isFinal = false) {
    const detected = this._detectEntryFormat(html);
    if (detected && !this.detectedEntryFormat) {
      this.detectedEntryFormat = detected;
      addLog(
        this.t("logDetectedEntryFormat", "Detected entry format: {format}", {
          format: detected,
        }),
      );
    }

    if (this.detectedEntryFormat === "header-block") {
      this._extractEntriesHeaderBlocks(html, isFinal);
      return;
    }
    this._extractEntriesMain(html, isFinal);
  }

  // Main extractor (original logic for primary dictionary formats)
  _extractEntriesMain(html, isFinal = false) {
    const styleFn = STYLES[this.options.style] || STYLES.nice;

    // Method 1: KF8 idx:entry
    const entryRe = /<idx:entry\b[^>]*>([\s\S]*?)<\/idx:entry>/gi;
    let m;
    while ((m = entryRe.exec(html)) !== null) {
      const block = m[0];
      const orthM = block.match(/<idx:orth\b[^>]*>/i);
      if (!orthM) continue;
      const valueM = orthM[0].match(/\bvalue="([^"]+)"/i);
      if (!valueM) continue;
      const word = valueM[1].trim();
      if (!word || word.length >= 120) continue;
      let def = block
        .replace(/<idx:entry[^>]*>/gi, "")
        .replace(/<\/idx:entry>/gi, "")
        .replace(/<idx:orth[^>]*>[\s\S]*?<\/idx:orth>/gi, "")
        .replace(/<idx:infl[\s\S]*?<\/idx:infl>/gi, "")
        .trim();
      def = styleFn(word, `<span><b>${word}</b></span> ${def}`);
      // Keep raw idx block for synonym extraction (idx:iform inflections).
      this._ingestEntry(word, def, block);
    }

    // Method 2: h2-based (JEM / older Mobipocket dictionary style)
    const parts = html.split(/<h2\b/i);
    for (let k = 1; k < parts.length; k++) {
      const seg = parts[k];
      const tagEnd = seg.indexOf(">");
      if (tagEnd === -1) continue;
      const h2Close = seg.indexOf("</h2>", tagEnd);
      if (h2Close === -1) continue;

      const h2Content = seg.substring(tagEnd + 1, h2Close);
      const rawText = h2Content.replace(/<[^>]+>/g, "");
      const word = rawText.split("[")[0].trim();
      if (!word || word.length >= 100) continue;

      const after = seg.substring(h2Close + 5);
      const boundary = after.search(/<h2\b|<hr\b/i);
      if (!isFinal && boundary === -1) continue;

      const defContent = boundary >= 0 ? after.substring(0, boundary) : after;
      const rawHtml = `<h2>${h2Content}</h2>${defContent}`;
      const def = styleFn(word, rawHtml);
      this._ingestEntry(word, def, defContent);
    }

    // Method 3: <p width="-20"><span><b>headword</b></span>...</p>
    const hrParts = html.split(/<hr\s*\/?>/i);
    for (let k = 0; k < hrParts.length; k++) {
      const seg = hrParts[k];
      if (!/<p\b[^>]*width\s*=\s*["']?-20/i.test(seg)) continue;

      const pClose = seg.indexOf("</p>");
      if (!isFinal && pClose === -1) continue;

      const pOpen = seg.search(/<p\b[^>]*width\s*=\s*["']?-20/i);
      const pEnd = pClose >= 0 ? pClose + 4 : seg.length;
      if (pOpen < 0) continue;
      let pContent = seg.substring(pOpen, pEnd);

      // Defensive guard: reject overlap/boundary fragments unless headword starts the paragraph.
      const headAtStart = pContent.match(
        /^\s*<p\b[^>]*>\s*<span\s*>\s*<b>([\s\S]*?)<\/b>\s*<\/span>/i,
      );
      if (!headAtStart) continue;

      const headInner = headAtStart[1].trim();
      let word = "";
      if (headInner.includes("<")) {
        // Boundary-fragment paragraphs sometimes leak POS markup into the headword field.
        const plain = headInner
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const candidate = plain.split("/")[0].trim();
        if (!candidate || candidate.length >= 120) continue;
        if (
          /\/\s*(?:adj|adv|n|v|prep|conj|pron|interj|biol|fin|am)\.?\b/i.test(
            plain,
          )
        )
          continue;
        word = candidate;
        pContent = pContent.replace(
          /(^\s*<p\b[^>]*>\s*<span\s*>\s*<b>)[\s\S]*?(<\/b>\s*<\/span>)/i,
          `$1${word}$2`,
        );
      } else {
        word = headInner.replace(/\s+/g, " ").trim();
        if (
          /\/\s*(?:adj|adv|n|v|prep|conj|pron|interj|biol|fin|am)\.?\b/i.test(
            word,
          )
        )
          continue;
      }

      if (!word || word.length >= 120) continue;

      const def = styleFn(word, pContent);
      this._ingestEntry(word, def, pContent);
    }
  }

  _extractEntriesHeaderBlocks(html, isFinal = false) {
    const styleFn = STYLES[this.options.style] || STYLES.nice;
    const headRe = /<h([1-6])\b[^>]*>\s*<b[^>]*>([\s\S]*?)<\/b>\s*<\/h\1>/gi;
    const starts = [];
    let m;
    while ((m = headRe.exec(html)) !== null) {
      starts.push({ index: m.index, headInner: m[2] || "" });
    }

    for (let i = 0; i < starts.length; i++) {
      const s = starts[i];
      const headInner = (s.headInner || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!headInner || headInner.length > 120) continue;

      const blockStart = s.index;
      const blockEnd =
        i + 1 < starts.length ? starts[i + 1].index : html.length;

      if (!isFinal && i === starts.length - 1) break;

      let block = html.slice(blockStart, blockEnd);

      // Trim trailing <hr> separator (and optional trailing <div>) using lastIndexOf
      // instead of scanning the whole block with a regex from position 0.
      // This avoids O(|block|) regex scan on every entry and eliminates backtracking.
      const hrPos = block.lastIndexOf('<hr');
      if (hrPos !== -1) {
        const suffix = block.slice(hrPos);
        if (/^<hr\b[^>]*>\s*(?:<div\b[^>]*>\s*)?$/i.test(suffix)) {
          // Trim any leading whitespace before the <hr> too
          let cut = hrPos;
          while (cut > 0 && (block[cut-1] === ' ' || block[cut-1] === '\n' || block[cut-1] === '\r' || block[cut-1] === '\t')) cut--;
          block = block.slice(0, cut);
        }
      }
      block = block.trim();
      if (!block) continue;

      const def = styleFn(headInner, block);
      this._ingestEntry(headInner, def, block);
    }
  }

  // Synonym collection helper
  _collectSyns(canonicalWord, html) {
    if (!this.options.generateSyn) return;

    const normalizeCandidate = (raw) => {
      if (!raw) return "";
      return raw
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .normalize("NFKC")
        .replace(/^[\s,;:()\[\]{}"'`]+|[\s,;:()\[\]{}"'`]+$/g, "")
        .replace(/\s+/g, " ")
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
      const c = (candidate || "").toLowerCase();
      const b = (base || "").toLowerCase();
      if (!c || !b || c === b) return false;
      if (c === b + "s" || c === b + "ed" || c === b + "ing") return true;
      if (/(s|x|z|ch|sh|o)$/.test(b) && c === b + "es") return true;
      if (
        b.endsWith("y") &&
        b.length > 2 &&
        !/[aeiou]y$/.test(b) &&
        c === b.slice(0, -1) + "ies"
      )
        return true;
      return false;
    };

    // 1. Subscript-stripped variant: word1 / word2 -> word
    const stripped = canonicalWord
      .replace(/[\u2080-\u2089\u00B9\u00B2\u00B3\u2070]$/, "")
      .trim();
    if (
      stripped !== canonicalWord &&
      stripped.length > 1 &&
      !this.synMap.has(stripped)
    )
      this.synMap.set(stripped, canonicalWord);

    // 1b & 2: idx:iform and <span><b> patterns are only present in the KF8
    // "main" (idx:entry-based) format.  Skip entirely for header-block dicts
    // (e.g. SJP2) to avoid 600K+ pointless regex scans.
    const isHeaderBlock = this.detectedEntryFormat === "header-block";

    if (!isHeaderBlock) {
      // 1b. KF8 inflections from idx metadata, e.g. <idx:iform value="workers">
      if (/<idx:entry\b/i.test(html)) this.synStats.idxBlocks++;
      const extractIformValue = (attrs, inner) => {
        const vm = attrs.match(
          /\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i,
        );
        return vm ? vm[1] || vm[2] || vm[3] || "" : inner || "";
      };
      const iformPairRe = /<idx:iform\b([^>]*)>([\s\S]*?)<\/idx:iform>/gi;
      let ifm;
      while ((ifm = iformPairRe.exec(html)) !== null) {
        this.synStats.idxIformsSeen++;
        if (maybeAddSyn(extractIformValue(ifm[1] || "", ifm[2] || "")))
          this.synStats.idxIformsAdded++;
      }
      const iformSelfRe = /<idx:iform\b([^>]*)\/>/gi;
      while ((ifm = iformSelfRe.exec(html)) !== null) {
        this.synStats.idxIformsSeen++;
        if (maybeAddSyn(extractIformValue(ifm[1] || "", "")))
          this.synStats.idxIformsAdded++;
      }

      // 2. Sub-phrase <span><b>phrase</b></span> entries (multi-word or different from headword)
      for (const m of html.matchAll(
        /<span\s*>\s*<b>([\s\S]*?)<\/b>\s*<\/span>/gi,
      )) {
        const phrase = m[1].replace(/<[^>]+>/g, "").trim();
        if (!phrase || phrase.toLowerCase() === canonicalWord.toLowerCase())
          continue;
        if (phrase.length < 2 || phrase.length > 80) continue;
        if (!this.synMap.has(phrase)) this.synMap.set(phrase, canonicalWord);

        // Fallback for dictionaries that strip idx:iform metadata.
        const toks = phrase.split(/\s+/).filter(Boolean);
        if (toks.length >= 2) {
          const tail = toks[toks.length - 1].replace(
            /^[^A-Za-z0-9'-]+|[^A-Za-z0-9'-]+$/g,
            "",
          );
          if (looksLikeInflectionOf(tail, canonicalWord) && maybeAddSyn(tail))
            this.synStats.phraseTailAdded++;
        }
      }
    }

    // 3. Plural markers in parentheses, e.g. (<i>l.m.</i> <b>visionaries</b>)
    for (const m of html.matchAll(
      /\(\s*<i[^>]*>\s*(?:l\.?\s*m\.?|liczba\s+mnoga|plural|pl\.?)\s*<\/i>\s*<b[^>]*>([\s\S]*?)<\/b>\s*\)/gi,
    )) {
      maybeAddSyn(m[1]);
    }

    // 4. "tez X" / "also X" alternate forms
    for (const m of html.matchAll(
      /\((?:też|also)\s+<b[^>]*>([\s\S]*?)<\/b>/gi,
    )) {
      maybeAddSyn(m[1]);
    }

    // 5. Plain <b>X</b> where X looks like a compound (contains space)
    for (const m of html.matchAll(/<b[^>]*>([\s\S]*?)<\/b>/gi)) {
      const phrase = normalizeCandidate(m[1]);
      if (!phrase.includes(" ")) continue; // only multi-word
      if (phrase.toLowerCase() === canonicalWord.toLowerCase()) continue;
      if (phrase.length > 80 || /^\d/.test(phrase)) continue;
      if (!this.synMap.has(phrase)) this.synMap.set(phrase, canonicalWord);
    }
  }

  // Streaming decompress + extract
  streamDecompress(textRecordMax, extraFlags) {
    return new Promise((resolve) => {
      const utf8 = new TextDecoder("utf-8", { fatal: false });
      const OVERLAP = 16384;
      let overlap = "";
      let i = 1;
      const BATCH = 80;
      let firstDecodedLogged = false;
      const endExclusive = textRecordMax + 1;

      const processChunk = () => {
        const lim = Math.min(i + BATCH, endExclusive);
        for (; i < lim; i++) {
          const start = this.recs[i];
          const end =
            i + 1 < this.recs.length
              ? this.recs[i + 1]
              : this.buffer.byteLength;
          let data = this.raw.subarray(start, end);
          data = this.stripTrailing(data, extraFlags);
          const dec = this.decompress(data);
          const text = utf8.decode(dec, { stream: true });

          if (!firstDecodedLogged && text.length > 0) {
            firstDecodedLogged = true;
            const preview = text.substring(0, 300).replace(/[\r\n]+/g, " ");
            addLog(
              this.t(
                "logFirstRecordDecoded",
                "First record decoded ({bytes} bytes). Preview:\n  {preview}",
                { bytes: dec.length, preview },
              ),
            );
          }

          const chunk = overlap + text;
          this.extractEntriesFrom(chunk, false);
          overlap = chunk.length > OVERLAP ? chunk.slice(-OVERLAP) : chunk;
        }

        if (i < endExclusive) {
          if (i % 500 < BATCH)
            addLog(
              this.t(
                "logDecompressing",
                "Decompressing: {current}/{max}... entries so far: {entries}",
                {
                  current: i,
                  max: textRecordMax,
                  entries: this.finalMap.size,
                },
              ),
            );
          setTimeout(processChunk, 0);
        } else {
          this.extractEntriesFrom(overlap, true);
          addLog(
            this.t(
              "logExtractionComplete",
              "Extraction complete: {entries} unique entries.",
              { entries: this.finalMap.size },
            ),
          );
          resolve();
        }
      };
      processChunk();
    });
  }

  // Main pipeline
  async run() {
    this.buildRecords();
    addLog(
      this.t("logPdbRecords", "PDB records: {count}", {
        count: this.recs.length,
      }),
    );

    const extraFlags = this.findExtraDataFlags();

    // Find HUFF record
    let huffIdx = -1;
    for (let i = 0; i < this.recs.length; i++) {
      const o = this.recs[i];
      if (
        this.raw[o] === 72 &&
        this.raw[o + 1] === 85 &&
        this.raw[o + 2] === 70 &&
        this.raw[o + 3] === 70
      ) {
        huffIdx = i;
        break;
      }
    }
    if (huffIdx === -1) {
      addLog(this.t("logErrorNoHuff", "ERROR: No HUFF record found."));
      return this.finalMap;
    }
    const textRecordMax = this.getTextRecordMax(huffIdx);
    addLog(
      this.t(
        "logHuffRecord",
        "HUFF record: {huffIdx}  (text records: 1-{textRecordMax})",
        {
          huffIdx,
          textRecordMax,
        },
      ),
    );

    this.loadHuff(this.recs[huffIdx]);
    this.loadAllCdic(huffIdx);

    if (this.dict.length === 0) {
      addLog(
        this.t(
          "logErrorEmptySymbolDict",
          "ERROR: Symbol dictionary is empty. Cannot decompress.",
        ),
      );
      return this.finalMap;
    }

    await this.streamDecompress(textRecordMax, extraFlags);

    // ── MOBI binary INDX: extract inflected forms from ORTH+INFL indexes ────
    if (this.options.generateSyn) {
      try {
        addLog(this.t('logParsingMobiIndex', 'Parsing MOBI INDX inflection index...'));
        // parseMobiIndexes writes directly into synMap (via outputMap parameter),
        // so no merge loop is needed; inflAdded is reported via .size on the proxy.
        const result = this.parseMobiIndexes();
        if (result.size > 0) {
          addLog(this.t('logMobiIndexResult',
            'MOBI INDX: {added} new syn entries added.',
            { added: result.size }));
        } else {
          addLog(this.t('logMobiIndexNone', 'MOBI INDX: no ORTH/INFL index found (normal for non-SJP2 files).'));
        }
      } catch (e) {
        addLog('MOBI INDX parse skipped (non-fatal): ' + e.message);
      }
    }

    if (this.options.generateSyn) {
      addLog(
        this.t(
          "logSynStats",
          "idx:entry blocks seen: {idxBlocks}, idx:iform seen: {idxIformsSeen}, idx:iform added: {idxIformsAdded}, phrase-tail inflections: {phraseTailAdded}",
          {
            idxBlocks: this.synStats.idxBlocks,
            idxIformsSeen: this.synStats.idxIformsSeen,
            idxIformsAdded: this.synStats.idxIformsAdded,
            phraseTailAdded: this.synStats.phraseTailAdded,
          },
        ),
      );
    }
    addLog(
      this.t("logSynonymsCollected", "Synonyms collected: {count}", {
        count: this.synMap.size,
      }),
    );
    return { finalMap: this.finalMap, synMap: this.synMap };
  }
}
