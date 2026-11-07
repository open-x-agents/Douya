(() => {
  const root = document.getElementById('v-future');
  if (!root) return;
  const words = {
    en: { kicker: 'Douya / Future', title: 'A little closer to your future.', sub: 'Long-term goals, shaped around you. One small, concrete step at a time.', ask: 'Plan with Douya', empty: 'What would you like to grow?', emptySub: 'A stronger body, a new skill, or something entirely yours? Tell Douya what interests you. No ready-made life plan, no assumptions.', emptyBtn: 'Share an interest', examples: 'Movement · Learning · Creative work · Your own direction', active: 'In motion', proposed: 'For your consideration', archived: 'Archived', basis: 'Why this fits · from your memory', userBasis: 'Why this fits · you said', week: 'Next step · this week', complete: 'steps complete', accept: 'Accept plan', archive: 'Archive', dismiss: 'Not now', edit: 'Adjust with Douya', done: 'You finished every step. Choose what comes next with Douya.', prompt: 'Help me make a long-term plan from my real interests. Read Future plans and memories first. Ask me if there is not enough information. Propose a goal and one concrete step this week; wait for my agreement before activating it.', editPrompt: 'Help me adjust this Future plan or add its next step:', saved: 'Saved. A small step forward.', accepted: 'Plan accepted. Your next step is ready.', archivedMsg: 'Archived. You can choose a new direction anytime.', error: 'Could not load or save Future. Please try again.', retry: 'Refresh', loading: 'Finding your next direction…', offline: 'Memories are unavailable right now. Your plans are safe; you can still tell Douya your interests.', proposals: 'Suggestions · nothing starts until you accept', activeGroup: 'Your plans', archiveGroup: 'Archived plans' },
    zh: { kicker: '豆芽 / 未来', title: '离想成为的自己，再近一点。', sub: '从你的兴趣出发，把长期目标变成每周做得到的小事。', ask: '和豆芽一起规划', empty: '你想慢慢培养什么？', emptySub: '更好的体能、一项新技能，或者属于你自己的方向？告诉豆芽你感兴趣的事。不套模板，也不替你猜。', emptyBtn: '聊聊我的兴趣', examples: '运动 · 学习 · 创作 · 你自己的方向', active: '进行中', proposed: '待你决定', archived: '已归档', basis: '为什么适合你 · 来自回忆', userBasis: '为什么适合你 · 你说过', week: '这周 · 下一步', complete: '步已完成', accept: '接受计划', archive: '归档', dismiss: '暂时不要', edit: '和豆芽调整', done: '这几步都完成了。和豆芽聊聊下一步吧。', prompt: '根据我的真实兴趣帮我制定长期计划。先读取 Future 计划和记忆；信息不够就问我。提出目标和这周一个具体步骤，我同意后再开始。', editPrompt: '帮我调整这个 Future 计划，或增加下一步：', saved: '已保存，又往前走了一小步。', accepted: '计划已接受，下一步准备好了。', archivedMsg: '已归档，随时可以选择新的方向。', error: '未来计划暂时无法读取或保存，请重试。', retry: '刷新', loading: '在找适合你的方向…', offline: '暂时读不到回忆。计划还在，也可以直接和豆芽聊聊你的兴趣。', proposals: '建议 · 接受后才会开始', activeGroup: '你的计划', archiveGroup: '已归档的计划' },
  };
  let data = null, busy = false, message = '', error = false, loading = null;
  const w = () => words[window.ODMi18n?.getLocale() === 'zh' ? 'zh' : 'en'];
  const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const button = (label, op, cls = '') => `<button type="button" class="${cls}" data-op="${op}" ${busy ? 'disabled' : ''}>${esc(label)}</button>`;
  function card(p) {
    const t = w(), steps = p.steps || [], done = steps.filter(s => s.done).length, archive = p.status === 'archived';
    return `<article class="future-card ${esc(p.status)}" data-plan="${esc(p.id)}"><span class="future-tag">${esc(t[p.status])}</span><h2>${esc(p.title)}</h2><p class="future-goal">${esc(p.goal)}</p><div class="future-basis"><b>${esc(p.basis?.source === 'memory' ? t.basis : t.userBasis)}</b>${esc(p.basis?.text)}</div><progress max="${steps.length || 1}" value="${done}" aria-label="${esc(t.complete)}"></progress><div class="future-progress"><span>${done} / ${steps.length} ${esc(t.complete)}</span><span>${Math.round(done / (steps.length || 1) * 100)}%</span></div><div class="future-next">${esc(t.week)}</div>${steps.map(s => `<label class="future-step ${s.done ? 'done' : ''}"><input type="checkbox" data-step="${esc(s.id)}" ${s.done ? 'checked' : ''} ${busy || p.status !== 'active' ? 'disabled' : ''}><span>${esc(s.text)}</span></label>`).join('')}${done === steps.length && !archive ? `<p class="future-goal">${esc(t.done)}</p>` : ''}${archive ? '' : `<div class="future-actions">${p.status === 'proposed' ? button(t.accept, 'accept', 'future-primary') : ''}${button(t.edit, 'edit')}${button(p.status === 'proposed' ? t.dismiss : t.archive, 'archive')}</div>`}</article>`;
  }
  function render() {
    const t = w(), plans = data?.plans || [], active = plans.filter(p => p.status === 'active'), proposed = plans.filter(p => p.status === 'proposed'), archived = plans.filter(p => p.status === 'archived');
    const section = (label, ps) => ps.length ? `<h2 class="future-section-title">${esc(label)}</h2><div class="future-grid">${ps.map(card).join('')}</div>` : '';
    root.innerHTML = `<header class="future-head"><div><div class="future-kicker">${esc(t.kicker)}</div><h1>${esc(t.title)}</h1><p>${esc(t.sub)}</p></div><div>${button(t.ask, 'ask', 'future-primary')} ${button(t.retry, 'refresh')}</div></header><div class="future-message ${error ? 'future-error' : ''}" role="status" aria-live="polite">${esc(message || (!data ? t.loading : ''))}</div>${data?.available === false ? `<p class="future-goal">${esc(t.offline)}</p>` : ''}${!data ? '' : !active.length && !proposed.length ? `<div class="future-empty"><div class="future-orbit" aria-hidden="true">◎</div><h2>${esc(t.empty)}</h2><p>${esc(t.emptySub)}</p>${button(t.emptyBtn, 'ask', 'future-primary')}<div class="future-examples">${esc(t.examples)}</div></div>` : section(t.activeGroup, active) + section(t.proposals, proposed)}${archived.length ? `<details class="future-archive"><summary>${esc(t.archiveGroup)} (${archived.length})</summary><div class="future-grid">${archived.map(card).join('')}</div></details>` : ''}`;
  }
  async function load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const response = await fetch('/api/opendigitalmate/future', { cache: 'no-store' });
        const result = await response.json();
        if (!response.ok || !result.ok) throw Error();
        data = result; if (error) message = ''; error = false;
      } catch { error = true; message = w().error; }
      finally { loading = null; render(); }
    })();
    return loading;
  }
  async function mutate(input) {
    if (busy) return;
    busy = true; render();
    try {
      const response = await fetch('/api/opendigitalmate/future', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw Error(result.error);
      message = input.op === 'accept' ? w().accepted : input.op === 'archive' ? w().archivedMsg : w().saved;
      error = false; await load();
    } catch { error = true; message = w().error; }
    finally { busy = false; render(); }
  }
  root.addEventListener('click', event => {
    const btn = event.target.closest('button[data-op]'); if (!btn || busy) return;
    const op = btn.dataset.op, p = data?.plans.find(p => p.id === btn.closest('[data-plan]')?.dataset.plan);
    if (op === 'refresh') { message = ''; load(); }
    else if (op === 'ask' || op === 'edit') window.futureChat?.(op === 'edit' ? `${w().editPrompt} ${p?.title} (plan ${p?.id})` : w().prompt);
    else if (p) mutate({ op, id: p.id });
  });
  root.addEventListener('change', event => {
    const input = event.target.closest('input[data-step]'); if (!input) return;
    mutate({ op: 'step', id: input.closest('[data-plan]').dataset.plan, stepId: input.dataset.step, done: input.checked });
  });
  window.addEventListener('odm:locale', render);
  window.loadFuture = load;
  render();
})();
