// StarDict output renderer for PalmDoc converter.
function renderOutput(finalMap, synMap, encoder, generateSyn) {
  document.getElementById("downloadArea").style.display = "block";
  const links = document.getElementById("links");
  links.innerHTML = "";

  // Build .dict and .idx
  // StarDict requires .idx to be sorted alphabetically (case-insensitive)
  const sortedEntries = Array.from(finalMap.entries()).sort(([a], [b]) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );

  const concatChunks = (chunks, total) => {
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    return out;
  };

  const wordToOrdinal = new Map();
  const nullByte = new Uint8Array(1);
  let dictChunks = [], idxChunks = [],
    dictTotalSize = 0, idxTotalSize = 0,
    offset = 0, count = 0;

  for (const [word, def] of sortedEntries) {
    wordToOrdinal.set(word, count);
    const db = encoder.encode(def);
    const wb = encoder.encode(word);
    dictChunks.push(db);
    dictTotalSize += db.length;
    idxChunks.push(wb);
    idxTotalSize += wb.length;
    idxChunks.push(nullByte);
    idxTotalSize += 1;
    const dv = new DataView(new ArrayBuffer(8));
    dv.setUint32(0, offset, false);
    dv.setUint32(4, db.length, false);
    idxChunks.push(new Uint8Array(dv.buffer));
    idxTotalSize += 8;
    offset += db.length;
    count++;
  }

  // Build .syn only from real alternate -> canonical mappings.
  let synCount = 0;
  let synChunks = [], synTotalSize = 0;

  if (generateSyn && synMap && synMap.size > 0) {
    const validSyns = [];
    for (const [alt, canonical] of synMap.entries()) {
      if (!wordToOrdinal.has(canonical)) continue;
      if (wordToOrdinal.has(alt)) continue;
      validSyns.push([alt, wordToOrdinal.get(canonical)]);
    }
    validSyns.sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()));

    for (const [alt, ordinal] of validSyns) {
      const ab = encoder.encode(alt);
      synChunks.push(ab);
      synTotalSize += ab.length;
      synChunks.push(nullByte);
      synTotalSize += 1;
      const dv = new DataView(new ArrayBuffer(4));
      dv.setUint32(0, ordinal, false);
      synChunks.push(new Uint8Array(dv.buffer));
      synTotalSize += 4;
    }
    synCount = validSyns.length;
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
  const idxBytes = concatChunks(idxChunks, idxTotalSize);
  const dictBytes = concatChunks(dictChunks, dictTotalSize);
  const synBytesArr = synCount > 0 ? concatChunks(synChunks, synTotalSize) : null;

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
  dl("dictionary.dict", dictBytes);
  if (synCount > 0) {
    dl("dictionary.syn", synBytesArr);
    const badge = document.createElement("span");
    badge.className = "badge-syn";
    badge.textContent = `${synCount} synonyms`;
    links.appendChild(badge);
  }

  addLog(
    `✅ Done. Entries: ${count}, idx: ${idxTotalSize} B, dict: ${dictTotalSize} B${synCount ? `, syn: ${synCount}` : ""}.`,
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
