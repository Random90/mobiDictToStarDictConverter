'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// kf8-worker-inner.js  –  KF8/HUFF conversion pipeline for a Web Worker.
//
// This file is processed by build.js (@@include directives resolved,
// WASM binary injected) and embedded as a string in the compiled HTML.
// The main thread creates a Blob URL from that string and spawns a Worker.
//
// Communication protocol:
//   Main → Worker:  { buffer, options, i18nTables, lang }
//   Worker → Main:  { type:'log', msg }           – progress messages
//                   { type:'done', finalMapEntries, synMapEntries }
//                   { type:'error', message, stack }
// ─────────────────────────────────────────────────────────────────────────────

// ── Stub for addLog – forwards log messages to the main thread ───────────────
function addLog(msg) {
  self.postMessage({ type: 'log', msg: String(msg) });
}

// ── Stub for i18nText – uses tables sent with the job message ────────────────
function i18nText(key, fallback, vars) {
  const tables = self.__I18N_TABLES || {};
  const lang   = self.__LANG || 'en';
  const table  = tables[lang] || tables.en || {};
  const en     = tables.en || {};
  const base   = table[key] !== undefined ? table[key] : en[key];
  const text   = base !== undefined ? base : (fallback || key);
  if (!vars) return text;
  return String(text).replace(/\{(\w+)}/g, (_, k) =>
    vars[k] !== undefined ? String(vars[k]) : `{${k}}`);
}

// ── Core source files ─────────────────────────────────────────────────────────
// @@include(src/styles-core.js)
// @@include(src/mobi-index-core.js)
// @@include(src/huffcdic-core.js)

// ── WASM binary (base64-encoded huff-decoder.wasm, injected by build.js) ─────
// Must come AFTER huffcdic-core.js so HuffCdicBase is already defined.
// @@wasm_b64

// @@include(src/kf8-converter.js)

// ── Message handler ───────────────────────────────────────────────────────────
self.onmessage = async ({ data }) => {
  const { buffer, options, i18nTables, lang } = data;
  self.__I18N_TABLES = i18nTables;
  self.__LANG = lang;
  try {
    const conv = new KF8Converter(buffer, options);
    const { finalMap, synMap } = await conv.run();
    // Serialise Maps to plain arrays for structured-clone transfer.
    // V8's structured clone for arrays of string pairs is ~1–2 GB/s,
    // so ~250 MB of Map data transfers in < 300 ms.
    self.postMessage({
      type: 'done',
      finalMapEntries: [...finalMap],
      synMapEntries:   [...synMap],
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message, stack: err.stack || '' });
  }
};

