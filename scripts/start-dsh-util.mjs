// Cross-platform bits used by scripts/start-dsh.mjs (Windows has no `ln`, uses
// Path/PATH, and os.tmpdir() instead of /tmp). Keep this import-safe for tests.
import { existsSync, mkdirSync, symlinkSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'

export function userHome(env = process.env) {
  return env.HOME || env.USERPROFILE || ''
}

export function dshLogPath(env = process.env) {
  return env.ODM_DSH_LOG || join(tmpdir(), 'odm-dsh.log')
}

/** Data dir for config / login URL. Packaged app sets ODM_DATA_DIR to a writable userData path. */
export function resolveOdmDataDir({ env = process.env, root } = {}) {
  return env.ODM_DATA_DIR || join(root, '.odm-data')
}

/** dsh profile / host home. Packaged app sets DSH_HOME to a writable userData path. */
export function resolveDshHome({ env = process.env, root } = {}) {
  return env.DSH_HOME || join(root, '.dsh-odm')
}

export const DSH_JS_ENTRY = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/** JS entry of a bundled (or prefix) dsh install, or null. */
export function bundledDshEntry(runtimeRoot, exists = existsSync) {
  if (!runtimeRoot) return null
  const entry = join(runtimeRoot, DSH_JS_ENTRY)
  return exists(entry) ? entry : null
}

/**
 * If `dshBin` is a JS entry, an npm shim, or a unix launcher, return the
 * underlying `lib/bin.js` so we can spawn it with a known Node (Electron's,
 * via ELECTRON_RUN_AS_NODE) and never rely on a `.cmd` shim or `node` on PATH.
 */
export function resolveDshEntry(dshBin, exists = existsSync) {
  if (!dshBin || dshBin === 'dsh') return null
  if (/\.js$/i.test(dshBin) && exists(dshBin)) return dshBin
  const dir = dirname(dshBin)
  const guesses = [
    join(dir, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(dir, '..', 'lib', 'bin.js'),
    join(dir, 'lib', 'bin.js'),
  ]
  return guesses.find((p) => exists(p)) || null
}

/**
 * How to spawn dsh: prefer `nodeExe + lib/bin.js` so Windows needs no node on
 * PATH and `.cmd` shims are not used. Last resort is the raw binary, with
 * `shell: true` only for `.cmd`/`.bat`.
 */
export function resolveDshLaunch({
  dshBin, nodeExe, env = {}, platform = process.platform, exists = existsSync,
} = {}) {
  const entry = resolveDshEntry(dshBin, exists)
  const childEnv = { ...env }
  if (entry && nodeExe) {
    if (env.ELECTRON_RUN_AS_NODE || /electron/i.test(String(nodeExe))) {
      childEnv.ELECTRON_RUN_AS_NODE = '1'
    }
    return { exe: nodeExe, args: [entry], env: childEnv, shell: false }
  }
  const shell = platform === 'win32' && /\.(cmd|bat)$/i.test(String(dshBin || ''))
  return { exe: dshBin, args: [], env: childEnv, shell }
}

/** Bundles a packaged (or freshly provisioned) odm profile must load. */
export const ODM_PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  'ds-bot',
  'opendigitalmate',
  'dsh-muse-ui',
  'deep-view',
  '@openviking/dsh-memory-plugin',
]

export function odmProfilePackageJson(runtimeRoot) {
  return {
    name: 'dsh-profile-odm',
    private: true,
    dependencies: {
      'opendigitalmate': `file:${runtimeRoot}`,
      'dsh-muse-ui': `file:${join(runtimeRoot, 'packages', 'dsh-muse-ui')}`,
      'ds-bot': `file:${join(runtimeRoot, 'vendor', 'ds-bot')}`,
      'deep-view': '0.1.0',
      '@openviking/dsh-memory-plugin': '0.5.33',
    },
    dsh: { profile: { bundles: [...ODM_PROFILE_BUNDLES] } },
  }
}

export function profileLooksReady(profileDir, exists = existsSync) {
  if (!profileDir || !exists(join(profileDir, 'package.json'))) return false
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles || []
    return bundles.includes('dsh-muse-ui') && bundles.includes('opendigitalmate')
  } catch {
    return false
  }
}

function pluginLinkTargets(runtimeRoot, exists = existsSync) {
  const deepView = [
    join(runtimeRoot, 'vendor', 'ds-bot', 'node_modules', 'deep-view'),
    join(runtimeRoot, 'node_modules', 'deep-view'),
  ].find((p) => exists(p))
  const memory = [
    join(runtimeRoot, 'bundled-plugins', 'node_modules', '@openviking', 'dsh-memory-plugin'),
    join(runtimeRoot, 'node_modules', '@openviking', 'dsh-memory-plugin'),
  ].find((p) => exists(p))
  return {
    opendigitalmate: runtimeRoot,
    'dsh-muse-ui': join(runtimeRoot, 'packages', 'dsh-muse-ui'),
    'ds-bot': join(runtimeRoot, 'vendor', 'ds-bot'),
    'deep-view': deepView || null,
    '@openviking/dsh-memory-plugin': memory || null,
  }
}

/**
 * Create `$DSH_HOME/profiles/odm` with the Muse / host / memory plugins linked
 * at the bundled runtime, so a packaged install does not need `dsh plugin add`
 * (which needs pnpm and a network). No-ops when the profile is already ready.
 * Writes only under `dshHome`, which must be writable (userData, not Program Files).
 */
export function ensureOdmProfile({
  dshHome, runtimeRoot,
  exists = existsSync,
  mkdir = (p) => mkdirSync(p, { recursive: true }),
  write = (p, t) => writeFileSync(p, t),
  read = (p) => readFileSync(p, 'utf8'),
  link = linkDir,
} = {}) {
  if (!dshHome || !runtimeRoot) return { action: 'skip' }
  const profile = join(dshHome, 'profiles', 'odm')
  if (profileLooksReady(profile, exists)) {
    linkProfilePlugins({ profile, runtimeRoot, exists, mkdir, link })
    return { action: 'exists', profile }
  }
  mkdir(profile)
  write(join(profile, 'package.json'), JSON.stringify(odmProfilePackageJson(runtimeRoot), null, 2) + '\n')
  if (!exists(join(profile, 'cordis.yml'))) write(join(profile, 'cordis.yml'), '[]\n')
  if (!exists(join(profile, 'cordis.patch.yml'))) {
    write(join(profile, 'cordis.patch.yml'), [
      '# Packaged odm profile: bundle patches come from package.json, then this layer.',
      '# Subsequent entries (for example the DeepSeek catalog) are appended as a YAML list.',
      '',
    ].join('\n'))
  }
  if (!exists(join(profile, 'compatibility.json'))) write(join(profile, 'compatibility.json'), '{}\n')
  linkProfilePlugins({ profile, runtimeRoot, exists, mkdir, link })
  return { action: 'created', profile }
}

function linkProfilePlugins({ profile, runtimeRoot, exists, mkdir, link }) {
  const mods = join(profile, 'node_modules')
  mkdir(mods)
  mkdir(join(mods, '@openviking'))
  const targets = pluginLinkTargets(runtimeRoot, exists)
  const results = {}
  for (const [name, target] of Object.entries(targets)) {
    if (!target) { results[name] = 'missing'; continue }
    results[name] = link(target, join(mods, name))
  }
  return results
}

/** De-duplicate PATH entries, using the platform delimiter unless `sep` is set. */
export function mergePathEnv(current, extras = [], sep = delimiter) {
  const out = []
  for (const part of [...String(current || '').split(sep), ...extras.flatMap((p) => String(p || '').split(sep))]) {
    if (part && !out.includes(part)) out.push(part)
  }
  return out.join(sep)
}

/** Windows env is case-insensitive; keep a single PATH so we do not double the value. */
export function uniquePathEnv(env, pathValue, platform = process.platform) {
  const out = { ...env }
  if (platform === 'win32') {
    for (const k of Object.keys(out)) {
      if (k !== 'PATH' && k.toUpperCase() === 'PATH') delete out[k]
    }
  }
  out.PATH = pathValue
  return out
}

/**
 * Link a directory (junction on Windows, symlink elsewhere). Fall back to a
 * recursive copy if the link is refused (no privilege, or a cross-drive path).
 */
export function linkDir(target, dest, {
  platform = process.platform,
  exists = existsSync,
  mkdir = (p) => mkdirSync(p, { recursive: true }),
  symlink = symlinkSync,
  copy = (s, d) => cpSync(s, d, { recursive: true }),
} = {}) {
  if (!target || !dest) return 'skip'
  if (!exists(target)) return 'skip'
  if (exists(dest)) return 'exists'
  mkdir(dirname(dest))
  try {
    symlink(target, dest, platform === 'win32' ? 'junction' : 'dir')
    return 'link'
  } catch {
    copy(target, dest)
    return 'copy'
  }
}
