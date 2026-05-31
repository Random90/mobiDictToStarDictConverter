// ─────────────────────────────────────────────────────────────────────────────
// STYLES – entry HTML post-processors.
// Each function receives (word, pHtml) and returns styled HTML.
// Used by both the main page and the KF8 Web Worker.
// ─────────────────────────────────────────────────────────────────────────────
const STYLES = {
  _escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  },

  _ensureHeadwordSpan(word, html) {
    if (/<span\s*>\s*<b>[\s\S]*?<\/b>\s*<\/span>/i.test(html))
      return html;
    const w = (word || "").trim();
    if (!w) return html;
    const escaped = STYLES._escapeRegExp(w);

    // Convert a leading header block (<h1>..</h1> ... <h6>..</h6>) into canonical span/b form.
    const hMatch = html.match(
      /^\s*<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>\s*/i,
    );
    if (hMatch) {
      const plain = hMatch[2]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const reLeadWord = new RegExp(`^${escaped}(?:\\b|\\s)`, "i");
      if (reLeadWord.test(plain)) {
        const tail = plain
          .replace(new RegExp(`^${escaped}\\s*`, "i"), "")
          .trim();
        const rest = html.slice(hMatch[0].length);
        return `<span><b>${w}</b></span>${tail ? ` ${tail}` : ""}${rest ? ` ${rest}` : ""}`.trim();
      }
    }

    // Fallback: replace leading plain-word occurrence.
    const leadRe = new RegExp(`^\\s*${escaped}(?:\\b|\\s*)`, "i");
    if (leadRe.test(html)) {
      return html.replace(leadRe, `<span><b>${w}</b></span> `);
    }
    return html;
  },

  none(word, pHtml) {
    return pHtml;
  },

  clean(word, pHtml) {
    // Strip width attribute and all inline styles; keep semantics
    return pHtml
      .replace(/ width="[^"]*"/gi, "")
      .replace(/ style="[^"]*"/gi, "");
  },

  nice(word, pHtml) {
    pHtml = STYLES._ensureHeadwordSpan(word, pHtml);
    // Colour POS tags inside <i>
    let body = pHtml
      .replace(
        /(<i>(?:n|v|adj|adv|prep|conj|pron|interj|abbr|acr)\.?<\/i>)/g,
        '<span style="color:#c0392b;font-weight:bold">$1</span>',
      )
      // bold sense numbers
      .replace(
        /\b(<b>(\d+)\.<\/b>)/g,
        '<span style="color:#2980b9;font-weight:bold">$1</span>',
      );
    // Replace the first <span><b>word</b></span> with a styled headword
    body = body.replace(
      /(<span\s*>\s*<b>)([\s\S]*?)(<\/b>\s*<\/span>)/,
      `<span><b style="font-size:1.15em;color:#003d82">$2</b></span>`,
    );
    return body;
  },

  eink(word, pHtml) {
    pHtml = STYLES._ensureHeadwordSpan(word, pHtml);
    const ipaM = pHtml.match(/(?<!<)\/([^/<]{2,60})\//);
    const ipa = ipaM
      ? ` <span style="font-size:.9em;font-style:italic">/${ipaM[1]}/</span>`
      : "";
    let body = ipaM ? pHtml.replace(ipaM[0], "") : pHtml;

    body = body
      .replace(/<b>(\d+)\.<\/b>/g, "<b>$1.</b>")
      .replace(/(<i>(?:[a-z]{2,5})\.<\/i>)/g, "<small>$1</small>")
      .replace(
        /(<i>(?:n|v|adj|adv|prep|conj|pron|interj|abbr|acr)\.?<\/i>)/g,
        "<b>$1</b>",
      );

    let seenHeadword = false;
    body = body.replace(
      /<span\s*>\s*<b[^>]*>([\s\S]*?)<\/b>\s*<\/span>/gi,
      (m, inner) => {
        if (!seenHeadword) {
          seenHeadword = true;
          return (
            `<span style="display:block;border-left:2px solid #000;padding-left:7px;margin-bottom:4px">` +
            `<b style="font-size:1.18em">${inner}</b>${ipa}</span>`
          );
        }
        const plain = inner
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (
          plain.length >= 3 &&
          plain.length <= 80 &&
          plain.includes(" ")
        ) {
          return `<span><b style="text-decoration:underline">${inner}</b></span>`;
        }
        return m;
      },
    );
    return body;
  },

  rich(word, pHtml) {
    pHtml = STYLES._ensureHeadwordSpan(word, pHtml);
    const ipaM = pHtml.match(/(?<!<)\/([^/<]{2,60})\//);
    const ipa = ipaM
      ? ` <span style="background:#eef5ff;color:#0366d6;padding:1px 5px;border-radius:3px;font-size:.83em">/${ipaM[1]}/</span>`
      : "";
    let body = ipaM
      ? pHtml.replace(ipaM[0], "") // remove the matched IPA from body so it doesn't appear twice
      : pHtml;
    body = body
      // POS tags red
      .replace(
        /(<i>(?:n|v|adj|adv|prep|conj|pron|interj|abbr|acr)\.?<\/i>)/g,
        '<b style="color:#e74c3c">$1</b>',
      )
      // Sense numbers blue - only match <b>N.</b> to avoid injecting tags inside HTML attributes
      .replace(/<b>(\d+)\.<\/b>/g, '<b style="color:#1565c0">$1.</b>')
      // Domain labels (fin. biz. etc.) violet + small
      .replace(
        /(<i>(?:[a-z]{2,5})\.<\/i>)/g,
        '<span style="color:#7c3aed;font-size:.83em">$1</span>',
      );

    // Style span-headwords in one pass: first is the main headword, later multi-word spans are sub-phrases.
    let seenHeadword = false;
    body = body.replace(
      /<span\s*>\s*<b[^>]*>([\s\S]*?)<\/b>\s*<\/span>/gi,
      (m, inner) => {
        if (!seenHeadword) {
          seenHeadword = true;
          return (
            `<span style="display:block;border-left:3px solid #2980b9;padding-left:7px;margin-bottom:4px">` +
            `<b style="font-size:1.18em;color:#1a237e">${inner}</b>${ipa}</span>`
          );
        }
        const plain = inner
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (
          plain.length >= 3 &&
          plain.length <= 80 &&
          plain.includes(" ")
        ) {
          return `<span><b style="color:#5c4b00">${inner}</b></span>`;
        }
        return m;
      },
    );
    return body;
  },
};

