// DSH web client face: replace the stock shell with Muse (豆芽) Today UI.
// Loaded by dsh-client-modules: factory(require) must return the module namespace
// ({ name, inject, apply }), same shape ds-bot's generated client.js returns.
window.__ModuleLoader__.load({
  id: 'opendigitalmate',
  factory: (require) => {
    const MUSE = '/api/opendigitalmate/app'
    function toMuse() {
      try {
        const { pathname, search } = window.location
        if (pathname.indexOf(MUSE) === 0) return
        // Stock dsh shell (root) → Muse; keep any query except the one-time token.
        const params = new URLSearchParams(search)
        params.delete('token')
        const q = params.toString()
        window.location.replace(new URL(MUSE + (q ? '?' + q : ''), window.location.href).href)
      } catch (err) {
        try { console.error('[opendigitalmate-client]', err) } catch (_) {}
      }
    }
    const mod = {
      name: 'opendigitalmate-client',
      inject: [],
      apply() { toMuse() },
    }
    return Object.defineProperty(mod, Symbol.toStringTag, { value: 'Module' })
  },
})
