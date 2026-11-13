/* First-run setup wizard. Injected after the main page script. Uses existing
   /api/llm/config, /api/llm/test, /api/composio/config, plus /api/composio/test
   and /api/setup/complete. Secrets stay in password fields and are never logged. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const I18N = window.ODMi18n || { t: (k) => k, getLocale: () => 'en', setLocale: () => 'en', applyDom: () => {} };
  const t = (k, vars) => I18N.t(k, vars);
  const PRESETS = {
    openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' },
    deepseek: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
    moonshot: { baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4' },
    anthropic: { baseURL: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-20241022' },
  };
  const ERR = {
    missing_key: 'wizard.err_need_key',
    masked_key: 'wizard.err_need_key',
    user_api_key: 'wizard.err_user_key',
    unauthorized: 'wizard.err_unauthorized',
    timeout: 'wizard.err_timeout',
    network: 'wizard.err_network',
    http: 'wizard.err_http',
    no_fetch: 'wizard.err_network',
  };

  let step = 'model';
  let modelReady = false;
  let composioReady = false;
  let dashboardUrl = 'https://platform.composio.dev';
  let openedFromSettings = false;
  // Model fields as last loaded or saved, so Next can tell whether the user edited them.
  let loadedModel = { provider: '', baseURL: '', model: '' };

  /** True when the model form differs from what is saved (a typed key always counts). */
  function modelFormChanged(saved, form) {
    const s = saved || {}, f = form || {};
    if (String(f.apiKey || '').trim()) return true;
    const norm = (v) => String(v || '').trim();
    return ['provider', 'baseURL', 'model'].some((k) => norm(f[k]) !== norm(s[k]));
  }

  function readModelForm() {
    const v = (id) => ($(id) && $(id).value) || '';
    return { provider: v('wizLlmProvider'), baseURL: v('wizLlmBase'), apiKey: v('wizLlmKey'), model: v('wizLlmModel') };
  }

  function rememberModelForm() {
    const f = readModelForm();
    loadedModel = { provider: f.provider, baseURL: f.baseURL, model: f.model };
  }

  function wiz() { return $('setupWizard'); }
  function isOpen() { return !!(wiz() && wiz().classList.contains('on')); }

  function setStatus(id, kind, text) {
    const el = $(id);
    if (!el) return;
    el.className = 'setup-wiz-status' + (kind ? ' ' + kind : '');
    el.textContent = text || '';
  }

  function paintSteps() {
    const m = $('wizStepModel'), c = $('wizStepComposio');
    if (m) { m.classList.toggle('on', step === 'model'); m.classList.toggle('done', step === 'composio' && modelReady); }
    if (c) { c.classList.toggle('on', step === 'composio'); c.classList.toggle('done', false); }
    const mp = $('wizPaneModel'), cp = $('wizPaneComposio');
    if (mp) mp.classList.toggle('on', step === 'model');
    if (cp) cp.classList.toggle('on', step === 'composio');
    const back = $('wizBack');
    if (back) back.hidden = step === 'model';
  }

  function showStep(next) {
    step = next === 'composio' ? 'composio' : 'model';
    paintSteps();
  }

  function applyProviderPreset() {
    const provider = $('wizLlmProvider') && $('wizLlmProvider').value;
    const wrap = $('wizLlmBaseWrap');
    const base = $('wizLlmBase');
    const model = $('wizLlmModel');
    if (!provider || !model) return;
    if (provider === 'custom') {
      if (wrap) wrap.style.display = 'block';
      if (base && !base.value) base.value = '';
    } else if (PRESETS[provider]) {
      if (wrap) wrap.style.display = 'none';
      if (base) base.value = PRESETS[provider].baseURL;
      if (!model.value || model.value === model.placeholder) model.value = PRESETS[provider].model;
      model.placeholder = PRESETS[provider].model;
    } else if (wrap) wrap.style.display = 'none';
  }

  async function loadIntoForm() {
    try {
      const [llm, cp, chk] = await Promise.all([
        fetch('/api/llm/config').then((r) => r.json()).catch(() => ({})),
        fetch('/api/composio/config').then((r) => r.json()).catch(() => ({})),
        fetch('/api/config/check').then((r) => r.json()).catch(() => ({})),
      ]);
      if (chk.composioDashboardUrl) dashboardUrl = chk.composioDashboardUrl;
      const link = $('wizComposioOpen');
      if (link) link.href = dashboardUrl;
      if (llm.provider && $('wizLlmProvider')) {
        $('wizLlmProvider').value = llm.provider;
        applyProviderPreset();
      }
      if (llm.baseURL && $('wizLlmBase')) $('wizLlmBase').value = llm.baseURL;
      if (llm.model && $('wizLlmModel')) $('wizLlmModel').value = llm.model;
      if (llm.apiKey && $('wizLlmKey')) {
        $('wizLlmKey').placeholder = llm.apiKey;
        $('wizLlmKey').value = '';
      }
      modelReady = !!chk.llmConfigured || !!llm.configured;
      rememberModelForm();
      if (cp.apiKeyMasked && $('wizComposioKey')) {
        $('wizComposioKey').placeholder = cp.apiKeyMasked;
        $('wizComposioKey').value = '';
      }
      if (cp.entityId && $('wizEntityId')) $('wizEntityId').value = cp.entityId;
      composioReady = !!chk.composioApiKey || !!cp.configured;
      if (modelReady) setStatus('wizLlmStatus', 'ok', t('wizard.already_model'));
      if (composioReady) setStatus('wizComposioStatus', 'ok', t('wizard.already_composio'));
    } catch (err) {
      console.error('setup wizard load failed', err && err.message);
    }
  }

  function openWizard({ fromSettings = false, start } = {}) {
    const el = wiz();
    if (!el) return;
    openedFromSettings = !!fromSettings;
    el.classList.add('on');
    el.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (I18N.applyDom) I18N.applyDom(el);
    syncWizLang();
    loadIntoForm().then(() => {
      showStep(start || (modelReady && !fromSettings ? 'composio' : 'model'));
    });
  }

  function closeWizard() {
    const el = wiz();
    if (!el) return;
    el.classList.remove('on');
    el.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if ((location.hash || '') === '#setup') {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }

  function syncWizLang() {
    const loc = (I18N.getLocale && I18N.getLocale()) || 'en';
    document.querySelectorAll('#setupWizard .lang-switch button[data-lang]').forEach((b) => {
      b.classList.toggle('on', b.getAttribute('data-lang') === loc);
    });
  }

  async function saveModel() {
    const provider = $('wizLlmProvider') && $('wizLlmProvider').value;
    const baseURL = $('wizLlmBase') && $('wizLlmBase').value;
    const apiKey = $('wizLlmKey') && $('wizLlmKey').value;
    const model = $('wizLlmModel') && $('wizLlmModel').value;
    if (!provider) { setStatus('wizLlmStatus', 'err', t('wizard.err_need_provider')); return false; }
    const hasMasked = $('wizLlmKey') && ($('wizLlmKey').placeholder || '').includes('...');
    if (!apiKey && !hasMasked) { setStatus('wizLlmStatus', 'err', t('wizard.err_need_key')); return false; }
    setStatus('wizLlmStatus', 'busy', t('wizard.saving'));
    const payload = { provider, baseURL, model };
    if (apiKey) payload.apiKey = apiKey;
    try {
      const res = await fetch('/api/llm/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (result.success) {
        modelReady = true;
        if (result.masked && $('wizLlmKey')) {
          $('wizLlmKey').placeholder = result.masked;
          $('wizLlmKey').value = '';
        }
        rememberModelForm();
        setStatus('wizLlmStatus', 'ok', t('wizard.save_ok'));
        return true;
      }
      setStatus('wizLlmStatus', 'err', t('wizard.save_fail', { error: result.error || '' }));
      return false;
    } catch (err) {
      setStatus('wizLlmStatus', 'err', t('wizard.save_fail', { error: err.message || '' }));
      return false;
    }
  }

  async function testModel() {
    const saved = await saveModel();
    if (!saved && !modelReady) return;
    setStatus('wizLlmStatus', 'busy', t('wizard.testing'));
    try {
      const res = await fetch('/api/llm/test', { method: 'POST' });
      const result = await res.json();
      if (result.ok) setStatus('wizLlmStatus', 'ok', t('wizard.test_ok'));
      else setStatus('wizLlmStatus', 'err', t('wizard.test_fail', { error: result.error || '' }));
    } catch (err) {
      setStatus('wizLlmStatus', 'err', t('wizard.test_fail', { error: err.message || '' }));
    }
  }

  async function saveAndVerifyComposio() {
    const apiKey = $('wizComposioKey') && $('wizComposioKey').value;
    const entityId = ($('wizEntityId') && $('wizEntityId').value) || 'default';
    const hasMasked = $('wizComposioKey') && ($('wizComposioKey').placeholder || '').includes('...');
    if (!apiKey && !hasMasked) { setStatus('wizComposioStatus', 'err', t('wizard.err_need_key')); return false; }
    setStatus('wizComposioStatus', 'busy', t('wizard.testing'));
    try {
      const body = {};
      if (apiKey) body.apiKey = apiKey;
      const tested = await fetch('/api/composio/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (!tested.ok) {
        const key = ERR[tested.error] || 'wizard.test_fail';
        setStatus('wizComposioStatus', 'err', t(key, { error: tested.error || '', status: tested.status || '' }));
        return false;
      }
      const payload = { entityId };
      if (apiKey) payload.apiKey = apiKey;
      const saved = await fetch('/api/composio/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then((r) => r.json());
      if (!saved.success) {
        setStatus('wizComposioStatus', 'err', t('wizard.save_fail', { error: saved.error || '' }));
        return false;
      }
      composioReady = true;
      if (saved.apiKeyMasked && $('wizComposioKey')) {
        $('wizComposioKey').placeholder = saved.apiKeyMasked;
        $('wizComposioKey').value = '';
      }
      setStatus('wizComposioStatus', 'ok', t('wizard.composio_ok'));
      return true;
    } catch (err) {
      setStatus('wizComposioStatus', 'err', t('wizard.test_fail', { error: err.message || '' }));
      return false;
    }
  }

  async function complete({ skippedComposio = false } = {}) {
    try {
      await fetch('/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skippedComposio }),
      });
    } catch (err) {
      console.error('setup complete failed', err && err.message);
    }
    closeWizard();
  }

  async function onNext() {
    if (step === 'model') {
      // Save when nothing is configured yet, or when the user edited an
      // already-configured model; otherwise Next would drop those edits.
      if (!modelReady || modelFormChanged(loadedModel, readModelForm())) {
        const ok = await saveModel();
        if (!ok) return;
      }
      showStep('composio');
      return;
    }
    const ok = await saveAndVerifyComposio();
    if (ok) await complete({ skippedComposio: false });
  }

  function bind() {
    const el = wiz();
    if (!el || el.__bound) return;
    el.__bound = true;
    $('wizLlmProvider')?.addEventListener('change', applyProviderPreset);
    $('wizSaveModel')?.addEventListener('click', () => { saveModel(); });
    $('wizTestModel')?.addEventListener('click', () => { testModel(); });
    $('wizTestComposio')?.addEventListener('click', () => { saveAndVerifyComposio(); });
    $('wizNext')?.addEventListener('click', () => { onNext(); });
    $('wizFinish')?.addEventListener('click', async () => {
      if (composioReady && !($('wizComposioKey') && $('wizComposioKey').value)) {
        await complete({ skippedComposio: false });
        return;
      }
      const ok = await saveAndVerifyComposio();
      if (ok) await complete({ skippedComposio: false });
    });
    $('wizBack')?.addEventListener('click', () => showStep('model'));
    $('wizSkip')?.addEventListener('click', () => complete({ skippedComposio: true }));
    $('wizClose')?.addEventListener('click', () => closeWizard());
    el.querySelectorAll('.lang-switch').forEach((sw) => {
      sw.addEventListener('click', (e) => {
        const b = e.target && e.target.closest && e.target.closest('button[data-lang]');
        if (!b) return;
        const next = b.getAttribute('data-lang');
        if (typeof window.setAppLocale === 'function') window.setAppLocale(next, { reload: false });
        else if (I18N.setLocale) { I18N.setLocale(next); I18N.applyDom(el); }
        syncWizLang();
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) closeWizard();
    });
  }

  window.odmOpenSetupWizard = function (opts) { bind(); openWizard(opts || { fromSettings: true }); };
  window.odmCloseSetupWizard = closeWizard;
  window.odmWizardModelChanged = modelFormChanged;

  function boot() {
    bind();
    const openBtn = $('openSetupWizardBtn');
    if (openBtn && !openBtn.__bound) {
      openBtn.__bound = true;
      openBtn.addEventListener('click', () => window.odmOpenSetupWizard({ fromSettings: true }));
    }
    const hash = (location.hash || '').slice(1);
    if (hash === 'setup') {
      openWizard({ fromSettings: true });
      return;
    }
    fetch('/api/config/check').then((r) => r.json()).then((data) => {
      if (data && data.needsSetup) openWizard({ fromSettings: false });
    }).catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
