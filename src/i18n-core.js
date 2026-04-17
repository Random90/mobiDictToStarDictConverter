// ── i18n: language detection, application & toggle ───────────────────────────
// Expects a global `const I18N = { en: {...}, pl: {...} }` defined before this
// file is included. All text lives only in I18N — HTML elements are empty shells.

(function () {
    var stored = localStorage.getItem('lang');
    var auto   = navigator.language && navigator.language.startsWith('pl') ? 'pl' : 'en';
    window.LANG  = stored || auto;
    document.documentElement.lang = window.LANG;
})();

function applyI18n() {
    var t = I18N[window.LANG] || I18N.en;
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
        var v = t[el.getAttribute('data-i18n')];
        if (v !== undefined) el.textContent = v;
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function(el) {
        var v = t[el.getAttribute('data-i18n-html')];
        if (v !== undefined) el.innerHTML = v;
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function(el) {
        var v = t[el.getAttribute('data-i18n-ph')];
        if (v !== undefined) el.placeholder = v;
    });
    var btn = document.getElementById('langToggle');
    if (btn) btn.textContent = window.LANG === 'pl' ? '🇬🇧 EN' : '🇵🇱 PL';
}

function toggleLang() {
    window.LANG = window.LANG === 'pl' ? 'en' : 'pl';
    localStorage.setItem('lang', window.LANG);
    document.documentElement.lang = window.LANG;
    applyI18n();
}

// Script is always placed at the end of <body> — DOM is ready, safe to apply immediately.
applyI18n();
