import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  bundledDshEntry, dshLogPath, ensureOdmProfile, linkDir, mergePathEnv,
  odmProfilePackageJson, profileLooksReady, resolveDshEntry, resolveDshHome,
  resolveDshLaunch, resolveOdmDataDir, uniquePathEnv, userHome,
} from '../scripts/start-dsh-util.mjs'

test('userHome prefers HOME, then USERPROFILE', () => {
  assert.equal(userHome({ HOME: '/Users/a', USERPROFILE: 'C:\\Users\\a' }), '/Users/a')
  assert.equal(userHome({ USERPROFILE: 'C:\\Users\\a' }), 'C:\\Users\\a')
  assert.equal(userHome({}), '')
})

test('dshLogPath uses ODM_DSH_LOG or the OS temp dir, never a hard-coded /tmp path', () => {
  assert.equal(dshLogPath({ ODM_DSH_LOG: '/var/tmp/custom.log' }), '/var/tmp/custom.log')
  const def = dshLogPath({})
  assert.match(def, /odm-dsh\.log$/)
  assert.equal(def, join(tmpdir(), 'odm-dsh.log'))
})

test('mergePathEnv de-duplicates with the given delimiter', () => {
  assert.equal(mergePathEnv('C:\\a;C:\\b', ['C:\\b', 'C:\\c'], ';'), 'C:\\a;C:\\b;C:\\c')
  assert.equal(mergePathEnv('/usr/bin:/bin', ['/opt/homebrew/bin:/usr/bin'], ':'), '/usr/bin:/bin:/opt/homebrew/bin')
})

test('uniquePathEnv keeps a single PATH on Windows', () => {
  const env = uniquePathEnv({ Path: 'C:\\old', FOO: '1' }, 'C:\\new', 'win32')
  assert.equal(env.PATH, 'C:\\new')
  assert.equal(env.Path, undefined)
  assert.equal(env.FOO, '1')
})

test('linkDir creates a symlink when allowed, copies when symlink fails, skips if dest exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'odm-link-'))
  const target = join(root, 'src')
  const dest = join(root, 'dst')
  mkdirSync(target)
  writeFileSync(join(target, 'a.txt'), 'hi')
  assert.equal(linkDir(target, dest), 'link')
  assert.equal(existsSync(join(dest, 'a.txt')), true)
  assert.equal(readFileSync(join(dest, 'a.txt'), 'utf8'), 'hi')
  assert.equal(linkDir(target, dest), 'exists')
  assert.equal(linkDir('/no/such', join(root, 'x')), 'skip')

  const dest2 = join(root, 'copied')
  const got = linkDir(target, dest2, {
    symlink: () => { throw new Error('EPERM') },
  })
  assert.equal(got, 'copy')
  assert.equal(readFileSync(join(dest2, 'a.txt'), 'utf8'), 'hi')
})

test('start-dsh.mjs is no longer POSIX-only (no ln, no /tmp, no colon PATH join)', () => {
  const src = readFileSync(new URL('../scripts/start-dsh.mjs', import.meta.url), 'utf8')
  assert.match(src, /linkDir/)
  assert.match(src, /mergePathEnv/)
  assert.match(src, /uniquePathEnv/)
  assert.match(src, /dshLogPath/)
  assert.doesNotMatch(src, /spawn\('ln'/)
  assert.doesNotMatch(src, /DSH_LOG = '\/tmp\/odm-dsh\.log'/)
  assert.doesNotMatch(src, /filter\(Boolean\)\.join\(':'\)/)
})

test('resolveOdmDataDir / resolveDshHome: env wins, else a folder under root', () => {
  assert.equal(resolveOdmDataDir({ env: { ODM_DATA_DIR: '/data' }, root: '/repo' }), '/data')
  assert.equal(resolveOdmDataDir({ env: {}, root: '/repo' }), join('/repo', '.odm-data'))
  assert.equal(resolveDshHome({ env: { DSH_HOME: '/h' }, root: '/repo' }), '/h')
  assert.equal(resolveDshHome({ env: {}, root: '/repo' }), join('/repo', '.dsh-odm'))
})

test('resolveDshEntry unwraps npm shims to lib/bin.js; resolveDshLaunch prefers node + that entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'odm-dsh-entry-'))
  const entry = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, '#!/usr/bin/env node\n')
  const shim = join(root, 'node_modules', '.bin', 'dsh')
  mkdirSync(dirname(shim), { recursive: true })
  writeFileSync(shim, '')
  const cmd = join(root, 'node_modules', '.bin', 'dsh.cmd')
  writeFileSync(cmd, '')

  assert.equal(resolveDshEntry(entry), entry)
  assert.equal(resolveDshEntry(shim), entry)
  assert.equal(resolveDshEntry(cmd), entry)
  assert.equal(resolveDshEntry('dsh'), null)
  assert.equal(bundledDshEntry(root), entry)

  const electron = resolveDshLaunch({
    dshBin: entry, nodeExe: '/Applications/Douya.app/Contents/MacOS/Douya',
    env: { ELECTRON_RUN_AS_NODE: '1', FOO: '1' },
  })
  assert.equal(electron.exe, '/Applications/Douya.app/Contents/MacOS/Douya')
  assert.deepEqual(electron.args, [entry])
  assert.equal(electron.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(electron.shell, false)

  const winCmd = resolveDshLaunch({
    dshBin: 'C:\\\\Users\\\\a\\\\dsh.cmd', nodeExe: null, platform: 'win32', exists: () => false,
  })
  assert.equal(winCmd.exe, 'C:\\\\Users\\\\a\\\\dsh.cmd')
  assert.equal(winCmd.shell, true)
  assert.deepEqual(winCmd.args, [])
})

test('ensureOdmProfile creates a writable odm profile and links bundled plugins', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-profile-'))
  const runtime = join(tmp, 'runtime')
  const dshHome = join(tmp, 'dsh-home')
  for (const rel of [
    'scripts/start-dsh.mjs',
    'packages/dsh-muse-ui/package.json',
    'vendor/ds-bot/package.json',
    'vendor/ds-bot/node_modules/deep-view/package.json',
    'node_modules/@openviking/dsh-memory-plugin/package.json',
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
  ]) {
    mkdirSync(dirname(join(runtime, rel)), { recursive: true })
    writeFileSync(join(runtime, rel), rel.endsWith('.json') ? '{"name":"x"}' : '// x\n')
  }
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'opendigitalmate' }))

  const first = ensureOdmProfile({ dshHome, runtimeRoot: runtime })
  assert.equal(first.action, 'created')
  assert.equal(profileLooksReady(first.profile), true)
  const pkg = JSON.parse(readFileSync(join(first.profile, 'package.json'), 'utf8'))
  assert.ok(pkg.dsh.profile.bundles.includes('dsh-muse-ui'))
  assert.ok(pkg.dsh.profile.bundles.includes('opendigitalmate'))
  assert.ok(existsSync(join(first.profile, 'node_modules', 'opendigitalmate', 'package.json')))
  assert.ok(existsSync(join(first.profile, 'node_modules', 'dsh-muse-ui', 'package.json')))
  assert.ok(existsSync(join(first.profile, 'node_modules', 'ds-bot', 'package.json')))
  assert.ok(existsSync(join(first.profile, 'node_modules', 'deep-view', 'package.json')))
  assert.ok(existsSync(join(first.profile, 'node_modules', '@openviking', 'dsh-memory-plugin', 'package.json')))
  const st = lstatSync(join(first.profile, 'node_modules', 'opendigitalmate'))
  assert.ok(st.isSymbolicLink() || st.isDirectory())

  const patch = readFileSync(join(first.profile, 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(patch, /^\[\]\s*$/m)
  assert.match(patch, /^#/m)

  const again = ensureOdmProfile({ dshHome, runtimeRoot: runtime })
  assert.equal(again.action, 'exists')
  assert.deepEqual(odmProfilePackageJson(runtime).dsh.profile.bundles, pkg.dsh.profile.bundles)
})

test('start-dsh.mjs uses the writable data-dir helpers and spawns dsh through resolveDshLaunch', () => {
  const src = readFileSync(new URL('../scripts/start-dsh.mjs', import.meta.url), 'utf8')
  assert.match(src, /resolveOdmDataDir/)
  assert.match(src, /resolveDshHome/)
  assert.match(src, /resolveDshLaunch/)
  assert.match(src, /ensureOdmProfile/)
  assert.match(src, /bundledDshEntry/)
  assert.match(src, /cwd: HOME/)
  assert.match(src, /ODM_PACKAGED/)
  assert.doesNotMatch(src, /spawn\(dshBin,/)
})
