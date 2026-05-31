#!/usr/bin/env node
// build.js – assembles final HTML files from templates + shared JS sources.
//
// Usage:
//   node build.js
//
// Templates in /src/*.template.html are processed:
//   Lines matching  // @@include(path/to/file.js)
//   are replaced with the contents of the referenced file (relative to project root).
//
// Output files are written to the locations defined in OUTPUTS below.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Map: template path → output path (both relative to project root)
const OUTPUTS = [
  {
    template: "src/mobiKF8HuffConverter.template.html",
    output: "mobiKF8HuffConverter.html",
  },
  {
    template: "src/MobiReader-Huff-KF8.template.html",
    output: "Tools/MobiReader-Huff-KF8.html",
  },
  {
    template: "src/mobi7PalmDocConverter.template.html",
    output: "mobi7PalmDocConverter.html",
  },
  {
    template: "src/MobiReader-PalmDoc.template.html",
    output: "Tools/MobiReader-PalmDoc.html",
  },
  {
    template: "src/StarDictReaderValidator.template.html",
    output: "Tools/StarDictReaderValidator.html",
  },
];

const INCLUDE_RE = /^(\s*)\/\/\s*@@include\(([^)]+)\)\s*$/;
const WORKER_RE  = /^(\s*)\/\/\s*@@worker\(([^)]+)\)\s*$/;

// ── WASM compilation ──────────────────────────────────────────────────────────
// Compile src/huff-decoder.wat → src/huff-decoder.wasm once per build,
// then base64-encode the binary so it can be embedded inline in the worker.
let _wasmBase64 = null;
function getWasmBase64() {
  if (_wasmBase64 !== null) return _wasmBase64;
  const watPath  = resolve(__dirname, "src/huff-decoder.wat");
  const wasmPath = resolve(__dirname, "src/huff-decoder.wasm");
  if (!existsSync(watPath)) { _wasmBase64 = ""; return ""; }
  try {
    execSync(
      `node_modules/.bin/wat2wasm "${watPath}" -o "${wasmPath}"`,
      { cwd: __dirname, stdio: "pipe" },
    );
    _wasmBase64 = readFileSync(wasmPath).toString("base64");
    console.log(`✅  huff-decoder.wat compiled (${readFileSync(wasmPath).length} bytes → ${_wasmBase64.length} chars base64)`);
  } catch (e) {
    console.warn(`⚠   WAT compilation failed: ${e.message}. WASM disabled.`);
    _wasmBase64 = "";
  }
  return _wasmBase64;
}

// ── Recursive include processor (shared by main templates and worker source) ──
function processFile(filePath) {
  const src   = readFileSync(resolve(__dirname, filePath), "utf-8");
  const lines = src.split("\n");
  const out   = [];
  for (const line of lines) {
    const m = line.match(INCLUDE_RE);
    if (m) {
      const [, indent, inc] = m;
      const included = processFile(inc.trim());
      out.push(included.split("\n").map(l => (l.length ? indent + l : l)).join("\n"));
    } else if (/^\s*\/\/\s*@@wasm_b64\s*$/.test(line)) {
      // Replaced with: HuffCdicBase._wasmBase64 = "...base64...";
      const b64 = getWasmBase64();
      if (b64) {
        out.push(`HuffCdicBase._wasmBase64 = "${b64}";`);
      } else {
        out.push(`// WASM unavailable – JS fallback will be used`);
      }
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

// Injected automatically after <body> in every compiled output.
const NOSCRIPT = `<noscript>
<style>body>*:not(noscript){display:none!important}</style>
<div style="font-family:'Segoe UI',sans-serif;max-width:480px;margin:80px auto;padding:28px;background:#fff3cd;border:1px solid #f59e0b;border-left:4px solid #f59e0b;border-radius:10px;color:#1c1e21;">
  <strong>⚠️ JavaScript is required</strong><br><br>
  This tool processes files locally in your browser using JavaScript. Please enable JS and reload.<br>
  <small style="color:#666">JavaScript jest wymagany do działania tej strony.</small>
</div>
</noscript>`;

function processTemplate(templatePath) {
  let src = readFileSync(resolve(__dirname, templatePath), "utf-8");

  // Strip any manually-placed <noscript>…</noscript> blocks so build is the sole source.
  src = src.replace(/<noscript>[\s\S]*?<\/noscript>\n?/g, "");

  const lines = src.split("\n");
  const result = [];

  for (const line of lines) {
    // @@include(path) – inline the file content
    const mi = line.match(INCLUDE_RE);
    if (mi) {
      const [, indent, includePath] = mi;
      const included = processFile(includePath.trim());
      result.push(included.split("\n").map(l => (l.length ? indent + l : l)).join("\n"));
      continue;
    }
    // @@worker(path) – process the worker source and embed as a JS string literal
    const mw = line.match(WORKER_RE);
    if (mw) {
      const [, indent, workerPath] = mw;
      const workerSrc = processFile(workerPath.trim());
      // JSON.stringify produces a properly escaped JS string literal.
      result.push(`${indent}const __KF8_WORKER_SRC__ = ${JSON.stringify(workerSrc)};`);
      continue;
    }
    result.push(line);
  }

  // Inject <noscript> right after <body>
  const html = result.join("\n").replace(/(<body[^>]*>)/, `$1\n${NOSCRIPT}`);

  const banner = [
    "<!--",
    "  !! THIS FILE IS AUTO-GENERATED. DO NOT EDIT DIRECTLY !!",
    `  Generated by build.js from ${templatePath}`,
    "  To make changes, edit the template and/or shared files from src/*.js,",
    "  then run:  node build.js",
    "-->",
  ].join("\n");

  return banner + "\n" + html;
}

let ok = true;
for (const { template, output } of OUTPUTS) {
  try {
    const html = processTemplate(template);
    const outPath = resolve(__dirname, output);
    writeFileSync(outPath, html, "utf-8");
    console.log(`✅  ${template}  →  ${output}`);
  } catch (err) {
    console.error(`❌  ${template}: ${err.message}`);
    ok = false;
  }
}

if (!ok) process.exit(1);
console.log("\nBuild complete.");

// ── Second pass: inject <noscript> into ALL html files in the project ─────────
// Covers compiled outputs, standalone tools, index.html — everything.
function injectNoscript(filePath) {
  let html = readFileSync(filePath, "utf-8");
  // Strip any existing noscript block first (idempotent)
  html = html.replace(/<noscript>[\s\S]*?<\/noscript>\n?/g, "");
  // Inject after <body ...>
  if (!html.includes("<body")) return; // skip non-body files
  html = html.replace(/(<body[^>]*>)/, `$1\n${NOSCRIPT}`);
  writeFileSync(filePath, html, "utf-8");
}

const HTML_DIRS = [__dirname, resolve(__dirname, "Tools")];
let injected = 0;
for (const dir of HTML_DIRS) {
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".html")) {
      injectNoscript(resolve(dir, file));
      injected++;
    }
  }
}
console.log(`✅  Noscript injected into ${injected} HTML file(s).`);
