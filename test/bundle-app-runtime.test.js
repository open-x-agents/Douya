import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUNDLED_PACKAGES, MEMORY_PLUGIN, MEMORY_PLUGIN_VERSION, NODE_ARCHIVES, NODE_VERSION,
  ROOT_PACKAGES, RUNTIME_DIRS, RUNTIME_FILES, applyBundledDeps, bundledDshEntry,
  bundledNodeExe, nodeArchive, shouldCopy, stageAppRuntime,
} from '../desktop/scripts/bundle-app-runtime.mjs'

function fakeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'odm-bundle-src-'))
  for (const f of RUNTIME_FILES) {
    const body = f === 'package.json'
      ? JSON.stringify({ name: 'opendigitalmate', version: '0.1.0', devDependencies: { playwright: '1' }, optionalDependencies: { x: '1' } }, null, 2)
      : '# ' + f + '\n'
    writeFileSync(join(root, f), body)
  }
  for (const d of RUNTIME_DIRS) mkdirSync(join(root, d), { recursive: true })
  writeFileSync(join(root, 'scripts', 'start-dsh.mjs'), '// start\n')
  writeFileSync(join(root, 'src', 'index.js'), '// src\n')
  mkdirSync(join(root, 'packages', 'dsh-muse-ui'), { recursive: true })
  writeFileSync(join(root, 'packages', 'dsh-muse-ui', 'index.js'), '// muse\n')
  mkdirSync(join(root, 'vendor', 'ds-bot', 'test'), { recursive: true })
  mkdirSync(join(root, 'vendor', 'ds-bot', 'dev'), { recursive: true })
  writeFileSync(join(root, 'vendor', 'ds-bot', 'package.json'), '{"name":"ds-bot"}\n')
  writeFileSync(join(root, 'vendor', 'ds-bot', 'index.js'), '// ds-bot\n')
  writeFileSync(join(root, 'vendor', 'ds-bot', 'test', 'x.test.js'), '// no\n')
  writeFileSync(join(root, 'vendor', 'ds-bot', 'dev', 'x.js'), '// no\n')
  mkdirSync(join(root, 'test'), { recursive: true })
  writeFileSync(join(root, 'test', 'no.test.js'), '// no\n')
  mkdirSync(join(root, 'desktop', 'src'), { recursive: true })
  writeFileSync(join(root, 'desktop', 'src', 'main.js'), '// no\n')
  mkdirSync(join(root, 'design'), { recursive: true })
  writeFileSync(join(root, 'design', 'x.png'), 'x')
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'install.md'), '# no\n')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: x\n')
  writeFileSync(join(root, '.env'), 'SECRET=1\n')
  return root
}

test('shouldCopy keeps the runtime tree and drops tests, desktop, docs, .git, secrets', () => {
  const root = '/repo'
  assert.equal(shouldCopy(join(root, 'scripts', 'start-dsh.mjs'), root), true)
  assert.equal(shouldCopy(join(root, 'src', 'web', 'api.js'), root), true)
  assert.equal(shouldCopy(join(root, 'packages', 'dsh-muse-ui', 'static', 'index.html'), root), true)
  assert.equal(shouldCopy(join(root, 'vendor', 'ds-bot', 'index.js'), root), true)
  assert.equal(shouldCopy(join(root, 'vendor', 'ds-bot', 'test', 'a.js'), root), false)
  assert.equal(shouldCopy(join(root, 'vendor', 'ds-bot', 'dev', 'a.js'), root), false)
  assert.equal(shouldCopy(join(root, 'test', 'a.test.js'), root), false)
  assert.equal(shouldCopy(join(root, 'desktop', 'src', 'main.js'), root), false)
  assert.equal(shouldCopy(join(root, 'design', 'x.png'), root), false)
  assert.equal(shouldCopy(join(root, 'docs', 'install.md'), root), false)
  assert.equal(shouldCopy(join(root, '.git', 'HEAD'), root), false)
  assert.equal(shouldCopy(join(root, 'node_modules', 'x'), root), false)
  assert.equal(shouldCopy(join(root, '.env'), root), false)
})

test('applyBundledDeps pins the dsh CLI at the root and drops dev/optional', () => {
  const next = applyBundledDeps({ name: 'opendigitalmate', devDependencies: { playwright: '1' }, optionalDependencies: { x: '1' } })
  assert.equal(next.dependencies['@deepseek-ai/dsh'], ROOT_PACKAGES['@deepseek-ai/dsh'])
  assert.equal(next.dependencies['@modelcontextprotocol/server-memory'], '2.1.1')
  assert.equal(BUNDLED_PACKAGES[MEMORY_PLUGIN], MEMORY_PLUGIN_VERSION)
  assert.equal(MEMORY_PLUGIN_VERSION, '2.1.1')
  assert.equal(next.devDependencies, undefined)
  assert.equal(next.optionalDependencies, undefined)
})

test('stageAppRuntime --skip-npm copies the runtime layout and writes package.json + RUNTIME.json', () => {
  const repo = fakeRepo()
  const out = join(mkdtempSync(join(tmpdir(), 'odm-bundle-out-')), 'app-runtime')
  const result = stageAppRuntime(repo, out, { skipNpm: true })
  assert.equal(existsSync(join(out, 'scripts', 'start-dsh.mjs')), true)
  assert.equal(existsSync(join(out, 'src', 'index.js')), true)
  assert.equal(existsSync(join(out, 'packages', 'dsh-muse-ui', 'index.js')), true)
  assert.equal(existsSync(join(out, 'vendor', 'ds-bot', 'index.js')), true)
  assert.equal(existsSync(join(out, 'vendor', 'ds-bot', 'test')), false)
  assert.equal(existsSync(join(out, 'vendor', 'ds-bot', 'dev')), false)
  assert.equal(existsSync(join(out, 'test')), false)
  assert.equal(existsSync(join(out, 'desktop')), false)
  assert.equal(existsSync(join(out, 'docs')), false)
  assert.equal(existsSync(join(out, '.git')), false)
  assert.equal(existsSync(join(out, '.env')), false)
  const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['@deepseek-ai/dsh'], BUNDLED_PACKAGES['@deepseek-ai/dsh'])
  assert.equal(pkg.devDependencies, undefined)
  const manifest = JSON.parse(readFileSync(join(out, 'RUNTIME.json'), 'utf8'))
  assert.equal(manifest.packages['@deepseek-ai/dsh'], BUNDLED_PACKAGES['@deepseek-ai/dsh'])
  assert.equal(manifest.dshEntry, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  assert.equal(result.install.skipped, true)
  // Staging again must not throw (idempotent sources).
  stageAppRuntime(repo, out, { skipNpm: true })
  rmSync(repo, { recursive: true, force: true })
})

test('bundledDshEntry points at the published @deepseek-ai/dsh JS bin', () => {
  assert.equal(
    bundledDshEntry('/rt'),
    join('/rt', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  )
})

test('desktop CI stages the app runtime before electron-builder', () => {
  const yml = readFileSync(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8')
  const stageAt = yml.indexOf('bundle-app-runtime.mjs')
  const buildAt = yml.indexOf('electron-builder')
  assert.ok(stageAt > 0 && buildAt > stageAt)
  assert.equal(yml.indexOf('setup-uv'), -1)
})

test('nodeArchive pins official Node 24 builds for every desktop CI target', () => {
  assert.equal(NODE_VERSION, '24.22.1')
  for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64'], ['win32', 'x64']]) {
    const info = nodeArchive(platform, arch)
    assert.ok(info.name.includes(NODE_VERSION))
    assert.equal(info.sha256, NODE_ARCHIVES[`${platform}-${arch}`].sha256)
    assert.equal(info.sha256.length, 64)
    assert.ok(info.bytes > 1_000_000)
  }
  assert.throws(() => nodeArchive('linux', 'ia32'))
  assert.equal(bundledNodeExe('/rt', 'linux'), join('/rt', 'node', 'bin', 'node'))
  assert.equal(bundledNodeExe('/rt', 'win32'), join('/rt', 'node', 'node.exe'))
})
