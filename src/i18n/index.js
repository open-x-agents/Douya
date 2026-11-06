import { messages, DEFAULT_LOCALE, LOCALES, DONE_VERB_KEYS } from './messages.js'

export { messages, DEFAULT_LOCALE, LOCALES, DONE_VERB_KEYS }

const LS_KEY = 'odm.lang'

export function normalizeLang(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (s.startsWith('zh')) return 'zh'
  if (s.startsWith('en')) return 'en'
  return null
}

/** Resolve locale from explicit value, cookie/header-ish input, or default English. */
export function resolveLang(input) {
  if (typeof input === 'string') {
    const n = normalizeLang(input)
    if (n) return n
  }
  if (input && typeof input === 'object') {
    for (const k of ['lang', 'locale', 'x-odm-lang', 'X-ODM-Lang', 'accept-language', 'Accept-Language']) {
      if (input[k]) {
        const n = normalizeLang(String(input[k]).split(',')[0])
        if (n) return n
      }
    }
    if (typeof input.get === 'function') {
      const h = input.get('x-odm-lang') || input.get('X-ODM-Lang') || input.get('accept-language')
      const n = normalizeLang(h && String(h).split(',')[0])
      if (n) return n
    }
  }
  return DEFAULT_LOCALE
}

export function t(key, lang = DEFAULT_LOCALE, vars = {}) {
  const loc = normalizeLang(lang) || DEFAULT_LOCALE
  const table = messages[loc] || messages[DEFAULT_LOCALE]
  let s = table[key] ?? messages[DEFAULT_LOCALE][key] ?? key
  if (vars && typeof vars === 'object') {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v ?? ''))
    }
  }
  return s
}

export function doneVerb(action, lang = DEFAULT_LOCALE) {
  const key = DONE_VERB_KEYS[action] || 'verb.done'
  return t(key, lang)
}

/** Build DONE_VERB map for a locale (compat with older call sites). */
export function doneVerbMap(lang = DEFAULT_LOCALE) {
  const out = {}
  for (const [action, key] of Object.entries(DONE_VERB_KEYS)) out[action] = t(key, lang)
  return out
}

export function hhmmFor(lang, d = new Date()) {
  const loc = (normalizeLang(lang) || DEFAULT_LOCALE) === 'zh' ? 'zh-CN' : 'en-GB'
  return new Date(d).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function formatOutcomeText({ ok, action, summary, error, time, cardDone, marked, lang = DEFAULT_LOCALE }) {
  const verb = doneVerb(action, lang)
  const summaryText = summary || action || ''
  if (ok) {
    if (cardDone) return t('outcome.ok_tucked', lang, { verb, time, summary: summaryText })
    if (marked) return t('outcome.ok_marked', lang, { verb, time, summary: summaryText })
    return t('outcome.ok', lang, { verb, time, summary: summaryText })
  }
  const err = error || (lang === 'zh' ? '未知原因' : 'unknown reason')
  const sendish = /reply|send/.test(String(action || ''))
  return t(sendish ? 'outcome.fail_send' : 'outcome.fail', lang, { error: err })
}

export function formatHistoryOutcome({ status, action, summary, time, lang = DEFAULT_LOCALE }) {
  const verb = doneVerb(action, lang)
  if (status === 'undone') return t('outcome.hist_undone', lang, { time, summary })
  return t('outcome.hist_sent', lang, { verb, time, summary })
}

/** Classic script the Muse HTML loads (single source: messages.js). */
export function browserScript() {
  const payload = JSON.stringify({ messages, DEFAULT_LOCALE, LOCALES, DONE_VERB_KEYS, LS_KEY })
  return `/*! odm i18n — generated from src/i18n/messages.js */
(function (root) {
  'use strict';
  var DATA = ${payload};
  var locale = DATA.DEFAULT_LOCALE;
  try {
    var saved = root.localStorage && root.localStorage.getItem(DATA.LS_KEY);
    if (saved && DATA.LOCALES.indexOf(saved) >= 0) locale = saved;
  } catch (_) {}

  function normalize(raw) {
    var s = String(raw || '').trim().toLowerCase();
    if (s.indexOf('zh') === 0) return 'zh';
    if (s.indexOf('en') === 0) return 'en';
    return null;
  }

  function t(key, vars, lang) {
    var loc = normalize(lang) || locale || DATA.DEFAULT_LOCALE;
    var table = DATA.messages[loc] || DATA.messages[DATA.DEFAULT_LOCALE];
    var s = (table && table[key]) || DATA.messages[DATA.DEFAULT_LOCALE][key] || key;
    if (vars && typeof vars === 'object') {
      Object.keys(vars).forEach(function (k) {
        s = s.split('{' + k + '}').join(String(vars[k] == null ? '' : vars[k]));
      });
    }
    return s;
  }

  function setLocale(next) {
    var n = normalize(next) || DATA.DEFAULT_LOCALE;
    locale = n;
    try { root.localStorage && root.localStorage.setItem(DATA.LS_KEY, n); } catch (_) {}
    try { document.documentElement.lang = n === 'zh' ? 'zh-CN' : 'en'; } catch (_) {}
    applyDom();
    try { root.dispatchEvent(new CustomEvent('odm:locale', { detail: { lang: n } })); } catch (_) {}
    return n;
  }

  function getLocale() { return locale; }

  function applyDom(rootEl) {
    var scope = rootEl || document;
    if (!scope || !scope.querySelectorAll) return;
    scope.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      if (!key) return;
      var attr = el.getAttribute('data-i18n-attr');
      var val = t(key);
      if (attr) el.setAttribute(attr, val);
      else el.textContent = val;
    });
    scope.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-html');
      if (key) el.innerHTML = t(key);
    });
    var titleKey = document.documentElement.getAttribute('data-i18n-title');
    if (titleKey) document.title = t(titleKey);
  }

  function doneVerb(action) {
    var key = DATA.DONE_VERB_KEYS[action] || 'verb.done';
    return t(key);
  }

  root.ODMi18n = {
    t: t,
    setLocale: setLocale,
    getLocale: getLocale,
    applyDom: applyDom,
    doneVerb: doneVerb,
    LOCALES: DATA.LOCALES.slice(),
    DEFAULT_LOCALE: DATA.DEFAULT_LOCALE,
    LS_KEY: DATA.LS_KEY,
  };
  try { document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'; } catch (_) {}
})(typeof window !== 'undefined' ? window : globalThis);
`
}
