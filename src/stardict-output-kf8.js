// StarDict output renderer for KF8 converter.
function renderOutput(finalMap, synMap, generateSyn) {
  document.getElementById("downloadArea").style.display = "block";
  const links = document.getElementById("links");
  links.innerHTML = "";

  const enc = new TextEncoder();

  // StarDict .idx must be sorted alphabetically (case-insensitive)
  const sorted = Array.from(finalMap.entries()).sort(([a], [b]) =>
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

  for (const [word, def] of sorted) {
    wordToOrdinal.set(word, count);
    const db = enc.encode(def);
    const wb = enc.encode(word);
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

  // Build .syn
  let synChunks = [], synTotalSize = 0, synCount = 0;
  if (generateSyn && synMap.size > 0) {
    const validSyns = [];
    for (const [alt, canonical] of synMap.entries()) {
      if (!wordToOrdinal.has(canonical)) continue;
      if (wordToOrdinal.has(alt)) continue;
      validSyns.push([alt, wordToOrdinal.get(canonical)]);
    }
    validSyns.sort(([a], [b]) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
    for (const [alt, ordinal] of validSyns) {
      const ab = enc.encode(alt);
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
  addLog(
    i18nText(
      "logOutputReady",
      "✅ Output ready. {count} entries, idx={idxBytes} B, dict={dictBytes} B{synPart}.",
      {
        count,
        idxBytes: idxTotalSize,
        dictBytes: dictTotalSize,
        synPart,
      },
    ),
  );
}
