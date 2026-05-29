#!/usr/bin/env node
// Quick Node.js test of parseMobiIndexes with the SJP2 MOBI file
// Use ORDT-decoded headwords as externalHeadwords
const fs = require("fs");

eval(
  fs.readFileSync(
    "/media/Dane/Dokumenty/Projekty/VibeCode/mobiDictToStarDictConverter/src/mobi-index-core.js",
    "utf8",
  ),
);

const mobiPath = "/home/random9/Downloads/SJP2-202507140955.mobi";
const raw = fs.readFileSync(mobiPath);
const data = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

const n = (data[76] << 8) | data[77];
const recOffsets = [];
for (let i = 0; i < n; i++) {
  const off =
    (data[78 + i * 8] << 24) |
    (data[79 + i * 8] << 16) |
    (data[80 + i * 8] << 8) |
    data[81 + i * 8];
  recOffsets.push(off >>> 0);
}

// Load properly ORDT-decoded headwords
const orthWords = JSON.parse(fs.readFileSync("/tmp/orth_words.json", "utf8"));
console.log(`External headwords: ${orthWords.length}`);
console.log(`pies at: ${orthWords.indexOf("pies")}`);

console.log(`\nTesting parseMobiIndexes with externalHeadwords...`);
const inflMap = parseMobiIndexes(
  data,
  recOffsets,
  (msg) => console.log("[LOG]", msg),
  orthWords,
);

console.log(`\nResults:`);
console.log(`Total inflected forms: ${inflMap.size}`);

const tests = [
  "psa",
  "psy",
  "psem",
  "psom",
  "psu",
  "psach",
  "psami",
  "psów",
  "kota",
  "koty",
  "kotem",
  "kocie",
  "kotów",
  "kotu",
  "domu",
  "domie",
  "domy",
  "domów",
  "piesek",
  "pieska",
  "pieskiem",
];
console.log("\nKey form lookups:");
for (const form of tests) {
  const canonical = inflMap.get(form);
  console.log(`  ${form} → ${canonical || "NOT FOUND"}`);
}
