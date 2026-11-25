#!/usr/bin/env node

// Regression test for StarDict sort mode behavior in KOReader/sdcv.
//
// Usage:
//   node test/koreader-sort-regression.mjs /path/to/dict.mobi [/path/to/sdcv] [comma,separated,words]
//
// Env alternatives:
//   MOBI_PATH=/path/to/dict.mobi
//   SDCV_BIN=/path/to/sdcv
//   LOOKUP_WORDS=fizyka,astrofizyka,fizjoterapia

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const argMobi = process.argv[2];
const argSdcv = process.argv[3];
const argWords = process.argv[4];

const mobiPath = argMobi || process.env.MOBI_PATH || '';
const sdcvPath =
  argSdcv ||
  process.env.SDCV_BIN ||
  '/tmp/koreader-app/squashfs-root/usr/lib/koreader/sdcv';
const wordsCsv = argWords || process.env.LOOKUP_WORDS || 'fizyka,astrofizyka,fizjoterapia';
const requestedWords = wordsCsv
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!mobiPath) {
  console.error('Missing MOBI path. Pass it as argv[2] or set MOBI_PATH.');
  process.exit(2);
}
if (!existsSync(mobiPath)) {
  console.error(`MOBI file not found: ${mobiPath}`);
  process.exit(2);
}
if (!existsSync(sdcvPath)) {
  console.error(`sdcv binary not found: ${sdcvPath}`);
  process.exit(2);
}
if (requestedWords.length === 0) {
  console.error('No lookup words provided. Use argv[4] or LOOKUP_WORDS.');
  process.exit(2);
}

function load(relPath) {
  return readFileSync(join(repoRoot, relPath), 'utf8');
}

function encodeDict(finalMap, synMap, mode, bookname) {
  const useFoldedSort = mode === 'folded';
  const enc = new TextEncoder();

  const sorted = Array.from(finalMap.entries(), ([word, def]) => ({
    word,
    def,
    folded: useFoldedSort ? word.toLocaleLowerCase() : word,
  })).sort((a, b) => {
    if (a.folded < b.folded) return -1;
    if (a.folded > b.folded) return 1;
    return a.word < b.word ? -1 : a.word > b.word ? 1 : 0;
  });

  let idxEstimate = 0;
  let dictEstimate = 0;
  for (const e of sorted) {
    idxEstimate += e.word.length * 3 + 9;
    dictEstimate += e.def.length + 16;
  }

  const idxBytes = new Uint8Array(idxEstimate);
  const dictBytes = new Uint8Array(dictEstimate);
  const wordToOrdinal = new Map();

  let idxPos = 0;
  let dictOff = 0;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    wordToOrdinal.set(e.word, i);

    const wr = enc.encodeInto(e.word, idxBytes.subarray(idxPos));
    idxPos += wr.written;
    idxBytes[idxPos++] = 0;

    const hdr = idxPos;
    idxPos += 8;

    const dr = enc.encodeInto(e.def, dictBytes.subarray(dictOff));
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

  const synWords = [];
  const synOrdinals = [];
  for (const [alt, canonical] of synMap.entries()) {
    if (!wordToOrdinal.has(canonical)) continue;
    if (wordToOrdinal.has(alt)) continue;
    synWords.push(alt);
    synOrdinals.push(wordToOrdinal.get(canonical));
  }

  const synFolded = synWords.map((w) =>
    useFoldedSort ? w.toLocaleLowerCase() : w,
  );

  const synIdx = new Uint32Array(synWords.length);
  for (let i = 0; i < synIdx.length; i++) synIdx[i] = i;
  synIdx.sort((a, b) => {
    if (synFolded[a] < synFolded[b]) return -1;
    if (synFolded[a] > synFolded[b]) return 1;
    return synWords[a] < synWords[b] ? -1 : synWords[a] > synWords[b] ? 1 : 0;
  });

  let synEstimate = 0;
  for (const s of synWords) synEstimate += s.length * 2 + 5;

  const synBytes = new Uint8Array(synEstimate);
  let synPos = 0;
  for (let i = 0; i < synIdx.length; i++) {
    const si = synIdx[i];
    const r = enc.encodeInto(synWords[si], synBytes.subarray(synPos));
    synPos += r.written;
    synBytes[synPos++] = 0;

    const ord = synOrdinals[si];
    synBytes[synPos++] = (ord >>> 24) & 0xff;
    synBytes[synPos++] = (ord >>> 16) & 0xff;
    synBytes[synPos++] = (ord >>> 8) & 0xff;
    synBytes[synPos++] = ord & 0xff;
  }

  const ifo = [
    "StarDict's dict ifo file",
    'version=2.4.2',
    `wordcount=${sorted.length}`,
    `idxfilesize=${idxPos}`,
    `bookname=${bookname}`,
    'sametypesequence=h',
    `synwordcount=${synWords.length}`,
  ].join('\n') + '\n';

  return {
    ifo,
    idx: idxBytes.subarray(0, idxPos),
    dict: dictBytes.subarray(0, dictOff),
    syn: synBytes.subarray(0, synPos),
    wordcount: sorted.length,
    synwordcount: synWords.length,
  };
}

function writeDictFiles(baseDir, payload) {
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(join(baseDir, 'dict.ifo'), payload.ifo);
  writeFileSync(join(baseDir, 'dict.idx'), Buffer.from(payload.idx));
  writeFileSync(join(baseDir, 'dict.dict'), Buffer.from(payload.dict));
  writeFileSync(join(baseDir, 'dict.syn'), Buffer.from(payload.syn));
}

function sdcvHasWord(dictDir, bookname, word) {
  const res = spawnSync(
    sdcvPath,
    ['-2', dictDir, '-x', '-n', '-e', '-u', bookname, word],
    { encoding: 'utf8' },
  );
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  return /Found\s+\d+\s+items?/i.test(output);
}

function isKnownWord(finalMap, synMap, word) {
  return finalMap.has(word) || synMap.has(word);
}

async function main() {
  globalThis.addLog = () => {};
  globalThis.i18nText = (_k, fallback, vars) =>
    vars
      ? String(fallback).replace(/\{(\w+)\}/g, (_, k) =>
          vars[k] !== undefined ? String(vars[k]) : `{${k}}`,
        )
      : fallback;
  globalThis.STYLES = {
    _escapeRegExp(s) {
      return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    },
    _ensureHeadwordSpan(_word, html) {
      return html;
    },
    none(_word, pHtml) {
      return pHtml;
    },
    nice(_word, pHtml) {
      return pHtml;
    },
    eink(_word, pHtml) {
      return pHtml;
    },
    rich(_word, pHtml) {
      return pHtml;
    },
  };

  // Load the same source modules used in the browser build.
  // eslint-disable-next-line no-eval
  eval(
    load('src/mobi-index-core.js') +
      '\n' +
      load('src/huffcdic-core.js') +
      '\n' +
      load('src/kf8-converter.js') +
      '\n' +
      'globalThis.KF8Converter = KF8Converter;',
  );

  const raw = readFileSync(mobiPath);
  const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);

  const converter = new globalThis.KF8Converter(buffer, {
    style: 'none',
    generateSyn: true,
  });
  const { finalMap, synMap } = await converter.run();

  const words = requestedWords.filter((w) => isKnownWord(finalMap, synMap, w));
  if (words.length === 0) {
    console.error('None of the requested words exist in finalMap/synMap.');
    console.error(`Requested: ${requestedWords.join(', ')}`);
    process.exit(3);
  }

  const tmpBase = mkdtempSync(join(tmpdir(), 'koreader-sort-regression-'));
  const foldedDir = join(tmpBase, 'folded');
  const rawDir = join(tmpBase, 'raw');

  const foldedBook = 'Sort Regression Folded';
  const rawBook = 'Sort Regression Raw';

  const foldedPayload = encodeDict(finalMap, synMap, 'folded', foldedBook);
  const rawPayload = encodeDict(finalMap, synMap, 'raw', rawBook);

  writeDictFiles(foldedDir, foldedPayload);
  writeDictFiles(rawDir, rawPayload);

  const foldedResults = words.map((w) => [w, sdcvHasWord(foldedDir, foldedBook, w)]);
  const rawResults = words.map((w) => [w, sdcvHasWord(rawDir, rawBook, w)]);

  const foldedOk = foldedResults.every(([, ok]) => ok);
  const countsOk =
    foldedPayload.wordcount === rawPayload.wordcount &&
    foldedPayload.synwordcount === rawPayload.synwordcount;

  console.log('--- KOReader sort regression ---');
  console.log('mobi:', mobiPath);
  console.log('sdcv:', sdcvPath);
  console.log('tmp :', tmpBase);
  console.log('checked words:', words.join(', '));
  console.log('wordcount/synwordcount folded:', foldedPayload.wordcount, foldedPayload.synwordcount);
  console.log('wordcount/synwordcount raw   :', rawPayload.wordcount, rawPayload.synwordcount);
  console.log('folded lookups:', JSON.stringify(foldedResults));
  console.log('raw lookups   :', JSON.stringify(rawResults));

  if (!countsOk) {
    console.error('FAIL: folded/raw mode changed entry counts unexpectedly.');
    process.exit(1);
  }
  if (!foldedOk) {
    console.error('FAIL: folded mode lookup failed for one or more known words.');
    process.exit(1);
  }

  console.log('PASS: folded mode resolves all known words and counts match across modes.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});


