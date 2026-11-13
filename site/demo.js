/* Douya landing-page UI demo. All replies are scripted. Nothing is sent
   anywhere: no fetch, no cookies beyond the site language key already
   used by the page, and typed wizard/chat text never leaves this document. */
(function () {
  'use strict';

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var root = document.getElementById('live-demo');
  if (!root) return;

  var fallback = document.getElementById('demo-fallback');
  if (fallback) fallback.hidden = true;
  root.hidden = false;
  root.setAttribute('aria-hidden', 'false');

  var views = {
    today: root.querySelector('.dy-view[data-view="today"]'),
    chat: root.querySelector('.dy-view[data-view="chat"]'),
    memory: root.querySelector('.dy-view[data-view="memory"]'),
    future: root.querySelector('.dy-view[data-view="future"]'),
    settings: root.querySelector('.dy-view[data-view="settings"]')
  };
  var navs = root.querySelectorAll('.dy-nav[data-view]');
  var wiz = root.querySelector('.dy-wiz');
  var msgs = root.querySelector('#dyMsgs');
  var chatInput = root.querySelector('#dyChatInput');
  var todayInput = root.querySelector('#dyTodayInput');
  var thinking = false;

  function htmlLang() {
    return document.documentElement.getAttribute('data-lang') === 'zh' ? 'zh' : 'en';
  }

  function showView(name, opts) {
    opts = opts || {};
    if (name === 'wizard') {
      openWizard();
      if (!opts.silent) scrollDemo();
      return;
    }
    if (name === 'timetable') {
      name = 'today';
      var tt = root.querySelector('.dy-timetable');
      var btn = root.querySelector('.dy-tt-toggle');
      if (tt) {
        tt.classList.add('open');
        tt.hidden = false;
      }
      if (btn) {
        btn.setAttribute('aria-expanded', 'true');
        btn.setAttribute('data-open', '1');
      }
      if (tt && tt.scrollIntoView) {
        window.setTimeout(function () {
          tt.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
        }, reduced ? 0 : 50);
      }
    }
    if (!views[name]) name = 'today';
    Object.keys(views).forEach(function (k) {
      var on = k === name;
      if (views[k]) {
        views[k].classList.toggle('on', on);
        views[k].setAttribute('aria-hidden', on ? 'false' : 'true');
        if (on) views[k].scrollTop = 0;
      }
    });
    navs.forEach(function (n) {
      var on = n.getAttribute('data-view') === name;
      n.classList.toggle('on', on);
      if (on) n.setAttribute('aria-current', 'page');
      else n.removeAttribute('aria-current');
    });
    if (name !== 'wizard' && wiz && wiz.classList.contains('on') && !opts.keepWizard) closeWizard();
    if (!opts.silent) scrollDemo();
    if (name === 'chat' && chatInput && !opts.noFocus) {
      try { chatInput.focus({ preventScroll: true }); } catch (e) { chatInput.focus(); }
    }
    root.setAttribute('data-current-view', name);
  }

  function scrollDemo() {
    var prefers = reduced;
    root.scrollIntoView({ behavior: prefers ? 'auto' : 'smooth', block: 'start' });
  }

  function openWizard(step) {
    if (!wiz) return;
    wiz.classList.add('on');
    wiz.setAttribute('aria-hidden', 'false');
    setWizStep(step || 'model');
    var first = wiz.querySelector('.dy-wiz-pane.on input, .dy-wiz-pane.on select, .dy-wiz-x');
    if (first && !reduced) {
      try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); }
    }
  }

  function closeWizard() {
    if (!wiz) return;
    wiz.classList.remove('on');
    wiz.setAttribute('aria-hidden', 'true');
    // Drop any typed "key" so it is not left sitting in the DOM longer than needed.
    var keys = wiz.querySelectorAll('input[data-demo-secret]');
    keys.forEach(function (el) { el.value = ''; });
  }

  function setWizStep(step) {
    var isComp = step === 'composio';
    var modelPane = root.querySelector('#dyWizPaneModel');
    var compPane = root.querySelector('#dyWizPaneComposio');
    var modelStep = root.querySelector('#dyWizStepModel');
    var compStep = root.querySelector('#dyWizStepComposio');
    if (modelPane) modelPane.classList.toggle('on', !isComp);
    if (compPane) compPane.classList.toggle('on', isComp);
    if (modelStep) {
      modelStep.classList.toggle('on', !isComp);
      modelStep.classList.toggle('done', isComp);
    }
    if (compStep) {
      compStep.classList.toggle('on', isComp);
      compStep.classList.remove('done');
    }
    var back = root.querySelector('#dyWizBack');
    if (back) back.hidden = !isComp;
    wiz.setAttribute('data-step', isComp ? 'composio' : 'model');
  }

  function setStatus(id, kind, en, zh) {
    var el = root.querySelector(id);
    if (!el) return;
    el.className = 'dy-wiz-status' + (kind ? ' ' + kind : '');
    el.querySelectorAll('[lang]').forEach(function (s) {
      if (s.getAttribute('lang') === 'en') s.textContent = en || '';
      if (s.getAttribute('lang') === 'zh') s.textContent = zh || '';
    });
  }

  /* ----- Chat: scripted replies only ----- */
  var SCRIPTS = {
    plate: {
      keys: ["what's on my plate", 'on my plate', 'today', '今天', '今天有什么', '日程'],
      en: 'You have one open item: <b>PR follow-ups</b> on acme/app, next at 14:00–15:00. GitHub, Gmail, Slack and Calendar came through. <b>YouTube couldn’t be fetched</b> (quota), and Today lists it clearly.',
      zh: '今天有 1 件待办：acme/app 上的 <b>PR 跟进</b>，下一段在 14:00–15:00。GitHub、Gmail、Slack 和日历已汇总。<b>YouTube 没抓取到</b>（配额），今日页上会清楚列出来。'
    },
    done: {
      keys: ['finish', 'got done', '完成', '做完', 'what did i'],
      en: 'Two things already landed today: a review comment on acme/app#42, and a reply to fledge@example.com. Both stayed on your machine until you confirmed them.',
      zh: '今天已经完成两件：给 acme/app#42 的评论，以及回复 fledge@example.com。这两件都是你确认之后才发出去的。'
    },
    draft: {
      keys: ['draft', 'reply', 'email', '草稿', '回复', '邮件'],
      confirm: true,
      en: 'I drafted a short reply to the team. It is sitting as a pending action — nothing goes out until you click Confirm.',
      zh: '我拟好了一封给团队的短回复，现在是待确认操作。你点「确认」之前，什么都不会发出去。'
    },
    plan: {
      keys: ['pr follow', 'schedule', 'plan', '计划', '排期', '跟进'],
      en: 'PR follow-ups is next on the plan, 14:00–15:00. I can mark it finished when you are done, or open the timetable if you want to move it.',
      zh: '下一步是 PR 跟进，14:00–15:00。做完可以让我标成已完成，也可以打开时间表改时间。'
    },
    run: {
      keys: ['run', '跑步', 'future', 'plan with', '兴趣'],
      en: 'Your Future plan “Weekday evening runs” is active. This week’s step is a 25-minute easy run on Tuesday. Tick it on Future, or tell me when you have done it.',
      zh: '你的未来计划「工作日晚间跑步」正在进行。本周这一步是周二轻松跑 25 分钟。可以在「未来」里勾掉，也可以跑完告诉我。'
    },
    memory: {
      keys: ['remember', 'memory', 'recall', '记得', '回忆', '记忆'],
      en: 'In Recall I can see the achievement “Shipped Douya desktop v0.1.0”, and that you prefer DeepSeek for chat. These are sample memories on this page — I’m not adding new ones.',
      zh: '回忆里有成就「发布了豆芽桌面版 v0.1.0」，以及你聊天更喜欢用 DeepSeek。这些是这个页面上的示例记忆，我不会在这里新造。'
    },
    fallback: {
      keys: [],
      en: 'This page has a few prepared replies. Try a suggestion, or open Today, Recall, or Future in the sidebar.',
      zh: '这个页面有几段准备好的回复。可以点建议问法，或在侧栏打开今日、回忆或未来。'
    }
  };

  function pickScript(text) {
    var q = String(text || '').trim().toLowerCase();
    if (!q) return null;
    var order = ['draft', 'done', 'run', 'memory', 'plan', 'plate'];
    for (var i = 0; i < order.length; i++) {
      var s = SCRIPTS[order[i]];
      for (var k = 0; k < s.keys.length; k++) {
        if (q.indexOf(s.keys[k]) !== -1) return s;
      }
    }
    return SCRIPTS.fallback;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function addMsg(role, html) {
    if (!msgs) return null;
    var el = document.createElement('div');
    el.className = 'dy-msg ' + role;
    el.innerHTML = html;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  function confirmCard() {
    var lang = htmlLang();
    var el = document.createElement('div');
    el.className = 'dy-act';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', lang === 'zh' ? '待确认的发送' : 'Pending outbound action');
    el.innerHTML =
      '<div class="st"><span lang="en">Waiting for confirmation</span><span lang="zh">待你确认</span></div>' +
      '<div class="to"><span lang="en">To: team@acme.example · Gmail</span><span lang="zh">发往：team@acme.example · Gmail</span></div>' +
      '<p lang="en" style="margin:0">“Thanks for the review — I’ll follow up on the open comments after 14:00.”</p>' +
      '<p lang="zh" style="margin:0">「谢谢审阅，14:00 之后我会跟进还开着的评论。」</p>' +
      '<div class="dy-act-btns">' +
      '<button type="button" class="dy-act-go"><span lang="en">Confirm</span><span lang="zh">确认</span></button>' +
      '<button type="button" class="dy-act-no"><span lang="en">Cancel</span><span lang="zh">取消</span></button>' +
      '</div>' +
      '<p class="dy-act-result" hidden></p>';
    el.querySelector('.dy-act-go').addEventListener('click', function () {
      el.classList.add('is-done');
      el.querySelector('.st').innerHTML = '<span lang="en">Confirmed (demo)</span><span lang="zh">已确认（演示）</span>';
      el.querySelector('.dy-act-btns').hidden = true;
      var r = el.querySelector('.dy-act-result');
      r.hidden = false;
      r.innerHTML = '<span lang="en">In the real app this would send. In this walkthrough nothing left the page.</span><span lang="zh">正式应用里这时才会发出。这段演示里，内容没有离开过页面。</span>';
    });
    el.querySelector('.dy-act-no').addEventListener('click', function () {
      el.querySelector('.st').innerHTML = '<span lang="en">Cancelled</span><span lang="zh">已取消</span>';
      el.querySelector('.dy-act-btns').hidden = true;
    });
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function replyTo(text, fromToday) {
    if (thinking) return;
    var script = pickScript(text);
    if (!script) return;
    if (fromToday) showView('chat', { silent: true, noFocus: true });
    addMsg('me', esc(text));
    if (chatInput) chatInput.value = '';
    if (todayInput) todayInput.value = '';
    thinking = true;
    var wait = addMsg('bot', '<span class="dy-think"><img src="img/logo.svg" alt="" width="22" height="22"><span lang="en">Douya is thinking…</span><span lang="zh">豆芽正在想…</span></span>');
    var delay = reduced ? 0 : 520;
    window.setTimeout(function () {
      var lang = htmlLang();
      var body = lang === 'zh' ? script.zh : script.en;
      if (wait) wait.innerHTML = body;
      if (script.confirm) confirmCard();
      thinking = false;
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }, delay);
  }

  function sendFrom(input) {
    if (!input) return;
    var text = String(input.value || '').trim();
    if (!text) return;
    replyTo(text, input === todayInput);
  }

  /* ----- Events ----- */
  navs.forEach(function (n) {
    n.addEventListener('click', function () { showView(n.getAttribute('data-view'), { silent: true }); });
  });

  root.querySelectorAll('[data-demo-lang]').forEach(function (b) {
    b.addEventListener('click', function () {
      var lang = b.getAttribute('data-demo-lang');
      // Keep the site and the demo on the same language.
      var siteBtn = document.querySelector('[data-set-lang="' + lang + '"]');
      if (siteBtn) siteBtn.click();
      else applyDemoLang(lang);
    });
  });

  function applyDemoLang(lang) {
    lang = lang === 'zh' ? 'zh' : 'en';
    root.querySelectorAll('[data-demo-lang]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-demo-lang') === lang ? 'true' : 'false');
    });
  }

  // Observe the page language toggle (it already writes data-lang on <html>).
  var mo = new MutationObserver(function () { applyDemoLang(htmlLang()); });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-lang'] });
  applyDemoLang(htmlLang());

  var wizLaunch = root.querySelectorAll('[data-open-wizard]');
  wizLaunch.forEach(function (b) {
    b.addEventListener('click', function () { openWizard(); });
  });
  var wizClose = root.querySelectorAll('[data-close-wizard]');
  wizClose.forEach(function (b) {
    b.addEventListener('click', closeWizard);
  });
  if (wiz) {
    wiz.addEventListener('click', function (e) {
      if (e.target === wiz) closeWizard();
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && wiz && wiz.classList.contains('on')) {
      e.preventDefault();
      closeWizard();
    }
  });

  var wizNext = root.querySelector('#dyWizNext');
  if (wizNext) wizNext.addEventListener('click', function () {
    setStatus('#dyWizLlmStatus', 'ok',
      'Saved in this walkthrough — nothing was sent.',
      '已在演示里记下，没有向任何地方发送。');
    setWizStep('composio');
  });
  var wizBack = root.querySelector('#dyWizBack');
  if (wizBack) wizBack.addEventListener('click', function () { setWizStep('model'); });
  var wizSave = root.querySelector('#dyWizSave');
  if (wizSave) wizSave.addEventListener('click', function () {
    setStatus('#dyWizLlmStatus', 'ok',
      'Saved in this walkthrough — nothing was sent.',
      '已在演示里记下，没有向任何地方发送。');
  });
  var wizTest = root.querySelector('#dyWizTest');
  if (wizTest) wizTest.addEventListener('click', function () {
    setStatus('#dyWizLlmStatus', 'ok',
      'Connection looks good (demo). A real key is never tested here.',
      '连接看起来正常（演示）。这里不会用真实密钥去测。');
  });
  var wizSkip = root.querySelector('#dyWizSkip');
  if (wizSkip) wizSkip.addEventListener('click', function () {
    closeWizard();
    showView('today', { silent: true });
  });
  var wizCompSave = root.querySelector('#dyWizCompSave');
  if (wizCompSave) wizCompSave.addEventListener('click', function () {
    setStatus('#dyWizCompStatus', 'ok',
      'Saved in this walkthrough — nothing was sent. You can close the wizard.',
      '已在演示里记下，没有向任何地方发送。可以关闭向导。');
  });
  var wizForms = root.querySelectorAll('.dy-wiz form');
  wizForms.forEach(function (f) {
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      return false;
    });
  });
  var provider = root.querySelector('#dyWizProvider');
  if (provider) {
    provider.addEventListener('change', function () {
      var model = root.querySelector('#dyWizModel');
      var map = {
        deepseek: 'deepseek-flash',
        openai: 'gpt-4o',
        moonshot: 'moonshot-v1-8k',
        zhipu: 'glm-4',
        anthropic: 'claude-3-5-sonnet-20241022',
        custom: ''
      };
      if (model && map[provider.value] !== undefined) model.value = map[provider.value];
    });
  }

  // Today actions
  var refresh = root.querySelector('#dyRefresh');
  if (refresh) refresh.addEventListener('click', function () {
    var s = root.querySelectorAll('.dy-digest-status');
    s.forEach(function (el) {
      var en = el.querySelector('[lang="en"]');
      var zh = el.querySelector('[lang="zh"]');
      // The status nodes are themselves lang-tagged, not wrappers.
      if (el.getAttribute('lang') === 'en') el.textContent = 'Already up to date · demo';
      if (el.getAttribute('lang') === 'zh') el.textContent = '已是最新 · 演示';
    });
  });

  var finished = root.querySelector('#dyFinishPlan');
  if (finished) finished.addEventListener('click', function () {
    var card = root.querySelector('.dy-hero-plan');
    if (card) card.classList.add('is-done');
    finished.disabled = true;
    finished.innerHTML = '<span lang="en">Finished</span><span lang="zh">已完成</span>';
  });
  var seeSched = root.querySelector('#dySeeSched');
  if (seeSched) seeSched.addEventListener('click', function () {
    showView('timetable', { silent: true });
  });
  var askPlan = root.querySelector('#dyAskPlan');
  if (askPlan) askPlan.addEventListener('click', function () {
    replyTo(htmlLang() === 'zh' ? '帮我看看 PR 跟进的安排' : 'Tell me about the PR follow-ups plan', true);
  });
  var ttToggle = root.querySelector('.dy-tt-toggle');
  if (ttToggle) ttToggle.addEventListener('click', function () {
    var tt = root.querySelector('.dy-timetable');
    var open = !(tt && tt.classList.contains('open'));
    if (tt) {
      tt.classList.toggle('open', open);
      tt.hidden = !open;
    }
    ttToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // Future: tick steps locally; "do with Douya" opens a scripted chat.
  root.querySelectorAll('.dy-fut-step input').forEach(function (inp) {
    inp.addEventListener('change', function () {
      inp.closest('.dy-fut-step').classList.toggle('done', inp.checked);
      var card = inp.closest('.dy-fut-card');
      if (!card) return;
      var all = card.querySelectorAll('.dy-fut-step input');
      var done = card.querySelectorAll('.dy-fut-step input:checked');
      var bar = card.querySelector('progress');
      if (bar) bar.value = done.length;
      var label = card.querySelector('[data-progress-label]');
      if (label) {
        label.querySelector('[lang="en"]').textContent = done.length + ' / ' + all.length + ' steps complete';
        label.querySelector('[lang="zh"]').textContent = '已完成 ' + done.length + ' / ' + all.length + ' 步';
      }
    });
  });
  root.querySelectorAll('[data-future-chat]').forEach(function (b) {
    b.addEventListener('click', function () {
      replyTo(htmlLang() === 'zh' ? '我们一起来完成这周的跑步计划' : 'Let’s do this week’s running step together', true);
    });
  });
  var accept = root.querySelector('[data-accept-plan]');
  if (accept) accept.addEventListener('click', function () {
    var card = accept.closest('.dy-fut-card');
    if (!card) return;
    card.classList.remove('proposed');
    card.classList.add('active');
    var tag = card.querySelector('.dy-fut-tag');
    if (tag) {
      tag.querySelector('[lang="en"]').textContent = 'In motion';
      tag.querySelector('[lang="zh"]').textContent = '进行中';
    }
    accept.remove();
  });

  // Chat send + chips
  function bindSend(btn, input) {
    if (btn) btn.addEventListener('click', function () { sendFrom(input); });
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendFrom(input);
        }
      });
      input.addEventListener('input', function () {
        if (btn) btn.disabled = !String(input.value || '').trim();
      });
      if (btn) btn.disabled = true;
    }
  }
  bindSend(root.querySelector('#dyChatSend'), chatInput);
  bindSend(root.querySelector('#dyTodaySend'), todayInput);
  root.querySelectorAll('[data-prompt]').forEach(function (c) {
    c.addEventListener('click', function () {
      var key = c.getAttribute('data-prompt');
      var zh = c.getAttribute('data-prompt-zh');
      var text = htmlLang() === 'zh' && zh ? zh : c.getAttribute('data-prompt-en') || key;
      replyTo(text, c.closest('[data-view="today"]') != null);
    });
  });

  // Feature grid + in-page links: jump the demo to the matching tab.
  document.querySelectorAll('[data-demo-view]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var name = a.getAttribute('data-demo-view');
      if (!name) return;
      e.preventDefault();
      showView(name);
      if (location.hash !== '#demo') {
        try { history.replaceState(null, '', '#demo'); } catch (err) { location.hash = 'demo'; }
      }
    });
  });

  // Deep link: #demo, #demo=chat, #demo=wizard, #demo=timetable, …
  function fromHash() {
    var h = (location.hash || '').replace(/^#/, '');
    if (h === 'demo' || h.indexOf('demo=') === 0 || h.indexOf('demo/') === 0) {
      var part = h === 'demo' ? '' : h.replace(/^demo[=/]/, '');
      showView(part || 'today', { silent: h === 'demo', noFocus: true });
    }
  }
  window.addEventListener('hashchange', fromHash);
  fromHash();

  window.DouyaDemo = {
    showView: showView,
    openWizard: openWizard,
    closeWizard: closeWizard
  };
})();
