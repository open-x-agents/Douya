// Bundled OpenViking helpers (desktop/src/openviking.js). No Electron needed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OV_PORT, bundledCommand, decideOpenViking, ensureOpenVikingConfig,
  isOpenVikingHealthy, minimalOvConf, modelsConfigured, resolveBundledRuntime,
  sanitizeSpawnEnv, waitForHealth,
} from '../desktop/src/openviking.js'
import { archiveName, archiveUrl, OPENVIKING_VERSION, PBS_RELEASE } from '../desktop/scripts/bundle-openviking.mjs'
import { messages } from '../desktop/src/server.js'

test('isOpenVikingHealthy accepts /health payloads, rejects errors', () => {
  assert.equal(isOpenVikingHealthy(200, '{"status":"ok","healthy":true,"version":"0.5.4"}'), true)
  assert.equal(isOpenVikingHealthy(200, '{"status":"ok"}'), true)
  assert.equal(isOpenVikingHealthy(200, '{"healthy":true}'), true)
  assert.equal(isOpenVikingHealthy(503, '{"status":"ok","healthy":true}'), false)
  assert.equal(isOpenVikingHealthy(200, 'not-json'), false)
  assert.equal(isOpenVikingHealthy(200, '{"status":"pending_initialization"}'), false)
})

test('decideOpenViking reuses a healthy server, spawns or skips a free port, refuses a foreign one', () => {
  assert.deepEqual(decideOpenViking({ portOpen: true, healthy: true, bundled: true }), { action: 'reuse' })
  assert.deepEqual(decideOpenViking({ portOpen: true, healthy: true, bundled: false }), { action: 'reuse' })
  assert.deepEqual(decideOpenViking({ portOpen: false, healthy: false, bundled: true }), { action: 'spawn' })
  assert.deepEqual(decideOpenViking({ portOpen: false, healthy: false, bundled: false }), { action: 'skip' })
  assert.deepEqual(decideOpenViking({ portOpen: true, healthy: false, bundled: true }), { action: 'conflict' })
})

test('ensureOpenVikingConfig keeps an existing ~/.openviking/ov.conf and writes ovcli.conf only if missing', () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-ov-home-'))
  const userData = mkdtempSync(join(tmpdir(), 'odm-ov-data-'))
  mkdirSync(join(home, '.openviking'))
  writeFileSync(join(home, '.openviking', 'ov.conf'), JSON.stringify({
    storage: { workspace: '/old' },
    embedding: { dense: { provider: 'ollama', model: 'nomic-embed-text' } },
  }))
  const got = ensureOpenVikingConfig({ homeDir: home, userDataDir: userData })
  assert.equal(got.confPath, join(home, '.openviking', 'ov.conf'))
  assert.equal(got.usedExisting, true)
  assert.equal(got.wroteConf, false)
  assert.equal(got.wroteCli, true)
  assert.equal(got.models.ok, true)
  assert.deepEqual(JSON.parse(readFileSync(got.cliPath, 'utf8')), { url: 'http://127.0.0.1:1933' })
  // A second call must not overwrite ovcli.conf
  writeFileSync(got.cliPath, '{"url":"http://example.invalid"}')
  const again = ensureOpenVikingConfig({ homeDir: home, userDataDir: userData })
  assert.equal(again.wroteCli, false)
  assert.equal(JSON.parse(readFileSync(got.cliPath, 'utf8')).url, 'http://example.invalid')
})

test('ensureOpenVikingConfig writes a minimal app-local ov.conf when none exists', () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-ov-home-'))
  const userData = mkdtempSync(join(tmpdir(), 'odm-ov-data-'))
  const got = ensureOpenVikingConfig({ homeDir: home, userDataDir: userData })
  assert.equal(got.wroteConf, true)
  assert.equal(got.usedExisting, false)
  assert.equal(got.models.ok, false)
  const conf = JSON.parse(readFileSync(got.confPath, 'utf8'))
  assert.equal(conf.server.port, OV_PORT)
  assert.equal(conf.server.host, '127.0.0.1')
  assert.equal(conf.storage.agfs.backend, 'local')
  assert.equal(conf.storage.workspace, join(userData, 'openviking', 'data'))
  assert.equal(existsSync(conf.storage.workspace), true)
})

test('modelsConfigured requires an explicit provider or model', () => {
  assert.equal(modelsConfigured(minimalOvConf({ workspace: '/x' })).ok, false)
  assert.equal(modelsConfigured({ embedding: { dense: { provider: 'openai', model: 'text-embedding-3-small' } } }).ok, true)
})

test('resolveBundledRuntime / bundledCommand point at py+lib and pass --config', () => {
  const root = mkdtempSync(join(tmpdir(), 'odm-ov-rt-'))
  assert.equal(resolveBundledRuntime(root), null)
  mkdirSync(join(root, 'py', 'bin'), { recursive: true })
  mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'py', 'bin', 'python3'), '')
  const real = resolveBundledRuntime(root)
  assert.equal(real.python, join(root, 'py', 'bin', 'python3'))
  assert.equal(real.site, join(root, 'lib'))
  const cmd = bundledCommand(real, { confPath: '/cfg/ov.conf' })
  assert.deepEqual(cmd.args, ['-m', 'openviking_cli.server_bootstrap', '--config', '/cfg/ov.conf'])
  assert.equal(cmd.env.OPENVIKING_CONFIG_FILE, '/cfg/ov.conf')
  assert.equal(cmd.env.PYTHONPATH, real.site)
  assert.equal(cmd.env.PYTHONDONTWRITEBYTECODE, '1')
  assert.equal(cmd.cwd, '/cfg')
})

test('waitForHealth resolves once /health is ok, fails fast when the child dies', async () => {
  let n = 0
  const ok = await waitForHealth({
    timeoutMs: 5000, intervalMs: 10, now: (() => { let t = 0; return () => t += 10 })(),
    sleep: async () => {},
    fetchFn: async () => {
      n += 1
      if (n < 3) return { status: 503, text: async () => '{}' }
      return { status: 200, text: async () => '{"healthy":true}' }
    },
  })
  assert.equal(n, 3)
  assert.match(ok.body, /healthy/)
  await assert.rejects(waitForHealth({ isDead: () => true, fetchFn: async () => { throw new Error('no') } }), { code: 'exited' })
})

test('sanitizeSpawnEnv drops a duplicate Windows Path key', () => {
  const env = sanitizeSpawnEnv({ Path: 'C:\\old', HOME: 'x' }, { path: 'C:\\new', platform: 'win32' })
  assert.equal(env.PATH, 'C:\\new')
  assert.equal(env.Path, undefined)
  assert.equal(env.HOME, 'x')
  const nix = sanitizeSpawnEnv({ PATH: '/usr/bin' }, { path: '/usr/bin:/opt/bin', platform: 'darwin' })
  assert.equal(nix.PATH, '/usr/bin:/opt/bin')
})

test('bundle script pins OpenViking and python-build-standalone URLs per OS/arch', () => {
  assert.equal(OPENVIKING_VERSION, '0.5.4')
  assert.match(archiveName('darwin', 'arm64'), /aarch64-apple-darwin/)
  assert.match(archiveName('darwin', 'x64'), /x86_64-apple-darwin/)
  assert.match(archiveName('win32', 'x64'), /x86_64-pc-windows-msvc/)
  assert.match(archiveUrl('linux', 'x64'), new RegExp(PBS_RELEASE))
  assert.throws(() => archiveName('win32', 'arm64'))
})

test('desktop package ships the OpenViking extraResources and message keys stay bilingual', () => {
  const desk = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'))
  assert.equal(desk.build.extraResources[0].from, 'resources/openviking')
  assert.equal(desk.build.extraResources[0].to, 'openviking')
  assert.ok(desk.scripts['bundle:ov'])
  const en = messages('en')
  const zh = messages('zh')
  for (const key of ['ovTitle', 'ovModels', 'ovFailed', 'ovConflict', 'ovSkip', 'ok']) {
    assert.ok(key in en, `en missing ${key}`)
    assert.ok(key in zh, `zh missing ${key}`)
  }
  assert.match(en.ovFailed('/tmp/x'), /\/tmp\/x/)
  assert.match(zh.ovFailed('/tmp/x'), /\/tmp\/x/)
})

test('main process reuses a healthy :1933, starts the bundle otherwise, and kills only what it started', () => {
  const main = readFileSync(new URL('../desktop/src/main.js', import.meta.url), 'utf8')
  assert.match(main, /ensureMemory/)
  assert.match(main, /probeOpenVikingHealth/)
  assert.match(main, /ovStartedByUs/)
  assert.match(main, /openviking\.log/)
  assert.match(main, /showMemoryNote/)
  // Must not kill a server we did not start.
  assert.match(main, /Only the OpenViking process we started/)
})
