// 豆芽 temporary-view renderer (Intelligent UI P2). Vetted component library in Muse style, vanilla JS.
// Input is the server-hydrated view (plain data). Every string goes through textContent; links are set only when
// they pass SAFE_LINK; there is no innerHTML, no eval, no inline handlers, no attribute names from data.
// Buttons can only open a link, open a card, run a view op, or send a prompt back to 豆芽 — never confirm or send.
(function (root) {
  'use strict'
  const SAFE_LINK = /^https:\/\/([a-z0-9-]+\.)*(github\.com|google\.com|slack\.com)(\/|$)/i
  const KNOWN = new Set(['Column', 'Section', 'Text', 'Callout', 'Table', 'List', 'Comparison', 'KeyValue', 'Timeline', 'Chart', 'Form', 'Buttons'])

  function createRenderer(doc) {
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e }
    // Chrome strings go through window.ODMi18n (loaded after this script, so look it up per call); the
    // Chinese text is only the fallback when the i18n runtime is missing. View data itself is never translated.
    const say = (key, zh, vars) => {
      const i = root && root.ODMi18n
      let s = i && typeof i.t === 'function' ? i.t(key, vars) : null
      if (!s || s === key) { s = zh; if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k])) }
      return s
    }
    const link = (url, text, cls) => {
      if (typeof url === 'string' && SAFE_LINK.test(url)) { const a = el('a', cls, text); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a }
      return el('span', cls, text)
    }
    const btn = (label, cls, onClick) => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e, b) }); return b }

    function dispatch(d, h) {
      if (!d || typeof d !== 'object') return
      if (typeof d.openLink === 'string') { if (SAFE_LINK.test(d.openLink)) h.openLink && h.openLink(d.openLink); return }
      if (typeof d.openCard === 'string') return h.openCard && h.openCard(d.openCard)
      if (d.uiOp && typeof d.uiOp === 'object') return h.uiOp && h.uiOp(d.uiOp)
      if (typeof d.prompt === 'string') return h.prompt && h.prompt(d.prompt)
      // anything else is ignored: buttons cannot confirm, send or execute
    }
    const actionsCell = (acts, h) => { const w = el('span', 'sf-row-acts'); for (const a of acts || []) w.appendChild(btn(a.label, 'sf-btn sm', () => dispatch(a.do, h))); return w }

    function table(c, h, comparison) {
      const wrap = el('div', 'sf-table-wrap')
      const t = el('table', 'sf-table' + (comparison ? ' sf-compare' : ''))
      const rows = (c.rows || []).slice()
      if (comparison) {
        const thead = el('thead'); const tr = el('tr'); tr.appendChild(el('th', 'sf-th-field', ''))
        for (const r of rows) { const th = el('th'); th.appendChild(link(r.url, r.title, 'sf-link')); tr.appendChild(th) }
        thead.appendChild(tr); t.appendChild(thead)
        const tb = el('tbody')
        for (const col of c.columns || []) { const tr2 = el('tr'); tr2.appendChild(el('th', 'sf-th-field', col.label)); for (const r of rows) tr2.appendChild(el('td', '', r.cells && r.cells[col.key])); tb.appendChild(tr2) }
        t.appendChild(tb)
      } else {
        let sortKey = null, dir = 1
        const thead = el('thead'); const tr = el('tr')
        const tb = el('tbody')
        const paint = () => {
          while (tb.firstChild) tb.removeChild(tb.firstChild)
          const list = sortKey ? rows.slice().sort((a, b) => { const x = a.sort && a.sort[sortKey], y = b.sort && b.sort[sortKey]; return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), 'zh')) * dir }) : rows
          for (const r of list) {
            const row = el('tr')
            ;(c.columns || []).forEach((col, i) => {
              const td = el('td')
              if (col.key === 'title') td.appendChild(link(r.url, r.cells && r.cells.title, 'sf-link'))
              else td.textContent = String((r.cells && r.cells[col.key]) ?? '')
              if (i === 0 && r.cardId && h.openCard && col.key !== 'title') td.classList.add('sf-cell-first')
              row.appendChild(td)
            })
            if ((r.actions || []).length) { const td = el('td', 'sf-td-acts'); td.appendChild(actionsCell(r.actions, h)); row.appendChild(td) }
            tb.appendChild(row)
          }
        }
        for (const col of c.columns || []) {
          const th = el('th', c.sortable ? 'sf-sortable' : '', col.label)
          if (c.sortable) th.addEventListener('click', () => { dir = sortKey === col.key ? -dir : 1; sortKey = col.key; for (const x of tr.children) x.removeAttribute('data-dir'); th.setAttribute('data-dir', dir > 0 ? 'asc' : 'desc'); paint() })
          tr.appendChild(th)
        }
        if (rows.some(r => (r.actions || []).length)) tr.appendChild(el('th', '', ''))
        thead.appendChild(tr); t.appendChild(thead); t.appendChild(tb); paint()
      }
      wrap.appendChild(t)
      if (!rows.length) wrap.appendChild(el('div', 'sf-empty', say('view.no_match', '没有符合的条目')))
      return wrap
    }
    function list(c, h) {
      const ul = el('ul', 'sf-list')
      for (const r of c.rows || []) {
        const li = el('li')
        li.appendChild(link(r.url, r.title, 'sf-link'))
        const meta = (c.columns || []).filter(f => f.key !== 'title').map(f => r.cells && r.cells[f.key]).filter(Boolean).join(' · ')
        if (meta) li.appendChild(el('span', 'sf-meta', meta))
        if ((r.actions || []).length) li.appendChild(actionsCell(r.actions, h))
        ul.appendChild(li)
      }
      if (!(c.rows || []).length) ul.appendChild(el('li', 'sf-empty', say('view.no_match', '没有符合的条目')))
      return ul
    }
    function keyValue(c) {
      const dl = el('dl', 'sf-kv')
      for (const p of c.pairs || []) { dl.appendChild(el('dt', '', p.label)); dl.appendChild(el('dd', p.counted ? 'sf-num' : '', p.value)) }
      return dl
    }
    function timeline(c) {
      const ol = el('ol', 'sf-timeline')
      for (const r of c.rows || []) { const li = el('li'); li.appendChild(el('time', '', r.at)); const b = el('div'); b.appendChild(link(r.url, r.title, 'sf-link')); if (r.from) b.appendChild(el('span', 'sf-meta', r.from)); li.appendChild(b); ol.appendChild(li) }
      if (c.undated) ol.appendChild(el('li', 'sf-meta', say('view.undated', '另有 {n} 条没有时间', { n: c.undated })))
      return ol
    }
    function chart(c) {
      const data = (c.data || []).filter(d => d && typeof d.value === 'number' && isFinite(d.value))
      const max = Math.max(1, ...data.map(d => d.value))
      const w = el('div', 'sf-chart sf-chart-' + (c.kind === 'line' ? 'line' : 'bar'))
      if (c.kind === 'line' && data.length > 1) {
        const NS = 'http://www.w3.org/2000/svg'
        const svg = doc.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 100 40'); svg.setAttribute('preserveAspectRatio', 'none')
        const pl = doc.createElementNS(NS, 'polyline')
        pl.setAttribute('points', data.map((d, i) => `${((i / (data.length - 1)) * 100).toFixed(2)},${(38 - (d.value / max) * 34).toFixed(2)}`).join(' '))
        pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', 'currentColor'); pl.setAttribute('stroke-width', '2'); pl.setAttribute('vector-effect', 'non-scaling-stroke')
        svg.appendChild(pl); w.appendChild(svg)
        const ax = el('div', 'sf-chart-axis'); for (const d of data) ax.appendChild(el('span', '', `${d.label} ${d.value}`)); w.appendChild(ax)
      } else {
        for (const d of data) {
          const row = el('div', 'sf-bar-row'); row.appendChild(el('span', 'sf-bar-l', d.label))
          const track = el('span', 'sf-bar-t'); const bar = el('i'); bar.style.width = `${Math.max(3, Math.round((d.value / max) * 100))}%`; track.appendChild(bar); row.appendChild(track)
          row.appendChild(el('b', 'sf-bar-v', d.value)); w.appendChild(row)
        }
      }
      if (!data.length) w.appendChild(el('div', 'sf-empty', say('view.no_data', '没有数据')))
      return w
    }
    function form(c, h, view, id) {
      const f = el('form', 'sf-form')
      const inputs = {}
      for (const fd of c.fields || []) {
        const row = el('label', 'sf-field' + (fd.kind === 'checkbox' ? ' sf-check' : ''))
        const lab = el('span', 'sf-field-l', fd.label + (fd.required ? ' *' : ''))
        let input
        if (fd.kind === 'textarea') { input = el('textarea'); input.rows = 6; input.value = String(fd.value ?? '') }
        else if (fd.kind === 'select') { input = el('select'); for (const o of fd.options || []) { const op = el('option', '', o.label); op.value = String(o.value); input.appendChild(op) } if (fd.value) input.value = String(fd.value) }
        else if (fd.kind === 'checkbox') { input = el('input'); input.type = 'checkbox'; input.checked = !!fd.value }
        else { input = el('input'); input.type = 'text'; input.value = String(fd.value ?? '') }
        if (fd.placeholder && 'placeholder' in input) input.placeholder = String(fd.placeholder)
        input.name = String(fd.name)
        inputs[fd.name] = { input, kind: fd.kind }
        if (fd.kind === 'checkbox') { row.appendChild(input); row.appendChild(lab) } else { row.appendChild(lab); row.appendChild(input) }
        f.appendChild(row)
      }
      const foot = el('div', 'sf-form-foot')
      const note = el('span', 'sf-form-note', c.submit && c.submit.kind === 'draft' ? say('view.form_note_draft', '提交后生成「待你确认」卡，确认前不会发出') : say('view.form_note_send', '提交后作为你的消息发给豆芽'))
      const go = el('button', 'sf-btn primary', (c.submit && c.submit.label) || say('view.submit', '提交')); go.type = 'submit'
      foot.appendChild(note); foot.appendChild(go); f.appendChild(foot)
      const status = el('div', 'sf-form-status'); f.appendChild(status)
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); e.stopPropagation()
        if (!h.submit) return
        const values = {}
        for (const [k, v] of Object.entries(inputs)) values[k] = v.kind === 'checkbox' ? !!v.input.checked : String(v.input.value)
        go.disabled = true; status.textContent = say('view.submitting', '提交中…')
        try { const r = await h.submit(view.id, id, values); status.textContent = (r && r.message) || ''; if (!r || !r.ok) go.disabled = false }
        catch (_) { status.textContent = say('view.submit_failed', '提交失败'); go.disabled = false }
      })
      return f
    }
    function buttons(c, h) { const w = el('div', 'sf-buttons'); for (const b of c.buttons || []) w.appendChild(btn(b.label, 'sf-btn', () => dispatch(b.do, h))); return w }

    function node(id, view, h, depth) {
      const c = view.components && view.components[id]
      if (!c || !KNOWN.has(c.type) || depth > 5) return el('div', 'sf-empty', '')
      let out
      switch (c.type) {
        case 'Column': case 'Section': {
          out = el('div', c.type === 'Section' ? 'sf-section' : 'sf-col')
          if (c.title) out.appendChild(el('h5', 'sf-h', c.title))
          for (const ch of c.children || []) out.appendChild(node(ch, view, h, depth + 1))
          return out
        }
        case 'Text': return el('p', 'sf-text', c.text)
        case 'Callout': return el('div', 'sf-callout sf-tone-' + (['info', 'warn', 'success'].includes(c.tone) ? c.tone : 'info'), c.text)
        case 'Table': out = table(c, h, false); break
        case 'Comparison': out = table(c, h, true); break
        case 'List': out = list(c, h); break
        case 'KeyValue': out = keyValue(c); break
        case 'Timeline': out = timeline(c); break
        case 'Chart': out = chart(c); break
        case 'Form': out = form(c, h, view, id); break
        case 'Buttons': out = buttons(c, h); break
      }
      if (c.title && !['Column', 'Section'].includes(c.type)) { const w = el('div', 'sf-block'); w.appendChild(el('h5', 'sf-h', c.title)); w.appendChild(out); return w }
      return out
    }

    /** opts: { placement: 'chat'|'panel'|'card', onPanel, onSave, onClose } */
    function render(view, h = {}, opts = {}) {
      const box = el('section', 'sf sf-' + (opts.placement || 'chat'))
      if (!view || typeof view !== 'object' || !view.components) { box.appendChild(el('div', 'sf-empty', say('view.gone', '视图已过期'))); return box }
      box.setAttribute('data-surface-id', String(view.id || ''))
      const head = el('header', 'sf-head')
      head.appendChild(el('b', 'sf-title', view.title))
      head.appendChild(el('span', 'sf-badge', view.generatedBy || say('view.badge', '豆芽生成')))
      const acts = el('span', 'sf-head-acts')
      if (opts.placement === 'chat' && opts.onPanel) acts.appendChild(btn(say('view.to_today', '放到今天页'), 'sf-btn sm ghost', () => opts.onPanel(view)))
      if (opts.placement !== 'card' && opts.onSave && !view.savedCardId) acts.appendChild(btn(say('view.save_card', '保存为卡片'), 'sf-btn sm ghost', (e, b) => { b.disabled = true; opts.onSave(view, b) }))
      if (view.savedCardId && opts.placement !== 'card') acts.appendChild(el('span', 'sf-saved', say('view.saved_card', '已保存为卡片')))
      if (opts.onClose) acts.appendChild(btn(opts.placement === 'card' ? say('view.remove', '移除') : say('view.close', '关闭'), 'sf-btn sm ghost', () => opts.onClose(view)))
      head.appendChild(acts)
      box.appendChild(head)
      if (view.expired) box.appendChild(el('div', 'sf-callout sf-tone-warn', say('view.expired', '这个视图已过期（数据仍是此刻 store 里的）')))
      box.appendChild(node(view.root, view, h, 1))
      if ((view.refs || []).length) {
        const f = el('footer', 'sf-refs'); f.appendChild(el('span', '', say('view.refs', '引用：')))
        for (const r of view.refs.slice(0, 6)) f.appendChild(h.openCard ? btn(r.title, 'sf-ref', () => h.openCard(r.id)) : el('span', 'sf-ref', r.title))
        if (view.refs.length > 6) f.appendChild(el('span', '', say('view.refs_more', '等 {n} 张', { n: view.refs.length })))
        box.appendChild(f)
      }
      return box
    }
    return { render, SAFE_LINK }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createRenderer, SAFE_LINK }
  if (root && root.document) root.OdmUi = createRenderer(root.document)
})(typeof window !== 'undefined' ? window : globalThis)
