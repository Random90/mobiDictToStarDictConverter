#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// perf-test.mjs  –  Node.js performance benchmark for mobiDictToStarDictConverter
//
// Usage:
//   node perf-test.mjs /path/to/file.mobi [--label "baseline"]
//
// Measures:
//   - Wall-clock time for each pipeline stage
//   - RSS / heapUsed memory (sampled every 500 ms during conversion)
//   - Peak memory
//   - CPU time (process.cpuUsage)
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import { createRequire } from 'module';
import { performance } from 'perf_hooks';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const mobiPath = process.argv[2] || '/home/deck/Downloads/SJP2-202507140955.mobi';
const label    = process.argv[3] || 'unlabeled';

// ── 1. Browser-API stubs ──────────────────────────────────────────────────────

const logs = [];
function addLog(msg) {
    const ts = new Date().toISOString().substring(11, 19);
    const line = `[${ts}] ${msg}`;
    logs.push(line);
    process.stdout.write(line + '\n');
}

// Minimal STYLES stub (same shape as the real one; 'none' is the fastest)
const STYLES = {
    _escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); },
    _ensureHeadwordSpan(word, html) { return html; },
    none(word, pHtml)  { return pHtml; },
    clean(word, pHtml) { return pHtml; },
    nice(word, pHtml)  { return pHtml; },
    eink(word, pHtml)  { return pHtml; },
    rich(word, pHtml)  { return pHtml; },
};

function i18nText(key, fallback, vars) {
    if (!vars) return fallback;
    return String(fallback).replace(/\{(\w+)}/g, (_, k) =>
        vars[k] !== undefined ? String(vars[k]) : `{${k}}`);
}

// pako stub – we skip dictzip compression in perf test (it's a separate stage)
const pako = {
    Deflate: class {
        constructor() { this.err = 0; this.msg = ''; }
        push() {}
        onData() {}
    }
};

// ── 2. Load source files via combined eval in Node.js global scope ───────────
// Class declarations are lexically scoped in VM scripts so we use globalThis
// assignments via a combined script to make the classes accessible.

const _srcFiles = [
    'src/mobi-index-core.js',
    'src/huffcdic-core.js',
    'src/kf8-converter.js',
];

// Build one combined script and expose the final class via globalThis
let combinedSrc = '';
for (const f of _srcFiles) {
    combinedSrc += readFileSync(resolve(__dirname, f), 'utf-8') + '\n';
}
combinedSrc += 'globalThis.KF8Converter = KF8Converter;\n';
combinedSrc += 'globalThis.HuffCdicBase = HuffCdicBase;\n';
combinedSrc += 'globalThis.parseMobiIndexes = parseMobiIndexes;\n';

// Set up stubs on globalThis so eval'd code can see them
globalThis.addLog       = addLog;
globalThis.STYLES       = STYLES;
globalThis.i18nText     = i18nText;
globalThis.pako         = pako;

// Evaluate in the current Node.js context (has all built-ins natively)
// eslint-disable-next-line no-eval
eval(combinedSrc);

// ── 3. Memory sampler ─────────────────────────────────────────────────────────

function sampleMem() {
    const m = process.memoryUsage();
    return { rss: m.rss, heap: m.heapUsed };
}

function fmtMB(bytes) { return (bytes / 1024 / 1024).toFixed(1) + ' MB'; }

// ── 4. Run benchmark ──────────────────────────────────────────────────────────

async function run() {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log(` PERF BENCHMARK  [${label}]`);
    console.log(`  file : ${mobiPath}`);
    console.log('═══════════════════════════════════════════════════════\n');

    // ── Load file ──
    const t0 = performance.now();
    const fileBytes = readFileSync(mobiPath);
    const buffer = fileBytes.buffer.slice(
        fileBytes.byteOffset,
        fileBytes.byteOffset + fileBytes.byteLength
    );
    const tLoad = performance.now() - t0;
    console.log(`File loaded: ${fmtMB(buffer.byteLength)} in ${tLoad.toFixed(0)} ms\n`);

    // ── Start memory sampling ──
    const memSamples = [];
    const sampler = setInterval(() => memSamples.push(sampleMem()), 500);

    const cpuBefore = process.cpuUsage();
    const wallStart = performance.now();

    // ── Construct converter ──
    const conv = new KF8Converter(buffer, { style: 'none', generateSyn: true });

    // Time: buildRecords + findExtraDataFlags + loadHuff + loadAllCdic
    const tSetupStart = performance.now();
    conv.buildRecords();
    const extraFlags = conv.findExtraDataFlags();

    // Find HUFF
    let huffIdx = -1;
    for (let i = 0; i < conv.recs.length; i++) {
        const o = conv.recs[i];
        if (conv.raw[o] === 72 && conv.raw[o+1] === 85 && conv.raw[o+2] === 70 && conv.raw[o+3] === 70) {
            huffIdx = i; break;
        }
    }
    if (huffIdx === -1) { clearInterval(sampler); throw new Error('No HUFF record!'); }

    const textRecordMax = conv.getTextRecordMax(huffIdx);
    conv.loadHuff(conv.recs[huffIdx]);
    conv.loadAllCdic(huffIdx);
    const tSetup = performance.now() - tSetupStart;

    console.log(`\n── Setup (buildRecords+HUFF+CDIC): ${tSetup.toFixed(0)} ms`);
    console.log(`   Records: ${conv.recs.length}, huffIdx: ${huffIdx}, textRecordMax: ${textRecordMax}`);
    console.log(`   Dict symbols: ${conv.dict.length}`);
    console.log(`   Memory after setup: RSS ${fmtMB(process.memoryUsage().rss)}\n`);

    // ── streamDecompress ──
    const tDecompStart = performance.now();
    await conv.streamDecompress(textRecordMax, extraFlags);
    const tDecomp = performance.now() - tDecompStart;
    console.log(`\n── streamDecompress: ${tDecomp.toFixed(0)} ms`);
    console.log(`   Entries extracted: ${conv.finalMap.size}`);
    console.log(`   Memory: RSS ${fmtMB(process.memoryUsage().rss)}, heap ${fmtMB(process.memoryUsage().heapUsed)}\n`);

    // ── parseMobiIndexes ──
    let tIndex = 0;
    if (conv.options.generateSyn) {
        const tIdxStart = performance.now();
        try {
            const inflMap = conv.parseMobiIndexes();
            tIndex = performance.now() - tIdxStart;
            console.log(`── parseMobiIndexes: ${tIndex.toFixed(0)} ms  (${inflMap.size} forms)`);
        } catch(e) {
            tIndex = performance.now() - tIdxStart;
            console.log(`── parseMobiIndexes: ${tIndex.toFixed(0)} ms  (skipped: ${e.message})`);
        }
    }

    // ── Build StarDict idx/dict buffers (without compression, without DOM) ──
    const tIdxStart2 = performance.now();
    const enc = new TextEncoder();
    const sorted = Array.from(conv.finalMap.entries()).sort(([a], [b]) =>
        a.toLowerCase().localeCompare(b.toLowerCase()));

    const nullByte = new Uint8Array(1);
    let dictChunks = [], idxChunks = [],
        dictTotalSize = 0, idxTotalSize = 0,
        offset = 0, wordToOrdinal = new Map();

    for (const [word, def] of sorted) {
        wordToOrdinal.set(word, wordToOrdinal.size);
        const db = enc.encode(def);
        const wb = enc.encode(word);
        dictChunks.push(db); dictTotalSize += db.length;
        idxChunks.push(wb);  idxTotalSize += wb.length;
        idxChunks.push(nullByte); idxTotalSize += 1;
        const dv = new DataView(new ArrayBuffer(8));
        dv.setUint32(0, offset, false);
        dv.setUint32(4, db.length, false);
        idxChunks.push(new Uint8Array(dv.buffer));
        idxTotalSize += 8;
        offset += db.length;
    }

    const concatChunks = (chunks, total) => {
        const out = new Uint8Array(total);
        let p = 0;
        for (const c of chunks) { out.set(c, p); p += c.length; }
        return out;
    };
    const idxBytes  = concatChunks(idxChunks,  idxTotalSize);
    const dictBytes = concatChunks(dictChunks, dictTotalSize);
    const tIdx = performance.now() - tIdxStart2;
    console.log(`── Build idx/dict buffers: ${tIdx.toFixed(0)} ms`);
    console.log(`   idx: ${fmtMB(idxTotalSize)}, dict: ${fmtMB(dictTotalSize)}`);

    // ── Synonyms ──
    let tSyn = 0;
    if (conv.synMap.size > 0) {
        const tSynStart = performance.now();
        const validSyns = [];
        for (const [alt, canonical] of conv.synMap) {
            if (!wordToOrdinal.has(canonical) || wordToOrdinal.has(alt)) continue;
            validSyns.push([alt, wordToOrdinal.get(canonical)]);
        }
        validSyns.sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()));
        tSyn = performance.now() - tSynStart;
        console.log(`── Build syn: ${tSyn.toFixed(0)} ms  (${validSyns.length} entries)`);
    }

    // ── Totals ──
    const wallTotal = performance.now() - wallStart;
    const cpuAfter  = process.cpuUsage(cpuBefore);
    clearInterval(sampler);

    const peakRSS  = Math.max(...memSamples.map(s => s.rss));
    const peakHeap = Math.max(...memSamples.map(s => s.heap));
    const finalMem = sampleMem();

    const cpuUserMs   = (cpuAfter.user   / 1000).toFixed(0);
    const cpuSystemMs = (cpuAfter.system / 1000).toFixed(0);

    console.log('\n═══════════════════════════════════════════════════════');
    console.log(` RESULTS  [${label}]`);
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  Wall time total : ${wallTotal.toFixed(0)} ms`);
    console.log(`    Setup         : ${tSetup.toFixed(0)} ms`);
    console.log(`    Decompress    : ${tDecomp.toFixed(0)} ms`);
    console.log(`    INDX parse    : ${tIndex.toFixed(0)} ms`);
    console.log(`    idx+dict build: ${tIdx.toFixed(0)} ms`);
    console.log(`    syn build     : ${tSyn.toFixed(0)} ms`);
    console.log(`  CPU user        : ${cpuUserMs} ms`);
    console.log(`  CPU system      : ${cpuSystemMs} ms`);
    console.log(`  Peak RSS        : ${fmtMB(peakRSS)}`);
    console.log(`  Peak heap       : ${fmtMB(peakHeap)}`);
    console.log(`  Final RSS       : ${fmtMB(finalMem.rss)}`);
    console.log(`  Final heap      : ${fmtMB(finalMem.heap)}`);
    console.log(`  Entries         : ${conv.finalMap.size}`);
    console.log(`  Synonyms        : ${conv.synMap.size}`);
    console.log('═══════════════════════════════════════════════════════\n');

    // Append to results log
    const row = [
        label,
        new Date().toISOString(),
        wallTotal.toFixed(0),
        tSetup.toFixed(0),
        tDecomp.toFixed(0),
        tIndex.toFixed(0),
        tIdx.toFixed(0),
        tSyn.toFixed(0),
        cpuUserMs,
        cpuSystemMs,
        fmtMB(peakRSS),
        fmtMB(peakHeap),
        conv.finalMap.size,
        conv.synMap.size,
    ].join('\t');

    const header = 'label\tdate\twall_ms\tsetup_ms\tdecomp_ms\tindx_ms\tidxbuild_ms\tsyn_ms\tcpu_user_ms\tcpu_sys_ms\tpeak_rss\tpeak_heap\tentries\tsynonyms';
    const logFile = resolve(__dirname, 'perf-results.tsv');
    try {
        readFileSync(logFile);
        appendFileSync(logFile, row + '\n');
    } catch {
        writeFileSync(logFile, header + '\n' + row + '\n');
    }
    console.log(`Results appended to perf-results.tsv\n`);
}

run().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});



