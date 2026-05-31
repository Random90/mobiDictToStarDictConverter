// StarDict output renderer for PalmDoc converter.
async function renderOutput(finalMap, synMap, encoder, generateSyn, compress = true) {
  document.getElementById("downloadArea").style.display = "block";
  const links = document.getElementById("links");
  links.innerHTML = "";

  // Build .dict and .idx
  // StarDict requires .idx/.syn to be sorted in strcmp() order (UTF-8 byte
  // order), not Unicode locale order.  Simple JS string comparison is ~100x
  // faster than localeCompare and matches the required strcmp semantics.
  const sortedEntries = Array.from(finalMap.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const count = sortedEntries.length;

  // ── encodeInto idx/dict build (no per-entry allocations) ───────────────────
  let idxEstimate = 0, dictEstimate = 0;
  for (let i = 0; i < count; i++) {
    idxEstimate  += sortedEntries[i][0].length * 3 + 9;
    dictEstimate += sortedEntries[i][1].length + 16;
  }
  const idxBytes  = new Uint8Array(idxEstimate);
  const dictBytes = new Uint8Array(dictEstimate);
  const wordToOrdinal = new Map();
  let idxPos = 0, dictOff = 0;
  for (let i = 0; i < count; i++) {
    wordToOrdinal.set(sortedEntries[i][0], i);
    const wr = encoder.encodeInto(sortedEntries[i][0], idxBytes.subarray(idxPos));
    idxPos += wr.written;
    idxBytes[idxPos++] = 0;
    const hdr = idxPos; idxPos += 8;
    const dr = encoder.encodeInto(sortedEntries[i][1], dictBytes.subarray(dictOff));
    const dLen = dr.written;
    idxBytes[hdr]   = (dictOff >>> 24) & 0xFF; idxBytes[hdr+1] = (dictOff >>> 16) & 0xFF;
    idxBytes[hdr+2] = (dictOff >>>  8) & 0xFF; idxBytes[hdr+3] =  dictOff         & 0xFF;
    idxBytes[hdr+4] = (dLen    >>> 24) & 0xFF; idxBytes[hdr+5] = (dLen    >>> 16) & 0xFF;
    idxBytes[hdr+6] = (dLen    >>>  8) & 0xFF; idxBytes[hdr+7] =  dLen            & 0xFF;
    dictOff += dLen;
  }
  const idxTotalSize  = idxPos;
  const dictTotalSize = dictOff;

  // Build .syn only from real alternate -> canonical mappings.
  let synCount = 0;
  let synBytesArr = null;

  if (generateSyn && synMap && synMap.size > 0) {
    // Use parallel arrays to avoid 2.4M [alt, ordinal] pair object allocations.
    const synWords = [];
    const synOrdinals = [];
    for (const [alt, canonical] of synMap.entries()) {
      if (!wordToOrdinal.has(canonical)) continue;
      if (wordToOrdinal.has(alt)) continue;
      synWords.push(alt);
      synOrdinals.push(wordToOrdinal.get(canonical));
    }
    // Sort index array by word — avoids moving large string objects.
    const synIdx = new Uint32Array(synWords.length);
    for (let i = 0; i < synWords.length; i++) synIdx[i] = i;
    synIdx.sort((a, b) => {
      const wa = synWords[a], wb = synWords[b];
      return wa < wb ? -1 : wa > wb ? 1 : 0;
    });
    synCount = synWords.length;

    let synEstimate = 0;
    for (let i = 0; i < synCount; i++)
      synEstimate += synWords[i].length * 2 + 5;
    synBytesArr = new Uint8Array(synEstimate);
    const synDv = new DataView(synBytesArr.buffer);
    let synPos = 0;
    for (let i = 0; i < synCount; i++) {
      const si = synIdx[i];
      const r = encoder.encodeInto(synWords[si], synBytesArr.subarray(synPos));
      synPos += r.written;
      synBytesArr[synPos++] = 0;
      const ord = synOrdinals[si];
      synBytesArr[synPos++] = (ord >>> 24) & 0xFF; synBytesArr[synPos++] = (ord >>> 16) & 0xFF;
      synBytesArr[synPos++] = (ord >>>  8) & 0xFF; synBytesArr[synPos++] =  ord         & 0xFF;
    }
    synBytesArr = synBytesArr.subarray(0, synPos);
    addLog(`Synonym file: ${synCount} entries written.`);
  }

  // .ifo
  let ifoLines = [
    "StarDict's dict ifo file",
    "version=2.4.2",
    `wordcount=${count}`,
    `idxfilesize=${idxTotalSize}`,
    "bookname=Wielki_Slownik_Ang-Pol",
    "sametypesequence=h",
  ];
  if (synCount > 0) ifoLines.push(`synwordcount=${synCount}`);
  const ifo = ifoLines.join("\n") + "\n";

  const ifoBytes = new TextEncoder().encode(ifo);

  // Optionally compress the .dict data into .dict.dz (dictzip / gzip with RA index)
  let dictFileBytes = dictBytes;
  let dictFileName = "dictionary.dict";
  let dictDzLength = null;

  if (compress) {
    addLog(`🗜 Compressing dictionary data (${dictTotalSize} B) – please wait…`);
    // Yield to the browser so the log message renders before the synchronous
    // pako deflation loop begins.
    await new Promise(r => setTimeout(r, 0));
    const dictDzBytes = await compressDictzip(dictBytes, (done, total) => {
      if (done % 200 === 0 || done === total) {
        addLog(`  Compression: ${done}/${total} chunks…`);
      }
    });
    const ratio = dictTotalSize > 0
      ? Math.round((1 - dictDzBytes.length / dictTotalSize) * 100)
      : 0;
    addLog(`✅ Compressed: ${dictDzBytes.length} B (saved ${ratio}%)`);
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
    badge.textContent = `${synCount} synonyms`;
    links.appendChild(badge);
  }

  const dictSizePart = compress
    ? `dict: ${dictTotalSize} B → dict.dz: ${dictDzLength} B`
    : `dict: ${dictTotalSize} B`;
  addLog(
    `✅ Done. Entries: ${count}, idx: ${idxTotalSize} B, ${dictSizePart}${synCount ? `, syn: ${synCount}` : ""}.`,
  );

  // Preview
  const pArea = document.getElementById("previewArea");
  const pGrid = document.getElementById("previewGrid");
  pGrid.innerHTML = "";
  pArea.style.display = "block";
  const keys = sortedEntries.map(([k]) => k);
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
      `<b style="color:#007bff;display:block;border-bottom:1px solid #eee;margin-bottom:5px">${k}</b>` +
      finalMap.get(k);
    pGrid.appendChild(div);
  }

  if (window.StarDictValidator) {
    if (!window.__palmValidator) {
      window.__palmValidator = window.StarDictValidator.create({
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
        getCopyLabel: () => "Copy HTML",
        getCopiedLabel: () => "Copied",
      });
    }
    window.__palmValidator.loadFromBuffers({
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
}
