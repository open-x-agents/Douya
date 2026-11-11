// Bundled OpenViking helpers (desktop/src/openviking.js). No Electron needed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OV_PORT, LOCAL_EMBED_DIMENSION, LOCAL_EMBED_FILENAME, LOCAL_EMBED_MODEL,
  applyBundledEmbedding, bundledCommand, decideOpenViking,
  ensureOpenVikingConfig, isOpenVikingHealthy, isUserManagedEmbedding, minimalOvConf,
  modelsConfigured, resolveBundledModel, resolveBundledRuntime, sanitizeSpawnEnv,
  waitForHealth,
} from '../desktop/src/openviking.js'
import {
  archiveName, archiveUrl, hasLlamaCppWheel, llamaCppWheelUrl, LLAMA_CPP_PYTHON_VERSION,
  LLAMA_CPP_WHEELS, LOCAL_EMBED_BYTES, LOCAL_EMBED_SHA256, LOCAL_EMBED_URL,
  OPENVIKING_VERSION, PBS_RELEASE,
} from '../desktop/scripts/bundle-openviking.mjs'
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
  assert.equal(conf.embedding, undefined)
})

test('ensureOpenVikingConfig points a new app-local conf at the shipped GGUF', () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-ov-home-'))
  const userData = mkdtempSync(join(tmpdir(), 'odm-ov-data-'))
  const modelPath = join(userData, LOCAL_EMBED_FILENAME)
  writeFileSync(modelPath, 'gguf-stub')
  const got = ensureOpenVikingConfig({ homeDir: home, userDataDir: userData, bundledModelPath: modelPath })
  assert.equal(got.wroteConf, true)
  assert.equal(got.models.ok, true)
  const conf = JSON.parse(readFileSync(got.confPath, 'utf8'))
  assert.equal(conf.embedding.dense.provider, 'local')
  assert.equal(conf.embedding.dense.model, LOCAL_EMBED_MODEL)
  assert.equal(conf.embedding.dense.dimension, LOCAL_EMBED_DIMENSION)
  assert.equal(conf.embedding.dense.input, 'text')
  assert.equal(conf.embedding.dense.model_path, modelPath)
})

test('ensureOpenVikingConfig does not overwrite an existing app-local ov.conf', () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-ov-home-'))
  const userData = mkdtempSync(join(tmpdir(), 'odm-ov-data-'))
  const appDir = join(userData, 'openviking')
  mkdirSync(appDir, { recursive: true })
  const appConf = join(appDir, 'ov.conf')
  const workspace = join(appDir, 'keep-data')
  writeFileSync(appConf, JSON.stringify({
    server: { host: '127.0.0.1', port: 1933 },
    storage: { workspace, agfs: { backend: 'local' }, vectordb: { backend: 'local' } },
    embedding: { dense: { provider: 'dashscope', model: 'text-embedding-v4', api_key: 'keep-me', dimension: 1024 } },
  }) + '\n')
  const modelPath = join(userData, LOCAL_EMBED_FILENAME)
  writeFileSync(modelPath, 'gguf-stub')
  const got = ensureOpenVikingConfig({ homeDir: home, userDataDir: userData, bundledModelPath: modelPath })
  assert.equal(got.usedExisting, true)
  assert.equal(got.wroteConf, false)
  assert.equal(got.confPath, appConf)
  const conf = JSON.parse(readFileSync(appConf, 'utf8'))
  assert.equal(conf.storage.workspace, workspace)
  assert.equal(conf.embedding.dense.provider, 'dashscope')
  assert.equal(conf.embedding.dense.api_key, 'keep-me')
  assert.equal(conf.embedding.dense.model_path, undefined)
})

test('ensureOpenVikingConfig fills a missing embedding on an existing app-local conf only', () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-ov-home-'))
  const userData = mkdtempSync(join(tmpdir(), 'odm-ov-data-'))
  const appDir = join(userData, 'openviking')
  mkdirSync(join(appDir, 'data'), { recursive: true })
  const appConf = join(appDir, 'ov.conf')
  const workspace = join(appDir, 'data')
  writeFileSync(appConf, JSON.stringify({
    server: { host: '127.0.0.1', port: 1933 },
    storage: { workspace, agfs: { backend: 'local' }, vectordb: { backend: 'local' } },
  }) + '\n')
  const modelPath = join(userData, LOCAL_EMBED_FILENAME)
  writeFileSync(modelPath, 'gguf-stub')
  const got = ensureOpenVikingConfig({ homeDir: home, userDataDir: userData, bundledModelPath: modelPath })
  assert.equal(got.usedExisting, true)
  assert.equal(got.wroteConf, true)
  assert.equal(got.models.ok, true)
  const conf = JSON.parse(readFileSync(appConf, 'utf8'))
  assert.equal(conf.storage.workspace, workspace)
  assert.equal(conf.embedding.dense.model_path, modelPath)
  assert.equal(conf.embedding.dense.dimension, 512)
})

test('ensureOpenVikingConfig never rewrites ~/.openviking/ov.conf even when embedding is missing', () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-ov-home-'))
  const userData = mkdtempSync(join(tmpdir(), 'odm-ov-data-'))
  mkdirSync(join(home, '.openviking'))
  const homeConf = join(home, '.openviking', 'ov.conf')
  const original = JSON.stringify({ storage: { workspace: '/old' } })
  writeFileSync(homeConf, original)
  const modelPath = join(userData, LOCAL_EMBED_FILENAME)
  writeFileSync(modelPath, 'gguf-stub')
  const got = ensureOpenVikingConfig({ homeDir: home, userDataDir: userData, bundledModelPath: modelPath })
  assert.equal(got.usedExisting, true)
  assert.equal(got.wroteConf, false)
  assert.equal(got.models.ok, false)
  assert.equal(readFileSync(homeConf, 'utf8'), original)
})

test('applyBundledEmbedding leaves a user provider and an existing model_path alone', () => {
  const p = '/tmp/does-not-matter.gguf'
  assert.equal(isUserManagedEmbedding({ provider: 'volcengine', model: 'doubao-embedding-vision-251215' }), true)
  const cloud = applyBundledEmbedding({ embedding: { dense: { provider: 'openai', model: 'text-embedding-3-small' } } }, p)
  assert.equal(cloud.changed, false)
  const existing = '/already/there.gguf'
  const local = applyBundledEmbedding(
    { embedding: { dense: { provider: 'local', model: LOCAL_EMBED_MODEL, model_path: existing } } },
    p,
    (x) => x === existing,
  )
  assert.equal(local.changed, false)
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

test('bundle script pins OpenViking, the official GGUF, and python-build-standalone URLs per OS/arch', () => {
  assert.equal(OPENVIKING_VERSION, '0.5.4')
  assert.equal(LOCAL_EMBED_MODEL, 'bge-small-zh-v1.5-f16')
  assert.equal(LOCAL_EMBED_FILENAME, 'bge-small-zh-v1.5-f16.gguf')
  assert.equal(LOCAL_EMBED_DIMENSION, 512)
  assert.match(LOCAL_EMBED_URL, /CompendiumLabs\/bge-small-zh-v1\.5-gguf/)
  assert.equal(LOCAL_EMBED_SHA256, 'ab9b81d9cd329c712eee379cf0068eabe6a5e2a01d0def61535eba9384085e2c')
  assert.equal(LOCAL_EMBED_BYTES, 47886240)
  assert.equal(LLAMA_CPP_PYTHON_VERSION, '0.3.36')
  assert.equal(hasLlamaCppWheel('darwin', 'arm64'), false)
  assert.equal(hasLlamaCppWheel('darwin', 'x64'), false)
  assert.equal(hasLlamaCppWheel('win32', 'x64'), true)
  assert.equal(hasLlamaCppWheel('linux', 'x64'), true)
  assert.equal(hasLlamaCppWheel('linux', 'arm64'), false)
  assert.equal(llamaCppWheelUrl('darwin', 'arm64'), null)
  assert.equal(llamaCppWheelUrl('darwin', 'x64'), null)
  assert.match(llamaCppWheelUrl('win32', 'x64'), /win_amd64\.whl$/)
  assert.match(llamaCppWheelUrl('linux', 'x64'), /manylinux2014_x86_64/)
  assert.equal(LLAMA_CPP_WHEELS['darwin-arm64'], undefined)
  assert.equal(LLAMA_CPP_WHEELS['win32-x64'].sha256, 'ae5e88a2cf464e5a2dde7c8898c2d5c71cc24d03cac6396bf7509456bde0b9fb')
  assert.match(archiveName('darwin', 'arm64'), /aarch64-apple-darwin/)
  assert.match(archiveName('darwin', 'x64'), /x86_64-apple-darwin/)
  assert.match(archiveName('win32', 'x64'), /x86_64-pc-windows-msvc/)
  assert.match(archiveUrl('linux', 'x64'), new RegExp(PBS_RELEASE))
  assert.match(archiveName('linux', 'x64'), /x86_64-unknown-linux-gnu/)
  assert.match(archiveName('linux', 'arm64'), /aarch64-unknown-linux-gnu/)
  assert.equal(llamaCppWheelUrl('linux', 'arm64'), null)
  assert.throws(() => archiveName('win32', 'arm64'))
})

test('desktop workflow builds Windows, macOS, and Linux packages with the same OpenViking bundle', () => {
  const yml = readFileSync(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8')
  assert.match(yml, /tags: \['desktop-v\*'\]/)
  assert.doesNotMatch(yml, /pull_request/)
  for (const bit of [
    'macos-latest', 'macos-15-intel', 'windows-latest', 'ubuntu-latest', 'ubuntu-24.04-arm',
    'target: linux', 'arch: arm64', 'platform: linux', 'platform: darwin', 'platform: win32',
  ]) assert.match(yml, new RegExp(bit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), bit)
  assert.match(yml, /--platform \$\{\{ matrix\.platform \}\} --arch \$\{\{ matrix\.arch \}\}/)
  assert.match(yml, /\*\.AppImage/)
  assert.match(yml, /\*\.deb/)
  assert.match(yml, /SHA256SUMS/)
  assert.match(yml, /Linux packages are unsigned/)
  // Official v0.3.36 macos arm64 wheel stays skipped; Mac jobs still source-build with cmake.
  assert.match(yml, /CMake \(macOS; needed to build llama-cpp-python from source\)/)
  assert.match(yml, /if: matrix\.target == 'mac'/)
  const src = readFileSync(new URL('../desktop/scripts/bundle-openviking.mjs', import.meta.url), 'utf8')
  assert.match(src, /published v0\.3\.36 macosx_11_0_arm64 wheel is a/)
  assert.match(src, /corrupt zip/)
  assert.ok(!src.split('const TRIPLES')[0].includes("'darwin-arm64'"), 'official macos arm64 llama wheel stays unlisted')
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
  assert.match(main, /resolveBundledModel/)
  assert.match(main, /bundledModelPath/)
  // Must not kill a server we did not start, and must not rebuild vectors.
  assert.match(main, /Only the OpenViking process we started/)
  assert.doesNotMatch(main, /reindex/)
})

test('resolveBundledModel only returns the shipped GGUF when the file exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'odm-ov-model-'))
  assert.equal(resolveBundledModel(root), null)
  mkdirSync(join(root, 'models'))
  const path = join(root, 'models', LOCAL_EMBED_FILENAME)
  writeFileSync(path, 'gguf-stub')
  assert.equal(resolveBundledModel(root), path)
})

test('desktop README distinguishes the bundled local embedding from a separate VLM', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /bge-small-zh-v1\.5-f16/)
  assert.match(readme, /VLM \/ chat model is \*\*not\*\* shipped/)
  assert.match(readme, /does not rebuild existing vectors/)
  assert.match(readme, /memory extraction and summaries need a VLM/)
  const en = messages('en')
  assert.match(en.ovModels, /VLM \/ chat model is separate/)
  assert.doesNotMatch(en.ovModels, /no embedding \/ VLM model is configured yet/)
})
