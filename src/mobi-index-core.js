// ─────────────────────────────────────────────────────────────────────────────
// parseMobiIndexes – shared MOBI ORTH+INFL binary index decoder
// Used by both the KF8/HUFF (huffcdic-core.js) and PalmDoc (palmdoc-core.js)
// converters.  INDX records are part of the MOBI container format and can
// exist in both MOBI7 (PalmDoc) and MOBI8 (KF8) dictionary files.
//
// Parameters:
//   raw               – Uint8Array of the entire .mobi file
//   recsOffsets       – flat Array<number> of record start offsets within raw
//   logFn             – optional logging callback
//   externalHeadwords – optional Array<string> of HTML-extracted headwords
//                       (indexed by ORTH ordinal); when supplied the ORTH
//                       binary labels are not decoded and lookups use this
//                       list instead, giving correctly encoded Polish text.
//
// Returns Map<string, string>: inflectedForm → canonicalHeadword.
//
// INFL binary format (MOBI INDX):
//   ORTH entries have tag42 = inflection group ID (1..N)
//   INFL entries fall into two categories:
//     A) Paradigm template entries (empty label, tag26 present):
//        tag26 = list of INFL form-entry ordinals belonging to this paradigm.
//        The INFL ordinal G of the template equals the paradigm group ID,
//        matching ORTH tag42=G.
//     B) Form entries (non-empty label, no tag26):
//        Label encodes the inflected form as reversed suffix chunks:
//          [0x02][reversed_form_suffix][0x03][reversed_canonical_suffix]
//        Inflected form = (canonical stripped of canonical_suffix) + form_suffix
//        Label bytes starting with 0x01 are grammar/metadata entries (skipped).
// ─────────────────────────────────────────────────────────────────────────────
function parseMobiIndexes(raw, recsOffsets, logFn, externalHeadwords) {
  const log = logFn || (typeof addLog === 'function' ? addLog : () => {});
  const inflMap = new Map();
  const utf8 = new TextDecoder('utf-8', { fatal: false });
  const totalLen = raw.length;

  const getRec = (i) => {
    const s = recsOffsets[i];
    const e = i + 1 < recsOffsets.length ? recsOffsets[i + 1] : totalLen;
    return raw.slice(s, e);
  };

  const ru32 = (a, o) =>
    ((a[o] << 24) | (a[o + 1] << 16) | (a[o + 2] << 8) | a[o + 3]) >>> 0;
  const ru16 = (a, o) => ((a[o] << 8) | a[o + 1]) >>> 0;

  // Variable-width integer: high bit (0x80) SET = last byte.
  const readVWI = (a, p) => {
    let v = 0;
    while (p < a.length) {
      const b = a[p++];
      v = ((v << 7) | (b & 0x7f)) >>> 0;
      if (b & 0x80) break;
    }
    return [v, p];
  };

  // Lowest-set-bit position of a bitmask.
  const maskShift = (mask) => {
    if (!mask) return 0;
    let s = 0, m = mask;
    while (m && !(m & 1)) { s++; m >>>= 1; }
    return s;
  };

  // Parse TAGX section within rec at tagxOff.
  const parseTagx = (rec, tagxOff) => {
    if (tagxOff + 12 > rec.length) return null;
    if (rec[tagxOff] !== 0x54 || rec[tagxOff + 1] !== 0x41 ||
        rec[tagxOff + 2] !== 0x47 || rec[tagxOff + 3] !== 0x58) return null;
    const tagxLen = ru32(rec, tagxOff + 4);
    const ctrlByteCount = ru32(rec, tagxOff + 8);
    const nTags = Math.floor((tagxLen - 12) / 4);
    const tags = [];
    for (let i = 0; i < nTags; i++) {
      const b = tagxOff + 12 + i * 4;
      tags.push({
        tag:     rec[b],
        numVals: rec[b + 1],
        mask:    rec[b + 2],
        end:     rec[b + 3],
        shift:   maskShift(rec[b + 2]),
      });
    }
    return { ctrlByteCount, tags };
  };

  // Parse all entries from an INDX data sub-record.
  // Entry layout: [labelLen:u8][label bytes][ctrlBytes][VWI tag values…]
  //
  // Returns array of { labelBytes, tagVals } objects.
  const parseSubRec = (rec, tagx) => {
    if (rec.length < 0x20) return [];
    const nEntries = ru32(rec, 0x18);
    const idxtOff  = ru32(rec, 0x14);
    if (nEntries === 0 || idxtOff === 0 ||
        idxtOff + 4 + nEntries * 2 > rec.length) return [];
    if (rec[idxtOff]     !== 0x49 || rec[idxtOff + 1] !== 0x44 ||
        rec[idxtOff + 2] !== 0x58 || rec[idxtOff + 3] !== 0x54) return [];

    const entries = [];
    for (let i = 0; i < nEntries; i++) {
      if (idxtOff + 4 + i * 2 + 2 > rec.length) break;
      const entryOff = ru16(rec, idxtOff + 4 + i * 2);
      let pos = entryOff;
      if (pos + 1 > rec.length) break;

      // Single-byte label length, then label bytes
      const labelLen = rec[pos++];
      if (pos + labelLen > rec.length) break;
      const labelBytes = rec.slice(pos, pos + labelLen);
      pos += labelLen;

      if (pos + tagx.ctrlByteCount > rec.length) break;
      const ctrlBytes = rec.slice(pos, pos + tagx.ctrlByteCount);
      pos += tagx.ctrlByteCount;

      // Two-pass tag-value parsing (mirrors KindleUnpack's getTagMap design):
      //
      // Pass 1 – scan control bits and, for *extended* tags (multi-bit mask
      //   all set), read the VWI byte-count header immediately.  ALL byte-count
      //   VWIs for ALL tags are consumed first, advancing pos past the header
      //   block.  Direct-count tags consume nothing here.
      //
      // Pass 2 – read actual VWI values in tag order, using the counts collected
      //   in pass 1.  This ordering matches the on-disk layout:
      //     [ctrl][byteCount_T1][byteCount_T2]…[values_T1][values_T2]…
      //
      const tagSpecs = [];
      const tagVals = {};
      let cbIdx = 0;
      for (const t of tagx.tags) {
        if (t.mask !== 0 && cbIdx < ctrlBytes.length) {
          const maskedVal = ctrlBytes[cbIdx] & t.mask;
          if (maskedVal !== 0) {
            const maskBits = t.mask.toString(2).split('').filter(c => c === '1').length;
            if (maskBits > 1 && maskedVal === t.mask) {
              // Extended: consume the VWI byte-count header NOW (pass 1).
              const [byteCount, np0] = readVWI(rec, pos);
              pos = np0;
              tagSpecs.push({ tag: t.tag, count: null, byteCount });
            } else {
              // Direct: count is encoded in the control bits, no header to read.
              const flagValue = maskedVal >>> t.shift;
              const count = t.numVals * flagValue;
              tagSpecs.push({ tag: t.tag, count, byteCount: null });
            }
          }
        }
        if (t.end) cbIdx++;
      }
      // Pass 2 – read VWI values for each tag in order.
      for (const spec of tagSpecs) {
        const vals = [];
        if (spec.count !== null) {
          for (let v = 0; v < spec.count && pos < rec.length; v++) {
            const [val, np] = readVWI(rec, pos);
            vals.push(val);
            pos = np;
          }
        } else {
          const limit = pos + spec.byteCount;
          while (pos < limit && pos < rec.length) {
            const [val, np] = readVWI(rec, pos);
            vals.push(val);
            pos = np;
          }
        }
        tagVals[spec.tag] = vals;
      }
      entries.push({ labelBytes, tagVals });
    }
    return entries;
  };

  // Reverse a Uint8Array byte-by-byte (for reversed UTF-8 suffix chunks).
  const reverseBytes = (arr) => {
    const r = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) r[i] = arr[arr.length - 1 - i];
    return r;
  };

  // Parse a Type-B INFL form entry label.
  // Returns { formSuffix, canonicalSuffix } or null if not a Type-B entry.
  //
  // Label format:  [0x02][reversed_form_suffix_bytes][0x03][reversed_canonical_suffix_bytes]
  //   - 0x02 chunk (mandatory): reversed bytes → form suffix string
  //   - 0x03 chunk (optional):  reversed bytes → canonical suffix string (empty = no stripping)
  //   - 0x01 prefix entries are grammar/metadata (Type A) – skipped by returning null
  //   - Other marker bytes (0x04, 0x0c, …) are ignored
  const parseFormLabel = (lb) => {
    if (!lb || lb.length === 0 || lb[0] === 0x01) return null;

    let formSuffixBytes = null;
    let canonicalSuffixBytes = null;

    let i = 0;
    while (i < lb.length) {
      const marker = lb[i++];
      // Read chunk until next control byte (< 0x20) or end
      const start = i;
      while (i < lb.length && lb[i] >= 0x20) i++;
      const chunk = lb.slice(start, i);

      if (marker === 0x02) formSuffixBytes = chunk;
      else if (marker === 0x03) canonicalSuffixBytes = chunk;
      // 0x04, 0x0c, etc. → ignore
    }

    if (!formSuffixBytes) return null;

    const formSuffix      = utf8.decode(reverseBytes(formSuffixBytes));
    const canonicalSuffix = canonicalSuffixBytes
      ? utf8.decode(reverseBytes(canonicalSuffixBytes))
      : '';

    return { formSuffix, canonicalSuffix };
  };

  // Scan all records to build INDX groups (control record + data sub-records).
  const groups = [];
  let cur = null;
  for (let i = 0; i < recsOffsets.length; i++) {
    const s = recsOffsets[i];
    if (totalLen - s < 4) continue;
    if (raw[s]     !== 0x49 || raw[s + 1] !== 0x4E ||
        raw[s + 2] !== 0x44 || raw[s + 3] !== 0x58) continue;

    const rec    = getRec(i);
    if (rec.length < 8) continue;
    const hdrLen = ru32(rec, 4);
    if (hdrLen >= rec.length) continue;

    const tagx = parseTagx(rec, hdrLen);
    if (tagx) {
      cur = { ctrlRecIdx: i, tagx, subRecs: [] };
      groups.push(cur);
    } else if (cur) {
      cur.subRecs.push(i);
    }
  }

  log(`MOBI INDX: found ${groups.length} index group(s)` +
    (groups.length > 0
      ? '. Tags: ' + groups.map(g =>
          '[' + g.tagx.tags.map(t => t.tag).join(',') + ']'
        ).join(' | ')
      : ' (no INDX records in this file).'));

  if (groups.length < 2) return inflMap;

  // Identify groups by TAGX tag numbers:
  //   ORTH: contains tag 42 (infl_group_ref)
  //   INFL: contains tag 26 (form entry list in paradigm templates)
  //         also contains tag 27 in form entries, but group is identified by tag 26
  const orthGroup = groups.find(g => g.tagx.tags.some(t => t.tag === 42));
  const inflGroup = groups.find(g => g.tagx.tags.some(t => t.tag === 26 || t.tag === 27));

  if (!orthGroup) {
    log('MOBI INDX: ORTH group not found (no tag 42). Not a dictionary INDX.');
    return inflMap;
  }
  if (!inflGroup) {
    log('MOBI INDX: INFL group not found (no tag 26/27). No inflection index present.');
    return inflMap;
  }

  log(`MOBI INDX: ORTH group has ${orthGroup.subRecs.length} sub-record(s), ` +
      `INFL group has ${inflGroup.subRecs.length} sub-record(s).`);

  // Build ordered ORTH headwords array from all ORTH sub-records.
  let orthHeadwords;
  if (Array.isArray(externalHeadwords) && externalHeadwords.length > 0) {
    orthHeadwords = externalHeadwords;
    log(`MOBI INDX: using ${orthHeadwords.length} external (HTML) ORTH headwords.`);
  } else {
    orthHeadwords = [];
    for (const ri of orthGroup.subRecs) {
      for (const e of parseSubRec(getRec(ri), orthGroup.tagx)) {
        const printable = e.labelBytes.filter(b => b >= 0x05);
        orthHeadwords.push(utf8.decode(printable));
      }
    }
    log(`MOBI INDX: decoded ${orthHeadwords.length} ORTH headwords from binary.`);
  }

  if (orthHeadwords.length === 0) return inflMap;

  // ── Step 1: Pre-load ALL INFL entries into a flat array ─────────────────────
  //
  // INFL entries fall into two types by their position:
  //   - Paradigm template entries (empty label, tag26): one per inflection group G,
  //     at ordinal == G.  Their tag26 lists the ordinals of all form entries that
  //     belong to this paradigm.
  //   - Form entries (non-empty label, tag27): encode a specific inflected form
  //     via reversed-suffix label bytes.
  //
  // We pre-load everything so we can do O(1) random access by ordinal.
  //
  const inflEntries = [];
  for (const ri of inflGroup.subRecs) {
    for (const e of parseSubRec(getRec(ri), inflGroup.tagx)) {
      inflEntries.push(e);
    }
  }
  log(`MOBI INDX: pre-loaded ${inflEntries.length} INFL entries.`);

  // ── Step 2: Build groupHeadwords from ORTH ──────────────────────────────────
  //
  // For every ORTH entry that carries tag42=G, store its headword text
  // in groupHeadwords[G].  We collect ALL headwords per group (not just the
  // first) so we can generate inflected forms for each headword separately
  // (e.g., for group 5566: 'arcypies', 'kunopies', 'pies' each get their own
  // inflected forms 'arcypsa', 'kunopsa', 'psa' etc.).
  //
  const groupHeadwords = new Map(); // G → string[]
  {
    let oOrd = 0;
    for (const ri of orthGroup.subRecs) {
      for (const e of parseSubRec(getRec(ri), orthGroup.tagx)) {
        const t42 = e.tagVals[42];
        if (t42 && t42.length > 0) {
          const g = t42[0];
          if (!groupHeadwords.has(g)) groupHeadwords.set(g, []);
          const hw = orthHeadwords[oOrd];
          if (hw) groupHeadwords.get(g).push(hw);
        }
        oOrd++;
      }
    }
    log(`MOBI INDX: ${groupHeadwords.size} paradigm groups found ` +
        `(${[...groupHeadwords.values()].reduce((s, a) => s + a.length, 0)} headwords). ` +
        `Sample: ` + [...groupHeadwords.entries()].slice(0, 3)
            .map(([g, ws]) => `G${g}→[${ws.slice(0,2).map(w=>`"${w}"`).join(',')}]`).join(', '));
  }

  if (groupHeadwords.size === 0) {
    log('MOBI INDX: no tag42 values found in ORTH entries — cannot build inflection map.');
    return inflMap;
  }

  // ── Step 3: Process paradigm templates → derive inflected forms ─────────────
  //
  // A paradigm template entry at INFL ordinal G corresponds to group G.
  // Its tag26 list contains ordinals of form entries.  Each form entry's label
  // encodes the inflected form via reversed-suffix chunks:
  //
  //   label = [0x02][rev_form_bytes][0x03][rev_canonical_bytes]
  //
  // Algorithm for each (canonical, form_entry) pair:
  //   canonical_suffix = reverse(rev_canonical_bytes)
  //   form_suffix      = reverse(rev_form_bytes)
  //   if canonical.endsWith(canonical_suffix):
  //     stem = canonical[:-len(canonical_suffix)]
  //     form = stem + form_suffix
  //     inflMap.set(form, canonical)   ← unless form == canonical
  //
  {
    let templatesProcessed = 0;
    let formRefsTotal = 0;
    let formRefsParsed = 0;

    for (let G = 0; G < inflEntries.length; G++) {
      const tmpl = inflEntries[G];
      const t26 = tmpl.tagVals[26];
      if (!t26 || t26.length === 0) continue; // not a template

      const headwords = groupHeadwords.get(G);
      if (!headwords || headwords.length === 0) continue;

      templatesProcessed++;
      formRefsTotal += t26.length;

      for (const formOrd of t26) {
        if (formOrd >= inflEntries.length) continue;
        const formEntry = inflEntries[formOrd];
        const parsed = parseFormLabel(formEntry.labelBytes);
        if (!parsed) continue;

        formRefsParsed++;
        const { formSuffix, canonicalSuffix } = parsed;

        for (const canonical of headwords) {
          let stem;
          if (canonicalSuffix) {
            if (!canonical.endsWith(canonicalSuffix)) continue;
            stem = canonical.slice(0, canonical.length - canonicalSuffix.length);
          } else {
            stem = canonical;
          }
          const form = stem + formSuffix;
          if (form && form !== canonical) {
            inflMap.set(form, canonical);
          }
        }
      }
    }

    log(`MOBI INDX DIAG: templates=${templatesProcessed}, ` +
        `formRefs=${formRefsTotal}, parsed=${formRefsParsed}, mapped=${inflMap.size}`);
  }

  log(`MOBI INDX: mapped ${inflMap.size} inflected forms.` +
    (inflMap.size > 0
      ? ' Sample: ' + [...inflMap.entries()].slice(0, 5).map(([k, v]) => `${k}→${v}`).join(', ')
      : ''));

  return inflMap;
}

