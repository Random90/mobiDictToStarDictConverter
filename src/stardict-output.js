// stardict-output.js – unified StarDict output renderer.
// Replaces stardict-output-kf8.js and stardict-output-palmdoc.js.
//
// Signature: renderOutput(finalMap, synMap, generateSyn, compress = true)
//   finalMap    – Map<string, string>  word → HTML definition
//   synMap      – Map<string, string>  alternate form → canonical word
//   generateSyn – boolean
//   compress    – boolean (dictzip / .dict.dz)
//
// Requires globals: addLog, i18nText, pako, StarDictValidator,
//                   compressDictzip (from stardict-dictzip-core.js)

async function renderOutput(finalMap, synMap, generateSyn, compress = true) {
  const links = document.getElementById("links");
  links.innerHTML = "";

  const enc = new TextEncoder();

  // StarDict requires .idx/.syn to be sorted in strcmp() order (UTF-8 byte
  // order), not Unicode locale order.  Simple JS string comparison is ~100x
  // faster than localeCompare and matches the required strcmp semantics.
  const sorted = Array.from(finalMap.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const count = sorted.length;

  // ── Encode words + defs into pre-sized buffers (no per-entry allocs) ────────
  let idxEstimate = 0,
    dictEstimate = 0;
  for (let i = 0; i < count; i++) {
    idxEstimate += sorted[i][0].length * 3 + 9;
    dictEstimate += sorted[i][1].length + 16;
  }
  const idxBytes = new Uint8Array(idxEstimate);
  const dictBytes = new Uint8Array(dictEstimate);
  const wordToOrdinal = new Map();
  let idxPos = 0,
    dictOff = 0;
  for (let i = 0; i < count; i++) {
    wordToOrdinal.set(sorted[i][0], i);
    const wr = enc.encodeInto(sorted[i][0], idxBytes.subarray(idxPos));
    idxPos += wr.written;
    idxBytes[idxPos++] = 0; // NUL terminator
    const hdr = idxPos;
    idxPos += 8; // reserve 8-byte header slot
    const dr = enc.encodeInto(sorted[i][1], dictBytes.subarray(dictOff));
    const dLen = dr.written;
    idxBytes[hdr] = (dictOff >>> 24) & 0xff;
    idxBytes[hdr + 1] = (dictOff >>> 16) & 0xff;
    idxBytes[hdr + 2] = (dictOff >>> 8) & 0xff;
    idxBytes[hdr + 3] = dictOff & 0xff;
    idxBytes[hdr + 4] = (dLen >>> 24) & 0xff;
    idxBytes[hdr + 5] = (dLen >>> 16) & 0xff;
    idxBytes[hdr + 6] = (dLen >>> 8) & 0xff;
    idxBytes[hdr + 7] = dLen & 0xff;
    dictOff += dLen;
  }
  const idxTotalSize = idxPos;
  const dictTotalSize = dictOff;

  // ── Build .syn ────────────────────────────────────────────────────────────────
  let synBytesArr = null,
    synCount = 0;
  if (generateSyn && synMap && synMap.size > 0) {
    // Parallel arrays avoid per-entry object allocations on large dictionaries.
    const synWords = [];
    const synOrdinals = [];
    for (const [alt, canonical] of synMap.entries()) {
      if (!wordToOrdinal.has(canonical)) continue;
      if (wordToOrdinal.has(alt)) continue;
      synWords.push(alt);
      synOrdinals.push(wordToOrdinal.get(canonical));
    }
    synCount = synWords.length;

    // Sort index array by word — avoids moving large string objects.
    const synIdx = new Uint32Array(synCount);
    for (let i = 0; i < synCount; i++) synIdx[i] = i;
    synIdx.sort((a, b) => {
      const wa = synWords[a],
        wb = synWords[b];
      return wa < wb ? -1 : wa > wb ? 1 : 0;
    });

    let synEstimate = 0;
    for (let i = 0; i < synCount; i++)
      synEstimate += synWords[i].length * 2 + 5;
    synBytesArr = new Uint8Array(synEstimate);
    let synPos = 0;
    for (let i = 0; i < synCount; i++) {
      const si = synIdx[i];
      const r = enc.encodeInto(synWords[si], synBytesArr.subarray(synPos));
      synPos += r.written;
      synBytesArr[synPos++] = 0;
      const ord = synOrdinals[si];
      synBytesArr[synPos++] = (ord >>> 24) & 0xff;
      synBytesArr[synPos++] = (ord >>> 16) & 0xff;
      synBytesArr[synPos++] = (ord >>> 8) & 0xff;
      synBytesArr[synPos++] = ord & 0xff;
    }
    synBytesArr = synBytesArr.subarray(0, synPos);
    addLog(
      i18nText("logSynonymFile", "Synonym file: {count} entries.", {
        count: synCount,
      }),
    );
  }

  // ── .ifo ────────────────────────────────────────────────────────────────────
  const ifoLines = [
    "StarDict's dict ifo file",
    "version=2.4.2",
    `wordcount=${count}`,
    `idxfilesize=${idxTotalSize}`,
    "bookname=dictionary",
    "sametypesequence=h",
  ];
  if (synCount > 0) ifoLines.push(`synwordcount=${synCount}`);
  const ifo = ifoLines.join("\n") + "\n";
  const ifoBytes = enc.encode(ifo);

  // ── Optionally compress dict → .dict.dz ──────────────────────────────────────
  let dictFileBytes = dictBytes;
  let dictFileName = "dictionary.dict";
  let dictDzLength = null;

  if (compress) {
    addLog(
      i18nText(
        "logCompressingDict",
        "🗜 Compressing dictionary data ({dictBytes} B) – please wait…",
        { dictBytes: dictTotalSize },
      ),
    );
    // Yield so the log message renders before the synchronous pako loop starts.
    await new Promise((r) => setTimeout(r, 0));
    const dictDzBytes = await compressDictzip(dictBytes, (done, total) => {
      if (done % 200 === 0 || done === total) {
        addLog(
          i18nText(
            "logCompressingProgress",
            "Compression: {done}/{total} chunks…",
            { done, total },
          ),
        );
      }
    });
    const ratio =
      dictTotalSize > 0
        ? Math.round((1 - dictDzBytes.length / dictTotalSize) * 100)
        : 0;
    addLog(
      i18nText(
        "logCompressingDone",
        "✅ Compressed: {dictDzBytes} B (saved {ratio}%)",
        { dictDzBytes: dictDzBytes.length, ratio },
      ),
    );
    dictFileBytes = dictDzBytes;
    dictFileName = "dictionary.dict.dz";
    dictDzLength = dictDzBytes.length;
  }

  document.getElementById("downloadArea").style.display = "block";
  // ── Download links ────────────────────────────────────────────────────────────
  const dl = (name, data) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data]));
    a.download = name;
    a.className = "btn-dl";
    a.textContent = `⬇ ${name}`;
    links.appendChild(a);
  };
  dl("dictionary.ifo", ifoBytes);
  dl("dictionary.idx", idxBytes);
  dl(dictFileName, dictFileBytes);
  if (synCount > 0) {
    // Wrap syn button + count badge in an inline-flex column so the badge
    // always sits directly below the button and never wraps away from it.
    const synWrap = document.createElement("span");
    synWrap.style.cssText =
      "display:inline-flex;flex-direction:column;align-items:center;vertical-align:top;margin-top: 5px;";
    const synLink = document.createElement("a");
    synLink.href = URL.createObjectURL(new Blob([synBytesArr]));
    synLink.download = "dictionary.syn";
    synLink.className = "btn-dl";
    synLink.style.margin = "0";
    synLink.textContent = "⬇ dictionary.syn";
    const badge = document.createElement("span");
    badge.className = "badge-syn";
    badge.style.cssText = "margin:4px 0 0;white-space:nowrap;";
    badge.textContent = i18nText("validatorSynonymBadge", "{count} synonyms", {
      count: synCount,
    });
    synWrap.appendChild(synLink);
    synWrap.appendChild(badge);
    links.appendChild(synWrap);
  }

  // ── Preview sample entries ────────────────────────────────────────────────────
  const pArea = document.getElementById("previewArea");
  const pGrid = document.getElementById("previewGrid");
  pGrid.innerHTML = "";
  pArea.style.display = "block";

  const keys = sorted.map(([k]) => k);
  const shown = new Set();
  const sampleKeys = [];
  for (let i = 0; i < Math.min(3, keys.length); i++) {
    let k;
    do {
      k = keys[Math.floor(Math.random() * keys.length)];
    } while (shown.has(k));
    shown.add(k);
    sampleKeys.push(k);
    const div = document.createElement("div");
    div.className = "preview-item";
    div.innerHTML =
      `<b style="color:#007bff;display:block;border-bottom:1px solid #eee;margin-bottom:4px">${k}</b>` +
      finalMap.get(k);
    pGrid.appendChild(div);
  }

  // ── Inline validator ──────────────────────────────────────────────────────────
  if (window.StarDictValidator) {
    if (!window.__dictValidator) {
      window.__dictValidator = window.StarDictValidator.create({
        ids: {
          status: "validatorStatus",
          search: "validatorSearchBox",
          resultCard: "validatorResultCard",
          resultWord: "validatorResultWord",
          byteBadge: "validatorByteBadge",
          synInfo: "validatorSynInfo",
          paneRendered: "validatorPaneRendered",
          copyBtn: "validatorCopyBtn",
        },
        t: (key, vars) => i18nText(key, key, vars),
        getCopyLabel: () => i18nText("validatorCopyHtml", "Copy HTML"),
        getCopiedLabel: () => i18nText("validatorCopyDone", "Copied"),
      });
    }
    window.__dictValidator.loadFromBuffers({
      ifoText: new TextDecoder("utf-8").decode(ifoBytes),
      idxBuffer: idxBytes.buffer,
      dictBuffer: dictBytes.buffer,
      synBuffer: synBytesArr ? synBytesArr.buffer : null,
    });

    const searchEl = document.getElementById("validatorSearchBox");
    if (searchEl && sampleKeys.length > 0) {
      const pick = sampleKeys[Math.floor(Math.random() * sampleKeys.length)];
      searchEl.value = pick;
      searchEl.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  // ── Final log ─────────────────────────────────────────────────────────────────
  const synPart = synCount
    ? i18nText("logOutputReadySynPart", ", syn={synCount}", { synCount })
    : "";
  const dictSizePart = compress
    ? i18nText(
        "logOutputReadyDictDz",
        "dict={dictBytes} B → dict.dz={dictDzBytes} B",
        { dictBytes: dictTotalSize, dictDzBytes: dictDzLength },
      )
    : i18nText("logOutputReadyDict", "dict={dictBytes} B", {
        dictBytes: dictTotalSize,
      });
  addLog(
    i18nText(
      "logOutputReady",
      "✅ Output ready. {count} entries, idx={idxBytes} B, {dictSizePart}{synPart}.",
      { count, idxBytes: idxTotalSize, dictSizePart, synPart },
    ),
  );
}
