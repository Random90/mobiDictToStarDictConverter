// ── i18n: language detection, application & toggle ───────────────────────────
// Only non-English translations are needed in I18N - English is read directly
// from the initial HTML, cached on first run, and restored when switching back.
// Expects a global `const I18N = { pl: {...} }` defined before this file.

var _i18nCache = {};
(function _buildCache() {
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
        _i18nCache[el.getAttribute('data-i18n')] = el.textContent;
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function(el) {
        _i18nCache['html:' + el.getAttribute('data-i18n-html')] = el.innerHTML;
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function(el) {
        _i18nCache['ph:' + el.getAttribute('data-i18n-ph')] = el.placeholder;
    });
})();

(function () {
    var stored = localStorage.getItem('lang');
    var auto   = navigator.language && navigator.language.startsWith('pl') ? 'pl' : 'en';
    window.LANG  = stored || auto;
    document.documentElement.lang = window.LANG;
})();

function applyI18n() {
    var t = I18N[window.LANG] || {};
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
        var key = el.getAttribute('data-i18n');
        el.textContent = key in t ? t[key] : (_i18nCache[key] || '');
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function(el) {
        var key = el.getAttribute('data-i18n-html');
        el.innerHTML = key in t ? t[key] : (_i18nCache['html:' + key] || '');
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function(el) {
        var key = el.getAttribute('data-i18n-ph');
        el.placeholder = key in t ? t[key] : (_i18nCache['ph:' + key] || '');
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

document.addEventListener('DOMContentLoaded', applyI18n);
