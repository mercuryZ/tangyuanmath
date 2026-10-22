/* Tangyuan Math — i18n（DESIGN.md 4.1）
 * - 语言包为 locales/en.js / locales/zh.js（script 引入，兼容 file:// 与 http）；
 * - 用户选择（localStorage tm_lang）优先于浏览器语言检测；
 * - 只做初始建议，不强制跳转；页面正确设置 <html lang>；
 * - t(key, vars)：缺失键回退英文，再回退键名本身，避免裸键破坏界面。
 */
(function (global) {
  'use strict';

  var LANG_KEY = 'tm_lang';
  var SUPPORTED = ['en', 'zh'];

  function readStored() {
    try { return global.localStorage.getItem(LANG_KEY); } catch (e) { return null; }
  }

  function browserSuggest() {
    var nav = (global.navigator && (global.navigator.language || global.navigator.userLanguage)) || 'en';
    return nav.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
  }

  var current = (function () {
    var stored = readStored();
    if (stored && SUPPORTED.indexOf(stored) !== -1) return stored; // 用户选择优先
    return browserSuggest(); // 浏览器语言仅作默认建议
  })();

  function pack(lang) {
    var packs = global.TM_I18N || {};
    return packs[lang] || {};
  }

  function t(key, vars) {
    var s = pack(current)[key];
    if (s === undefined) s = pack('en')[key]; // 回退英文
    if (s === undefined) return key;          // 最后回退键名
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = s.split('{' + k + '}').join(String(vars[k]));
      });
    }
    return s;
  }

  /* 将 data-i18n / data-i18n-aria-label / data-i18n-title / data-i18n-placeholder 应用到 DOM */
  function applyI18n(root) {
    (root || document).querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    (root || document).querySelectorAll('[data-i18n-aria-label]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
    });
    (root || document).querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
    (root || document).querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
  }

  function setLang(lang, persist) {
    if (SUPPORTED.indexOf(lang) === -1) return;
    current = lang;
    if (persist !== false) {
      try { global.localStorage.setItem(LANG_KEY, lang); } catch (e) { /* 忽略 */ }
    }
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    applyI18n(document);
    document.dispatchEvent(new CustomEvent('tm:langchange', { detail: { lang: lang } }));
  }

  var api = {
    t: t,
    lang: function () { return current; },
    suggested: browserSuggest,
    setLang: setLang,
    applyI18n: applyI18n
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.TMI18N = api;
})(typeof window !== 'undefined' ? window : globalThis);
