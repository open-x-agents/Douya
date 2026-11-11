import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dshLogPath, linkDir, mergePathEnv, uniquePathEnv, userHome } from '../scripts/start-dsh-util.mjs'

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
