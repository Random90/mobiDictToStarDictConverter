#!/usr/bin/env node
// perf-test-palmdoc.mjs – PalmDoc converter performance benchmark
//
// Usage:
//   node perf-test-palmdoc.mjs /path/to/file.mobi [label]

import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import { performance } from 'perf_hooks';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseHTML } from 'linkedom';

const __dirname = dirname(fileURLToPath(import.meta.url));

const mobiPath = process.argv[2] || '/home/deck/Downloads/Wielki Słownik Ang-Pol 2014.mobi';
const label    = process.argv[3] || 'unlabeled';

// ── 1. Browser-API stubs ─────────────────────────────────────────────────────

const logs = [];
function addLog(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  const line = `[${ts}] ${msg}`;
  logs.push(line);
  process.stdout.write(line + '\n');
}

const STYLES = {
  _escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); },
  _ensureHeadwordSpan(word, html) { return html; },
  none(word, pHtml, rawH2Html, contentHtml) {
    if (rawH2Html !== undefined) return rawH2Html + contentHtml;
    return pHtml;
  },
  clean(word, pHtml, rawH2Html, contentHtml) {
    if (rawH2Html !== undefined) return rawH2Html + contentHtml;
    return pHtml;
  },
  nice(word, pHtml, rawH2Html, contentHtml) {
    if (rawH2Html !== undefined) return rawH2Html + contentHtml;
    return pHtml;
  },
  eink(word, pHtml, rawH2Html, contentHtml) {
    if (rawH2Html !== undefined) return rawH2Html + contentHtml;
    return pHtml;
  },
  rich(word, pHtml, rawH2Html, contentHtml) {
    if (rawH2Html !== undefined) return rawH2Html + contentHtml;
    return pHtml;
  },
};

function i18nText(key, fallback, vars) {
  if (!vars) return fallback;
  return String(fallback).replace(/\{(\w+)}/g, (_, k) =>
    vars[k] !== undefined ? String(vars[k]) : `{${k}}`);
}

// pako stub – skip compression in perf test
const pako = {
  Deflate: class {
    constructor() { this.err = 0; this.msg = ''; }
    push() {}
    onData() {}
  }
};

// DOMParser via linkedom (full DOM support for palmdoc-converter.js)
const { DOMParser: _LinkedomDOMParser } = parseHTML('');
class DOMParser {
  parseFromString(html, type) {
    return parseHTML(html).document;
  }
}
globalThis.DOMParser = DOMParser;

// ── 2. Load source files ─────────────────────────────────────────────────────

const _srcFiles = [
  'src/mobi-index-core.js',
  'src/palmdoc-core.js',
  'src/palmdoc-converter.js',
];

let combinedSrc = '';
for (const f of _srcFiles) {
  combinedSrc += readFileSync(resolve(__dirname, f), 'utf-8') + '\n';
}
combinedSrc += 'globalThis.Converter = Converter;\n';
combinedSrc += 'globalThis.PalmDocBase = PalmDocBase;\n';

globalThis.addLog       = addLog;
globalThis.STYLES       = STYLES;
globalThis.i18nText     = i18nText;
globalThis.pako         = pako;

// eslint-disable-next-line no-eval
eval(combinedSrc);

// ── 3. Memory helpers ────────────────────────────────────────────────────────

function sampleMem() {
  const m = process.memoryUsage();
  return { rss: m.rss, heap: m.heapUsed };
}
function fmtMB(bytes) { return (bytes / 1024 / 1024).toFixed(1) + ' MB'; }

// ── 4. Run benchmark ─────────────────────────────────────────────────────────

async function run() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(` PALMDOC PERF BENCHMARK  [${label}]`);
  console.log(`  file : ${mobiPath}`);
  console.log('═══════════════════════════════════════════════════════\n');

  const t0 = performance.now();
  const fileBytes = readFileSync(mobiPath);
  const buffer = fileBytes.buffer.slice(
    fileBytes.byteOffset,
    fileBytes.byteOffset + fileBytes.byteLength
  );
  const tLoad = performance.now() - t0;
  console.log(`File loaded: ${fmtMB(buffer.byteLength)} in ${tLoad.toFixed(0)} ms\n`);

  const memSamples = [];
  const sampler = setInterval(() => memSamples.push(sampleMem()), 500);
  const cpuBefore = process.cpuUsage();
  const wallStart = performance.now();

  // ── buildRecords ──
  const tSetupStart = performance.now();
  const conv = new Converter(buffer, { style: 'none', generateSyn: true, merge: true }, addLog);
  const numRecords = conv.buildRecords();
  const tSetup = performance.now() - tSetupStart;
  console.log(`── Setup (buildRecords): ${tSetup.toFixed(0)} ms`);
  console.log(`   Records: ${numRecords}`);
  console.log(`   Extra flags: 0x${conv.extraFlags.toString(16)}`);
  console.log(`   Memory after setup: RSS ${fmtMB(process.memoryUsage().rss)}\n`);

  // ── extractAsync ──
  const tExtStart = performance.now();
  const html = await conv.extractAsync(numRecords);
  const tExt = performance.now() - tExtStart;
  console.log(`── extractAsync: ${tExt.toFixed(0)} ms  (${fmtMB(html.length * 2)} HTML)`);
  console.log(`   Memory: RSS ${fmtMB(process.memoryUsage().rss)}\n`);

  // ── parseDictionary ──
  const tParseStart = performance.now();
  conv.parseDictionary(html);
  const tParse = performance.now() - tParseStart;
  console.log(`── parseDictionary: ${tParse.toFixed(0)} ms`);
  console.log(`   Entries: ${conv.finalMap.size}`);
  console.log(`   Memory: RSS ${fmtMB(process.memoryUsage().rss)}\n`);

  // ── parseMobiIndexes ──
  let tIndex = 0;
  const tIdxStart = performance.now();
  try {
    const result = conv.parseMobiIndexes(conv.synMap);
    tIndex = performance.now() - tIdxStart;
    console.log(`── parseMobiIndexes: ${tIndex.toFixed(0)} ms  (${result.size} new syn entries)`);
  } catch (e) {
    tIndex = performance.now() - tIdxStart;
    console.log(`── parseMobiIndexes: ${tIndex.toFixed(0)} ms  (skipped: ${e.message})`);
  }

  // ── Build idx/dict buffers ──
  const tIdxBuildStart = performance.now();
  const enc = new TextEncoder();
  const sorted = Array.from(conv.finalMap.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0);
  const count = sorted.length;
  let idxEstimate = 0, dictEstimate = 0;
  for (let i = 0; i < count; i++) {
    idxEstimate  += sorted[i][0].length * 3 + 9;
    dictEstimate += sorted[i][1].length + 16;
  }
  const idxBytes  = new Uint8Array(idxEstimate);
  const dictBytes = new Uint8Array(dictEstimate);
  let idxPos = 0, dictOff = 0;
  for (let i = 0; i < count; i++) {
    const wr = enc.encodeInto(sorted[i][0], idxBytes.subarray(idxPos));
    idxPos += wr.written;
    idxBytes[idxPos++] = 0;
    const hdr = idxPos; idxPos += 8;
    const dr = enc.encodeInto(sorted[i][1], dictBytes.subarray(dictOff));
    const dLen = dr.written;
    idxBytes[hdr]   = (dictOff >>> 24) & 0xFF; idxBytes[hdr+1] = (dictOff >>> 16) & 0xFF;
    idxBytes[hdr+2] = (dictOff >>>  8) & 0xFF; idxBytes[hdr+3] =  dictOff         & 0xFF;
    idxBytes[hdr+4] = (dLen    >>> 24) & 0xFF; idxBytes[hdr+5] = (dLen    >>> 16) & 0xFF;
    idxBytes[hdr+6] = (dLen    >>>  8) & 0xFF; idxBytes[hdr+7] =  dLen            & 0xFF;
    dictOff += dLen;
  }
  const tIdxBuild = performance.now() - tIdxBuildStart;
  console.log(`── Build idx/dict: ${tIdxBuild.toFixed(0)} ms`);
  console.log(`   idx: ${fmtMB(idxPos)}, dict: ${fmtMB(dictOff)}\n`);

  // ── Totals ──
  const wallTotal = performance.now() - wallStart;
  const cpuAfter  = process.cpuUsage(cpuBefore);
  clearInterval(sampler);

  const peakRSS  = memSamples.length ? Math.max(...memSamples.map(s => s.rss))  : process.memoryUsage().rss;
  const peakHeap = memSamples.length ? Math.max(...memSamples.map(s => s.heap)) : process.memoryUsage().heapUsed;
  const finalMem = sampleMem();

  console.log('═══════════════════════════════════════════════════════');
  console.log(` RESULTS  [${label}]`);
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Wall time total : ${wallTotal.toFixed(0)} ms`);
  console.log(`    Setup         : ${tSetup.toFixed(0)} ms`);
  console.log(`    Extract       : ${tExt.toFixed(0)} ms`);
  console.log(`    ParseDict     : ${tParse.toFixed(0)} ms`);
  console.log(`    INDX parse    : ${tIndex.toFixed(0)} ms`);
  console.log(`    idx+dict build: ${tIdxBuild.toFixed(0)} ms`);
  console.log(`  CPU user        : ${(cpuAfter.user   / 1000).toFixed(0)} ms`);
  console.log(`  CPU system      : ${(cpuAfter.system / 1000).toFixed(0)} ms`);
  console.log(`  Peak RSS        : ${fmtMB(peakRSS)}`);
  console.log(`  Peak heap       : ${fmtMB(peakHeap)}`);
  console.log(`  Final RSS       : ${fmtMB(finalMem.rss)}`);
  console.log(`  Final heap      : ${fmtMB(finalMem.heap)}`);
  console.log(`  Entries         : ${conv.finalMap.size}`);
  console.log(`  Synonyms        : ${conv.synMap.size}`);
  console.log('═══════════════════════════════════════════════════════\n');

  const row = [
    label,
    new Date().toISOString(),
    wallTotal.toFixed(0),
    tSetup.toFixed(0),
    tExt.toFixed(0),
    tParse.toFixed(0),
    tIndex.toFixed(0),
    tIdxBuild.toFixed(0),
    (cpuAfter.user   / 1000).toFixed(0),
    (cpuAfter.system / 1000).toFixed(0),
    fmtMB(peakRSS),
    fmtMB(peakHeap),
    conv.finalMap.size,
    conv.synMap.size,
  ].join('\t');

  const header = 'label\tdate\twall_ms\tsetup_ms\textract_ms\tparse_ms\tindx_ms\tidxbuild_ms\tcpu_user_ms\tcpu_sys_ms\tpeak_rss\tpeak_heap\tentries\tsynonyms';
  const logFile = resolve(__dirname, 'perf-results-palmdoc.tsv');
  try {
    readFileSync(logFile);
    appendFileSync(logFile, row + '\n');
  } catch {
    writeFileSync(logFile, header + '\n' + row + '\n');
  }
  console.log(`Results appended to perf-results-palmdoc.tsv\n`);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});



