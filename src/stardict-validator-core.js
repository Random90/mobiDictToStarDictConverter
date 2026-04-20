// Shared StarDict validator logic used by converter and standalone validator tool.
(function () {
  function create(config) {
    const ids = config.ids || {};
    const el = {
      status: document.getElementById(ids.status),
      search: document.getElementById(ids.search),
      resultCard: document.getElementById(ids.resultCard),
      resultWord: document.getElementById(ids.resultWord),
      byteBadge: document.getElementById(ids.byteBadge),
      synInfo: document.getElementById(ids.synInfo),
      paneRendered: document.getElementById(ids.paneRendered),
      paneRaw: document.getElementById(ids.paneRaw),
      copyBtn: document.getElementById(ids.copyBtn),
    };

    let idxData = null;
    let dictData = null;
    let wordMap = new Map();
    let synMap = new Map();
    let ordinalToKey = [];
    let rawHtml = "";

    const dec = new TextDecoder("utf-8");

    function setStatus(msg) {
      if (el.status) el.status.textContent = msg;
    }

    function parseIdx(buffer) {
      idxData = new DataView(buffer);
      wordMap.clear();
      ordinalToKey = [];
      let offset = 0;
      while (offset < idxData.byteLength) {
        const start = offset;
        while (offset < idxData.byteLength && idxData.getUint8(offset) !== 0)
          offset++;
        const word = dec.decode(
          new Uint8Array(idxData.buffer, start, offset - start),
        );
        offset++;
        if (offset + 8 > idxData.byteLength) break;
        const dataOffset = idxData.getUint32(offset, false);
        const dataSize = idxData.getUint32(offset + 4, false);
        const lc = word.toLowerCase();
        ordinalToKey.push(lc);
        const entry = { off: dataOffset, sz: dataSize, original: word };
        if (wordMap.has(lc)) wordMap.get(lc).push(entry);
        else wordMap.set(lc, [entry]);
        offset += 8;
      }
    }

    function parseSyn(buffer) {
      synMap.clear();
      if (!buffer) return;
      const synView = new DataView(buffer);
      let so = 0;
      while (so < synView.byteLength) {
        const ss = so;
        while (so < synView.byteLength && synView.getUint8(so) !== 0) so++;
        const alt = dec.decode(new Uint8Array(synView.buffer, ss, so - ss));
        so++;
        if (so + 4 > synView.byteLength) break;
        const ordinal = synView.getUint32(so, false);
        so += 4;
        if (ordinal < ordinalToKey.length)
          synMap.set(alt.toLowerCase(), ordinalToKey[ordinal]);
      }
    }

    function showEntry(lowerKey, matchInfo) {
      const entries = wordMap.get(lowerKey);
      if (!entries) return;

      rawHtml = entries
        .map((e) => dec.decode(new Uint8Array(dictData, e.off, e.sz)))
        .join("");
      const first = entries[0];

      if (el.resultWord) el.resultWord.textContent = first.original;
      if (el.byteBadge) {
        el.byteBadge.textContent =
          entries.length > 1
            ? `${entries.length} idx entries · ${entries.reduce((s, e) => s + e.sz, 0)} bytes`
            : `${first.sz} bytes`;
      }

      if (el.synInfo) {
        if (matchInfo && matchInfo.mode === "synonym") {
          el.synInfo.style.display = "block";
          el.synInfo.innerHTML = `Synonym redirect: <b>${matchInfo.query}</b> -> <b>${first.original}</b>`;
        } else if (matchInfo && matchInfo.mode === "fallback-word") {
          el.synInfo.style.display = "block";
          el.synInfo.innerHTML = `Inflection fallback: <b>${matchInfo.query}</b> -> <b>${first.original}</b>`;
        } else if (matchInfo && matchInfo.mode === "fallback-synonym") {
          el.synInfo.style.display = "block";
          el.synInfo.innerHTML = `Inflection -> synonym fallback: <b>${matchInfo.query}</b> -> <b>${first.original}</b>`;
        } else {
          el.synInfo.style.display = "none";
        }
      }

      if (el.paneRendered) el.paneRendered.innerHTML = rawHtml;
      if (el.paneRaw) el.paneRaw.textContent = rawHtml;
      if (el.resultCard) el.resultCard.style.display = "block";
    }

    function bindSearch() {
      if (!el.search) return;

      const candidateBases = (q) => {
        const out = new Set();
        const w = (q || "").toLowerCase();
        if (!w) return out;
        out.add(w);
        if (w.endsWith("ies") && w.length > 4) out.add(w.slice(0, -3) + "y");
        if (w.endsWith("es") && w.length > 3) out.add(w.slice(0, -2));
        if (w.endsWith("s") && w.length > 2) out.add(w.slice(0, -1));
        if (w.endsWith("ing") && w.length > 5) {
          out.add(w.slice(0, -3));
          out.add(w.slice(0, -3) + "e");
        }
        if (w.endsWith("ed") && w.length > 4) {
          out.add(w.slice(0, -2));
          out.add(w.slice(0, -1));
        }
        return out;
      };

      const resolveKey = (queryLower) => {
        if (wordMap.has(queryLower)) {
          return { key: queryLower, mode: "exact" };
        }
        if (synMap.has(queryLower)) {
          return { key: synMap.get(queryLower), mode: "synonym" };
        }

        for (const base of candidateBases(queryLower)) {
          if (base === queryLower) continue;
          if (wordMap.has(base)) {
            return { key: base, mode: "fallback-word" };
          }
          if (synMap.has(base)) {
            return { key: synMap.get(base), mode: "fallback-synonym" };
          }
        }
        return null;
      };

      el.search.addEventListener("input", (e) => {
        const query = e.target.value.trim();
        const lower = query.toLowerCase();
        if (!query) {
          if (el.resultCard) el.resultCard.style.display = "none";
          return;
        }

        const resolved = resolveKey(lower);
        const matchKey = resolved ? resolved.key : null;

        if (!matchKey) {
          if (el.resultCard) el.resultCard.style.display = "none";
          return;
        }
        showEntry(
          matchKey,
          resolved && resolved.mode !== "exact"
            ? { mode: resolved.mode, query }
            : null,
        );
      });
    }

    function bindCopy() {
      if (!el.copyBtn) return;
      el.copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(rawHtml).then(() => {
          const copied = config.getCopiedLabel
            ? config.getCopiedLabel()
            : "Copied";
          const copy = config.getCopyLabel
            ? config.getCopyLabel()
            : "Copy HTML";
          el.copyBtn.textContent = copied;
          setTimeout(() => {
            el.copyBtn.textContent = copy;
          }, 1200);
        });
      });
    }

    async function loadFromFiles(files) {
      if (!files.idx || !files.dict) return;

      const idxBuffer = await files.idx.arrayBuffer();
      const dictBuffer = await files.dict.arrayBuffer();
      const synBuffer = files.syn ? await files.syn.arrayBuffer() : null;
      const ifoText = files.ifo
        ? dec.decode(await files.ifo.arrayBuffer())
        : "";

      loadFromBuffers({ idxBuffer, dictBuffer, synBuffer, ifoText });
    }

    function loadFromBuffers(data) {
      parseIdx(data.idxBuffer);
      dictData = data.dictBuffer;
      parseSyn(data.synBuffer || null);

      const ifoText = data.ifoText || "";
      const wordcount = (ifoText.match(/wordcount=(\d+)/) || [])[1] || "?";
      const syncount =
        (ifoText.match(/synwordcount=(\d+)/) || [])[1] || synMap.size;

      setStatus(
        `Ready: ${wordMap.size} entries` +
          (synMap.size ? ` · ${synMap.size} synonyms` : "") +
          (ifoText
            ? ` (ifo: wordcount=${wordcount}${syncount !== "0" ? ", synwordcount=" + syncount : ""})`
            : ""),
      );
      if (el.search) el.search.style.display = "block";
    }

    function attachFileInputs(fileInputIds) {
      const idsMap = fileInputIds || {};
      const ifoEl = document.getElementById(idsMap.ifo);
      const idxEl = document.getElementById(idsMap.idx);
      const dictEl = document.getElementById(idsMap.dict);
      const synEl = document.getElementById(idsMap.syn);

      const triggerLoad = () => {
        loadFromFiles({
          ifo: ifoEl ? ifoEl.files[0] : null,
          idx: idxEl ? idxEl.files[0] : null,
          dict: dictEl ? dictEl.files[0] : null,
          syn: synEl ? synEl.files[0] : null,
        });
      };

      [ifoEl, idxEl, dictEl, synEl].forEach((node) => {
        if (node) node.addEventListener("change", triggerLoad);
      });
    }

    bindSearch();
    bindCopy();

    return {
      loadFromBuffers,
      loadFromFiles,
      attachFileInputs,
      getRawHtml: () => rawHtml,
    };
  }

  window.StarDictValidator = {
    create,
    initFromFiles(config) {
      const api = create(config);
      api.attachFileInputs(config.fileInputIds || {});
      return api;
    },
  };
})();
