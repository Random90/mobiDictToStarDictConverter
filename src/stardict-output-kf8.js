// StarDict output renderer for KF8 converter.
async function renderOutput(finalMap, synMap, generateSyn, compress = true) {
  document.getElementById("downloadArea").style.display = "block";
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

  // ── Encode words + defs, compute sizes, build idx/dict in two passes ────────
  // encodeInto writes words/defs directly into pre-sized buffers, avoiding
  // 2 × count intermediate Uint8Array allocations and the GC pressure from them.
  // Size estimates: words ≤ 80 chars × 3 bytes + 9; defs ≈ ASCII HTML (length+16).
  let idxEstimate = 0, dictEstimate = 0;
  for (let i = 0; i < count; i++) {
    idxEstimate  += sorted[i][0].length * 3 + 9;
    dictEstimate += sorted[i][1].length + 16;
  }
  const idxBytes  = new Uint8Array(idxEstimate);
  const dictBytes = new Uint8Array(dictEstimate);
  const wordToOrdinal = new Map();
  let idxPos = 0, dictOff = 0;
  for (let i = 0; i < count; i++) {
    wordToOrdinal.set(sorted[i][0], i);
    const wr = enc.encodeInto(sorted[i][0], idxBytes.subarray(idxPos));
    idxPos += wr.written;
    idxBytes[idxPos++] = 0;                // NUL terminator
    const hdr = idxPos; idxPos += 8;       // reserve header slot
    const dr = enc.encodeInto(sorted[i][1], dictBytes.subarray(dictOff));
    const dLen = dr.written;
    idxBytes[hdr]   = (dictOff >>> 24) & 0xFF; idxBytes[hdr+1] = (dictOff >>> 16) & 0xFF;
    idxBytes[hdr+2] = (dictOff >>>  8) & 0xFF; idxBytes[hdr+3] =  dictOff         & 0xFF;
    idxBytes[hdr+4] = (dLen    >>> 24) & 0xFF; idxBytes[hdr+5] = (dLen    >>> 16) & 0xFF;
    idxBytes[hdr+6] = (dLen    >>>  8) & 0xFF; idxBytes[hdr+7] =  dLen            & 0xFF;
    dictOff += dLen;
  }
  const idxTotalSize  = idxPos;
  const dictTotalSize = dictOff;

  // Build .syn
  let synBytesArr = null, synCount = 0;
  if (generateSyn && synMap.size > 0) {
    // Use parallel arrays instead of [alt, ordinal] pair objects to avoid
    // 2.4M small array allocations and improve sort cache locality.
    const synWords = [];
    const synOrdinals = [];
    for (const [alt, canonical] of synMap.entries()) {
      if (!wordToOrdinal.has(canonical)) continue;
      if (wordToOrdinal.has(alt)) continue;
      synWords.push(alt);
      synOrdinals.push(wordToOrdinal.get(canonical));
    }
    synCount = synWords.length;

    // Sort an index array by word value — avoids moving large string objects.
    const synIdx = new Uint32Array(synCount);
    for (let i = 0; i < synCount; i++) synIdx[i] = i;
    synIdx.sort((a, b) => {
      const wa = synWords[a], wb = synWords[b];
      return wa < wb ? -1 : wa > wb ? 1 : 0;
    });

    // Pre-estimate syn buffer (alt.length * 2 is safe upper bound for UTF-8
    // Polish text + NUL + 4-byte ordinal); encodeInto avoids 2.4M temp allocs.
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
      synBytesArr[synPos++] = (ord >>> 24) & 0xFF; synBytesArr[synPos++] = (ord >>> 16) & 0xFF;
      synBytesArr[synPos++] = (ord >>>  8) & 0xFF; synBytesArr[synPos++] =  ord         & 0xFF;
    }
    synBytesArr = synBytesArr.subarray(0, synPos); // trim to actual size
    addLog(
      i18nText("logSynonymFile", "Synonym file: {count} entries.", {
        count: synCount,
      }),
    );
  }


  // .ifo
  const ifoLines = [
    "StarDict's dict ifo file",
    "version=2.4.2",
    `wordcount=${count}`,
    `idxfilesize=${idxTotalSize}`,
    "bookname=Wielki_Slownik_Ang-Pol_JEM",
    "sametypesequence=h",
  ];
  if (synCount > 0) ifoLines.push(`synwordcount=${synCount}`);
  const ifo = ifoLines.join("\n") + "\n";
  const ifoBytes = enc.encode(ifo);

  // Optionally compress the .dict data into .dict.dz (dictzip / gzip with RA index)
  let dictFileBytes = dictBytes;
  let dictFileName = "dictionary.dict";
  let dictDzLength = null;

  if (compress) {
    addLog(
      i18nText("logCompressingDict", "🗜 Compressing dictionary data ({dictBytes} B) – please wait…", {
        dictBytes: dictTotalSize,
      }),
    );
    // Yield to the browser so the log message is painted before the
    // synchronous pako deflation loop starts (compressDictzip is async in
    // name only – all CPU work happens inside a single synchronous loop).
    await new Promise(r => setTimeout(r, 0));
    const dictDzBytes = await compressDictzip(dictBytes, (done, total) => {
      if (done % 200 === 0 || done === total) {
        addLog(
          i18nText("logCompressingProgress", "Compression: {done}/{total} chunks…", {
            done,
            total,
          }),
        );
      }
    });
    const ratio = dictTotalSize > 0
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

  // Download links
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
    dl("dictionary.syn", synBytesArr);
    const badge = document.createElement("span");
    badge.className = "badge-syn";
    badge.textContent = i18nText("validatorSynonymBadge", "{count} synonyms", {
      count: synCount,
    });
    links.appendChild(badge);
  }

  // Preview
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
      // Do not truncate raw HTML; rich style markup breaks when sliced mid-tag.
      finalMap.get(k);
    pGrid.appendChild(div);
  }

  if (window.StarDictValidator) {
    if (!window.__kf8Validator) {
      window.__kf8Validator = window.StarDictValidator.create({
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
    window.__kf8Validator.loadFromBuffers({
      ifoText: new TextDecoder("utf-8").decode(ifoBytes),
      idxBuffer: idxBytes.buffer,
      dictBuffer: dictBytes.buffer,
      synBuffer: synBytesArr ? synBytesArr.buffer : null,
    });

    // Seed search from random samples and render the full entry immediately.
    const searchEl = document.getElementById("validatorSearchBox");
    if (searchEl && sampleKeys.length > 0) {
      const pick = sampleKeys[Math.floor(Math.random() * sampleKeys.length)];
      searchEl.value = pick;
      searchEl.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  const synPart = synCount
    ? i18nText("logOutputReadySynPart", ", syn={synCount}", { synCount })
    : "";
  const dictSizePart = compress
    ? i18nText(
        "logOutputReadyDictDz",
        "dict={dictBytes} B → dict.dz={dictDzBytes} B",
        { dictBytes: dictTotalSize, dictDzBytes: dictDzLength },
      )
    : i18nText("logOutputReadyDict", "dict={dictBytes} B", { dictBytes: dictTotalSize });
  addLog(
    i18nText(
      "logOutputReady",
      "✅ Output ready. {count} entries, idx={idxBytes} B, {dictSizePart}{synPart}.",
      { count, idxBytes: idxTotalSize, dictSizePart, synPart },
    ),
  );
}
