// Desktop shell (desktop/, Electron): the pure startup helpers. No Electron needed —
// desktop/src/server.js imports only node: modules, so this runs in the plain suite.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  APP_RUNTIME, bundledDshEntry, bundledNodeExe, bundledRuntimeRoot, decideStartup, freshLogin,
  isExternalOpenable, isInternalUrl, isPortOpen, isRepoRoot,
  locateDsh, mergePath, messages, parseLoginUrl, readLoginUrl, resolveDshBin,
  resolveNodeExe, resolveOdmDataDir, resolvePackagedDshHome, resolveRepoRoot,
  sanitizeBounds, sanitizeSpawnEnv, tail, tokenWorks, waitForLogin,
} from '../desktop/src/server.js'

const URL_TEXT = 'http://127.0.0.1:7777/?token=abc123'

test('parseLoginUrl takes only loopback token URLs', () => {
  assert.deepEqual(parseLoginUrl(`${URL_TEXT}\n`), { url: URL_TEXT, port: 7777, origin: 'http://127.0.0.1:7777' })
  assert.equal(parseLoginUrl('http://127.0.0.1:7777/'), null)
  assert.equal(parseLoginUrl('http://evil.example:7777/?token=x'), null)
  assert.equal(parseLoginUrl(''), null)
})

test('readLoginUrl reads .odm-data/dsh-web.url with its mtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'odm-desk-'))
  assert.equal(readLoginUrl(root), null)
  mkdirSync(join(root, '.odm-data'))
  writeFileSync(join(root, '.odm-data', 'dsh-web.url'), URL_TEXT + '\n')
  const got = readLoginUrl(root)
  assert.equal(got.url, URL_TEXT)
  assert.equal(got.port, 7777)
  assert.ok(got.mtimeMs > 0)
})

test('decideStartup reuses a live server, spawns on a free port, refuses a foreign one', () => {
  const login = parseLoginUrl(URL_TEXT)
  assert.deepEqual(decideStartup({ portOpen: true, login, tokenOk: true }), { action: 'reuse', url: URL_TEXT })
  assert.deepEqual(decideStartup({ portOpen: false, login, tokenOk: false }), { action: 'spawn' })
  assert.deepEqual(decideStartup({ portOpen: false, login: null }), { action: 'spawn' })
  // Port busy but the saved token is stale, missing, or for another port: never start a second server.
  assert.equal(decideStartup({ portOpen: true, login, tokenOk: false }).action, 'conflict')
  assert.equal(decideStartup({ portOpen: true, login: null, tokenOk: false }).action, 'conflict')
  assert.equal(decideStartup({ portOpen: true, login, tokenOk: true, port: 7788 }).action, 'conflict')
})

test('freshLogin ignores a URL file left over from an earlier run', () => {
  const login = { ...parseLoginUrl(URL_TEXT), mtimeMs: 1_000 }
  assert.equal(freshLogin(login, 10_000, 7777), null)
  assert.equal(freshLogin({ ...login, mtimeMs: 10_500 }, 10_000, 7777).url, URL_TEXT)
  assert.equal(freshLogin({ ...login, mtimeMs: 10_500 }, 10_000, 7788), null)
  assert.equal(freshLogin(null, 0, 7777), null)
})

test('waitForLogin resolves once a fresh URL appears and the port answers', async () => {
  let clock = 0
  let reads = 0
  const got = await waitForLogin({
    root: '/x', port: 7777, since: 5000,
    read: () => (++reads < 3 ? { ...parseLoginUrl(URL_TEXT), mtimeMs: 0 } : { ...parseLoginUrl(URL_TEXT), mtimeMs: 5200 }),
    portOpen: async () => true, now: () => clock, sleep: async (ms) => { clock += ms },
  })
  assert.equal(got.url, URL_TEXT)
  assert.equal(reads, 3)
})

test('waitForLogin fails fast when the child dies, and times out otherwise', async () => {
  await assert.rejects(waitForLogin({ root: '/x', port: 7777, since: 0, read: () => null, isDead: () => true }), { code: 'exited' })
  let clock = 0
  await assert.rejects(waitForLogin({
    root: '/x', port: 7777, since: 0, timeoutMs: 1000, read: () => null,
    now: () => clock, sleep: async (ms) => { clock += ms },
  }), { code: 'timeout' })
})

test('isPortOpen sees a real listener and a closed port', async () => {
  const srv = createServer().listen(0, '127.0.0.1')
  await new Promise((r) => srv.once('listening', r))
  const { port } = srv.address()
  assert.equal(await isPortOpen(port), true)
  await new Promise((r) => srv.close(r))
  assert.equal(await isPortOpen(port), false)
})

test('tokenWorks: 2xx/3xx is a login, 401 or a network error is not', async () => {
  assert.equal(await tokenWorks(URL_TEXT, { fetchFn: async () => ({ status: 302 }) }), true)
  assert.equal(await tokenWorks(URL_TEXT, { fetchFn: async () => ({ status: 401 }) }), false)
  assert.equal(await tokenWorks(URL_TEXT, { fetchFn: async () => { throw new Error('ECONNREFUSED') } }), false)
})

test('resolveRepoRoot / resolveDshBin: env first, then saved, then the usual Mac layout', () => {
  const has = (paths) => (p) => paths.some((x) => p.startsWith(x))
  const start = (dir) => join(dir, 'scripts', 'start-dsh.mjs')
  assert.equal(resolveRepoRoot({ env: { ODM_ROOT: '/a' }, saved: '/b', exists: has([start('/a'), start('/b')]) }), '/a')
  assert.equal(resolveRepoRoot({ env: {}, saved: '/b', devRoot: '/c', exists: has([start('/b'), start('/c')]) }), '/b')
  assert.equal(resolveRepoRoot({ env: { HOME: '/h' }, exists: has([start('/h/Documents/git/openDigitalMate')]) }), '/h/Documents/git/openDigitalMate')
  assert.equal(resolveRepoRoot({ env: {}, exists: () => false }), null)
  assert.equal(isRepoRoot('', () => true), false)

  assert.equal(resolveDshBin({ env: { DSH_BIN: '/x/dsh' } }), '/x/dsh')
  const macDsh = join('/h', 'Documents', 'git', 'dsh-rc5', 'bin', 'dsh')
  assert.equal(resolveDshBin({ env: { HOME: '/h' }, exists: (p) => p === macDsh }), macDsh)
  assert.equal(resolveDshBin({ env: { HOME: '/h' }, exists: () => false }), null)
})

test('locateDsh: known locations first, then dsh on PATH, else null so the shell asks', () => {
  assert.equal(locateDsh({ env: { DSH_BIN: '/x/dsh' }, onPath: () => '/usr/local/bin/dsh' }), '/x/dsh')
  assert.equal(locateDsh({ env: {}, saved: '/s/dsh', exists: (p) => p === '/s/dsh', onPath: () => '/p/dsh' }), '/s/dsh')
  assert.equal(locateDsh({ env: { HOME: '/h' }, exists: () => false, onPath: (n) => (n === 'dsh' ? '/opt/homebrew/bin/dsh' : null) }), '/opt/homebrew/bin/dsh')
  assert.equal(locateDsh({ env: { HOME: '/h' }, exists: () => false, onPath: () => null }), null)
  assert.equal(locateDsh({ env: {}, exists: () => false }), null)
})

test('dsh picker copy is bilingual', () => {
  for (const locale of ['en-US', 'zh-CN']) {
    const m = messages(locale)
    assert.match(m.noDsh, /dsh/)
    assert.match(m.noDsh, /DSH_BIN/)
    assert.ok(m.pickDsh)
  }
  assert.notEqual(messages('en').noDsh, messages('zh').noDsh)
})

test('mergePath keeps order and drops duplicates / blanks', () => {
  assert.equal(mergePath('/usr/bin:/bin', ['/opt/homebrew/bin:/usr/bin', '', '/bin'], ':'), '/usr/bin:/bin:/opt/homebrew/bin')
})

test('sanitizeBounds keeps sane saved bounds, else the desktop default', () => {
  assert.deepEqual(sanitizeBounds(null), { width: 1360, height: 880 })
  assert.deepEqual(sanitizeBounds({ width: 100, height: 100 }), { width: 1360, height: 880 })
  assert.deepEqual(sanitizeBounds({ width: 1200.4, height: 800, x: 10, y: 20, maximized: true }), { width: 1200, height: 800, x: 10, y: 20, maximized: true })
})

test('links: Douya origin stays inside, http(s)/mailto go to the system browser, others nowhere', () => {
  const origin = 'http://127.0.0.1:7777'
  assert.equal(isInternalUrl('http://127.0.0.1:7777/api/opendigitalmate/app', origin), true)
  assert.equal(isInternalUrl('https://github.com/x', origin), false)
  assert.equal(isInternalUrl('not a url', origin), false)
  assert.equal(isExternalOpenable('https://github.com/x'), true)
  assert.equal(isExternalOpenable('mailto:a@b.c'), true)
  assert.equal(isExternalOpenable('file:///etc/passwd'), false)
  assert.equal(isExternalOpenable('javascript:alert(1)'), false)
})

test('error dialog strings follow the OS locale (EN / 中文)', () => {
  assert.equal(messages('zh-CN').title, '豆芽没能启动')
  assert.equal(messages('zh-Hans-CN').quit, '退出')
  assert.equal(messages('en-US').title, 'Douya could not start')
  assert.equal(messages(undefined).title, 'Douya could not start')
  assert.match(messages('zh').conflict(7777), /7777/)
  for (const key of Object.keys(messages('en'))) assert.ok(key in messages('zh'), `zh missing ${key}`)
  assert.equal(tail('a\nb\nc\n', 2), 'b\nc')
})

test('desktop package stays out of the root install and ships the agreed scripts', () => {
  const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const desk = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'))
  assert.ok(!('electron' in (root.devDependencies || {})) && !('electron' in (root.dependencies || {})))
  for (const s of ['desktop:dev', 'desktop:build:mac', 'desktop:build:win', 'desktop:build:linux']) assert.ok(root.scripts[s], `missing ${s}`)
  // one arch per build: CI passes --arm64 / --x64 so each DMG carries its own Node + MCP Memory
  assert.deepEqual(desk.build.mac.target, ['dmg'])
  assert.equal(desk.build.win.target[0].target, 'nsis')
  assert.equal(desk.build.mac.identity, '-') // ad-hoc: arm64 opens instead of "damaged"
  assert.deepEqual(desk.build.linux.target, ['AppImage', 'deb'])
  assert.ok(desk.scripts['build:linux'])
  // electron-builder's deb target requires a maintainer email.
  // Contact is the published GitHub / commit author email, not an invented address.
  assert.equal(desk.author.name, 'open-x-agents')
  assert.equal(desk.author.email, 'birfychen@gmail.com')
  assert.equal(desk.build.linux.maintainer, 'open-x-agents <birfychen@gmail.com>')
  assert.equal(desk.homepage, 'https://github.com/open-x-agents/openDigitalMate')
})

test('the window keeps renderer hardening on', () => {
  const main = readFileSync(new URL('../desktop/src/main.js', import.meta.url), 'utf8')
  assert.match(main, /contextIsolation: true/)
  assert.match(main, /nodeIntegration: false/)
  assert.match(main, /sandbox: true/)
  assert.match(main, /requestSingleInstanceLock/)
  assert.doesNotMatch(main, /enableRemoteModule|@electron\/remote/)
})

test('readLoginUrl can read from a writable dataDir outside the root', () => {
  const root = mkdtempSync(join(tmpdir(), 'odm-desk-root-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'odm-desk-data-'))
  writeFileSync(join(dataDir, 'dsh-web.url'), URL_TEXT + '\n')
  const got = readLoginUrl(root, { dataDir })
  assert.equal(got.url, URL_TEXT)
  assert.equal(readLoginUrl(root), null)
})

test('resolveRepoRoot prefers a bundled app-runtime over a saved leftover path', () => {
  const start = (dir) => join(dir, 'scripts', 'start-dsh.mjs')
  const has = (paths) => (p) => paths.includes(p)
  assert.equal(resolveRepoRoot({
    env: {}, saved: '/old/checkout', bundledRoot: '/res/app-runtime',
    exists: has([start('/old/checkout'), start('/res/app-runtime')]),
  }), '/res/app-runtime')
  // ODM_ROOT still wins, for a deliberate override.
  assert.equal(resolveRepoRoot({
    env: { ODM_ROOT: '/a' }, saved: '/b', bundledRoot: '/res/app-runtime',
    exists: has([start('/a'), start('/b'), start('/res/app-runtime')]),
  }), '/a')
  assert.equal(bundledRuntimeRoot('/res', (p) => p === start(join('/res', APP_RUNTIME))), join('/res', APP_RUNTIME))
  assert.equal(bundledRuntimeRoot('/res', () => false), null)
  assert.equal(bundledDshEntry('/rt', (p) => p === join('/rt', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')),
    join('/rt', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
})

test('locateDsh prefers a bundled entry after env and before a saved path', () => {
  assert.equal(locateDsh({
    env: {}, bundled: '/rt/node_modules/@deepseek-ai/dsh/lib/bin.js',
    saved: '/old/dsh', exists: () => true, onPath: () => '/p/dsh',
  }), '/rt/node_modules/@deepseek-ai/dsh/lib/bin.js')
  assert.equal(locateDsh({
    env: { DSH_BIN: '/x/dsh' }, bundled: '/rt/bin.js', exists: () => true,
  }), '/x/dsh')
})

test('resolveNodeExe prefers a bundled vanilla Node when packaged, else PATH, else Electron', () => {
  assert.deepEqual(resolveNodeExe({
    packaged: true, execPath: '/Douya.exe', bundledNode: '/rt/node/bin/node', onPath: () => '/usr/bin/node',
  }), { exe: '/rt/node/bin/node', electronAsNode: false })
  assert.deepEqual(resolveNodeExe({ packaged: true, execPath: '/Douya.exe', onPath: () => '/usr/bin/node' }),
    { exe: '/Douya.exe', electronAsNode: true })
  assert.deepEqual(resolveNodeExe({ packaged: false, execPath: '/Douya', onPath: () => '/usr/bin/node' }),
    { exe: '/usr/bin/node', electronAsNode: false })
  assert.deepEqual(resolveNodeExe({ packaged: false, execPath: '/Douya', onPath: () => null }),
    { exe: '/Douya', electronAsNode: true })
  assert.equal(bundledNodeExe('/rt', 'linux', (p) => p === join('/rt', 'node', 'bin', 'node')), join('/rt', 'node', 'bin', 'node'))
  assert.equal(bundledNodeExe('/rt', 'win32', (p) => p === join('/rt', 'node', 'node.exe')), join('/rt', 'node', 'node.exe'))
})

test('packaged data dirs land under userData, not the (read-only) runtime root', () => {
  const userData = join('/Users/a/Library/Application Support', 'Douya')
  assert.equal(resolveOdmDataDir({ packaged: true, userData, root: '/res/app-runtime', env: {} }), join(userData, 'odm-data'))
  assert.equal(resolvePackagedDshHome({ packaged: true, userData, root: '/res/app-runtime', env: {} }), join(userData, 'dsh-odm'))
  assert.equal(resolveOdmDataDir({ packaged: false, userData, root: '/repo', env: {} }), join('/repo', '.odm-data'))
  assert.equal(resolveOdmDataDir({ packaged: true, userData, root: '/res', env: { ODM_DATA_DIR: '/custom' } }), '/custom')
})

test('desktop package stages app-runtime into extraResources and has a bundle:runtime script', () => {
  const desk = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'))
  const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(desk.scripts['bundle:runtime'])
  const ers = desk.build.extraResources
  // from the parent dir: electron-builder drops a top-level node_modules of `from`.
  const runtime = ers.find((e) => Array.isArray(e.filter) && e.filter.includes('app-runtime/**'))
  assert.ok(runtime, 'app-runtime extraResources entry')
  assert.equal(runtime.from, 'resources')
  assert.equal(runtime.to, '.')
  assert.ok(!(ers || []).some((e) => e.to === 'openviking'))
  for (const s of ['desktop:build:mac', 'desktop:build:win', 'desktop:build:linux']) {
    assert.match(root.scripts[s], /bundle:runtime/)
  }
  const main = readFileSync(new URL('../desktop/src/main.js', import.meta.url), 'utf8')
  assert.match(main, /ELECTRON_RUN_AS_NODE/)
  assert.match(main, /ODM_DATA_DIR/)
  assert.match(main, /bundledRoot/)
  assert.match(main, /resolveNodeExe/)
})

test('sanitizeSpawnEnv keeps a single PATH and does not drop Windows Path when no override is given', () => {
  const env = sanitizeSpawnEnv({ Path: 'C:\\old', HOME: 'x' }, { path: 'C:\\new', platform: 'win32' })
  assert.equal(env.PATH, 'C:\\new')
  assert.equal(env.Path, undefined)
  // The rc8 OpenViking bug: sanitize({ ...process.env }) with no path, on Windows,
  // deleted `Path` and left the child with an empty PATH.
  const kept = sanitizeSpawnEnv({ Path: 'C:\\Windows;C:\\Windows\\System32', HOME: 'x' }, { platform: 'win32' })
  assert.equal(kept.PATH, 'C:\\Windows;C:\\Windows\\System32')
  assert.equal(kept.Path, undefined)
  const nix = sanitizeSpawnEnv({ PATH: '/usr/bin' }, { path: '/usr/bin:/opt/bin', platform: 'darwin' })
  assert.equal(nix.PATH, '/usr/bin:/opt/bin')
  const nixKeep = sanitizeSpawnEnv({ PATH: '/usr/bin', HOME: 'h' }, { platform: 'linux' })
  assert.equal(nixKeep.PATH, '/usr/bin')
})
