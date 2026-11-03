// DSH web client face: replace the stock shell with Muse (豆芽) Today UI.
// Served as classic script via /plugins/opendigitalmate/client.js — must be CJS factory.
window.__ModuleLoader__.load({
  id: 'opendigitalmate',
  factory(exports, module, require) {
    exports.name = 'opendigitalmate-client'
    exports.inject = []
    exports.apply = function apply() {
      try {
        var path = (typeof location !== 'undefined' && location.pathname) || ''
        var search = (typeof location !== 'undefined' && location.search) || ''
        // Already on Muse app, or on an API path — do nothing.
        if (path.indexOf('/api/opendigitalmate/app') === 0) return
        if (path.indexOf('/api/') === 0 && path.indexOf('/api/opendigitalmate/app') !== 0) return
        // Stock dsh web shell (/) → Muse
        if (typeof location !== 'undefined' && typeof location.replace === 'function') {
          location.replace('/api/opendigitalmate/app' + search)
        }
      } catch (err) {
        try { console.error('[opendigitalmate-client]', err) } catch (_) {}
      }
    }
  },
})
