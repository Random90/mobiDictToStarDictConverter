// Converter: extends PalmDocBase with dictionary extraction logic.
class Converter extends PalmDocBase {
  constructor(buffer, options, logFn) {
    super(buffer);
    this.options = options;
    this.log = logFn;
    this.encoder = new TextEncoder();
    this.finalMap = new Map(); // word -> definition HTML
    this.synMap = new Map(); // alternate_form -> canonical_word
  }

  async run() {
    const numRecords = this.buildRecords();
    this.log(
      `Source detected. Extra Data Flags: 0x${this.extraFlags.toString(16)}`,
    );
    this.log("Step 1: Extracting text from MOBI records...");
    const html = await this.extractAsync(numRecords);
    this.log("Step 2: Running extraction engines...");
    this.parseDictionary(html);
    return { finalMap: this.finalMap, synMap: this.synMap };
  }

  extractAsync(numRecords) {
    return new Promise((resolve) => {
      let fullHtml = "";
      const decoder = new TextDecoder("utf-8");
      let i = 1;
      const processChunk = () => {
        const limit = Math.min(i + 1500, numRecords);
        for (; i < limit; i++) {
          const start = this.records[i].offset;
          const end =
            i + 1 < numRecords
              ? this.records[i + 1].offset
              : this.buffer.byteLength;
          let data = new Uint8Array(this.buffer.slice(start, end));
          data = this.stripTrailing(data, this.extraFlags);
          if (data.length === 0) continue;
          fullHtml += decoder.decode(this.decompressPalmDoc(data));
        }
        if (i < numRecords) {
          this.log(`Extracted ${i}/${numRecords} records...`);
          setTimeout(processChunk, 0);
        } else {
          resolve(fullHtml);
        }
      };
      processChunk();
    });
  }

  parseDictionary(html) {
    this.log("Parsing structure...");
    const fmt = this.detectDictionaryFormat(html);
    this.log(`Detected entry format: ${fmt}`);
    if (fmt === "hr-bold") {
      this.log("Detected alternate HR/B parser format.");
      this.parseDictionaryHrBold(html);
      return;
    }
    this.parseDictionaryMain(html);
  }

  detectDictionaryFormat(html) {
    const h2Count = (html.match(/<h2\b/gi) || []).length;
    if (h2Count >= 20) return "main";

    const hrCount = (html.match(/<hr\b/gi) || []).length;
    if (hrCount < 100) return "main";

    const boldHeadCount = (html.match(
      /(?:^|<hr\b[^>]*>)\s*<b[^>]*>[^<]{1,120}<\/b>\s*<br\s*\/?>/gi,
    ) || []).length;

    if (boldHeadCount >= 100) return "hr-bold";
    return "main";
  }

  _ingestEntry(word, contentHtml, styleFn, phonetics = "", rawHeadHtml = "") {
    if (!word || word.length >= 100) return;

    const safeHead = rawHeadHtml || `<h2>${word}</h2>`;
    const entryHtml = styleFn(word, phonetics, safeHead, contentHtml);

    if (this.options.merge && this.finalMap.has(word)) {
      this.finalMap.set(
        word,
        this.finalMap.get(word) + '<hr style="margin:4px 0">' + entryHtml,
      );
    } else {
      this.finalMap.set(word, entryHtml);
    }

    this._collectSynonyms(word, contentHtml);
  }

  _collectSynonyms(word, contentHtml) {
    if (!this.options.generateSyn) return;

    const stripped = word.replace(/[\u2080-\u2089\u00B9\u00B2\u00B3]$/, "").trim();
    if (stripped !== word && stripped.length > 1 && !this.synMap.has(stripped)) {
      this.synMap.set(stripped, word);
    }

    const bMatches = contentHtml.matchAll(/<b>([^<]{3,70})<\/b>/g);
    for (const m of bMatches) {
      const phrase = m[1].trim();
      if (phrase.toLowerCase() === word.toLowerCase()) continue;
      if (phrase.length < 3 || phrase.length > 80) continue;
      if (/^\d+$/.test(phrase)) continue;
      if (!this.synMap.has(phrase)) this.synMap.set(phrase, word);
    }

    const tezRe = /\((?:też|also)\s+<b>([^<]{2,60})<\/b>/gi;
    for (const m of contentHtml.matchAll(tezRe)) {
      const alt = m[1].trim();
      if (alt && alt !== word && !this.synMap.has(alt)) this.synMap.set(alt, word);
    }
  }

  parseDictionaryMain(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const h2Entries = doc.querySelectorAll("h2");
    this.log(`Found ${h2Entries.length} headwords.`);

    const styleFn = STYLES[this.options.style] || STYLES.nice;

    h2Entries.forEach((h2) => {
      const rawHeader = h2.textContent;
      const phonMatch = rawHeader.match(/\[([^\]]+)\]/);
      const phonetics = phonMatch ? phonMatch[1] : "";
      const word = rawHeader.split("[")[0].trim();
      if (!word || word.length >= 100) return;

      // Collect sibling content until next H2/HR
      let contentHtml = "";
      let next = h2.nextSibling;
      while (next && next.tagName !== "H2" && next.tagName !== "HR") {
        contentHtml += next.outerHTML || next.textContent || "";
        next = next.nextSibling;
      }

      this._ingestEntry(word, contentHtml, styleFn, phonetics, h2.outerHTML);
    });

    this.log(
      `Entries: ${this.finalMap.size}. Synonyms collected: ${this.synMap.size}.`,
    );
  }

  parseDictionaryHrBold(html) {
    const styleFn = STYLES[this.options.style] || STYLES.nice;
    const parts = html.split(/<hr\b[^>]*>/i);
    let found = 0;

    for (const seg of parts) {
      const m = seg.match(/^\s*<b[^>]*>([\s\S]*?)<\/b>\s*<br\s*\/?>/i);
      if (!m) continue;

      const word = (m[1] || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!word || word.length >= 100) continue;

      let contentHtml = seg.slice(m.index + m[0].length);
      contentHtml = contentHtml.replace(/^(?:\s*<br\s*\/?>)+/i, "").trim();

      found++;
      this._ingestEntry(word, contentHtml, styleFn, "", `<h2>${word}</h2>`);
    }

    this.log(`Found ${found} headwords.`);
    this.log(
      `Entries: ${this.finalMap.size}. Synonyms collected: ${this.synMap.size}.`,
    );
  }
}
