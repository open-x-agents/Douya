// Cross-platform bits used by scripts/start-dsh.mjs (Windows has no `ln`, uses
// Path/PATH, and os.tmpdir() instead of /tmp). Keep this import-safe for tests.
import { existsSync, mkdirSync, symlinkSync, cpSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import {
  MCP_MEMORY_PLUGIN_ID, MCP_MEMORY_SERVER_NAME,
} from '../src/digest/mcp-memory.js'
export {
  MCP_MEMORY_PACKAGE, MCP_MEMORY_VERSION, MCP_MEMORY_SERVER_NAME, MCP_MEMORY_PLUGIN_ID,
  MCP_MEMORY_ENTRY, resolveMemoryFilePath, resolveMemoryServerEntry,
} from '../src/digest/mcp-memory.js'
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
  return {
    opendigitalmate: runtimeRoot,
    'dsh-muse-ui': join(runtimeRoot, 'packages', 'dsh-muse-ui'),
    'ds-bot': join(runtimeRoot, 'vendor', 'ds-bot'),
    'deep-view': deepView || null,
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
    syncOdmProfilePackage(profile, runtimeRoot, { exists, read, write })
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
  syncOdmProfilePackage(profile, runtimeRoot, { exists, read, write })
  linkProfilePlugins({ profile, runtimeRoot, exists, mkdir, link })
  return { action: 'created', profile }
}

function linkProfilePlugins({ profile, runtimeRoot, exists, mkdir, link }) {
  const mods = join(profile, 'node_modules')
  mkdir(mods)
  const targets = pluginLinkTargets(runtimeRoot, exists)
  const results = {}
  for (const [name, target] of Object.entries(targets)) {
    if (!target) { results[name] = 'missing'; continue }
    results[name] = link(target, join(mods, name))
  }
  return results
}


/**
 * Keep an existing odm profile's package.json on the canonical bundles and
 * dependencies. Drops retired plugins and stale node_modules links that are
 * not in the current set, so an upgrade does not keep loading a removed bundle.
 */
export function syncOdmProfilePackage(profileDir, runtimeRoot, {
  exists = existsSync,
  read = (p) => readFileSync(p, 'utf8'),
  write = (p, t) => writeFileSync(p, t),
  rm = (p) => rmSync(p, { recursive: true, force: true }),
  list = (p) => readdirSync(p, { withFileTypes: true }),
} = {}) {
  if (!profileDir || !exists(join(profileDir, 'package.json'))) return { action: 'skip' }
  const path = join(profileDir, 'package.json')
  let pkg
  try { pkg = JSON.parse(read(path)) } catch { return { action: 'skip' } }
  const canonical = odmProfilePackageJson(runtimeRoot || '.')
  let changed = false
  const wantBundles = [...ODM_PROFILE_BUNDLES]
  const haveBundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  const bundlesMatch = haveBundles.length === wantBundles.length
    && wantBundles.every((b, i) => haveBundles[i] === b)
  if (!bundlesMatch) {
    if (!pkg.dsh) pkg.dsh = {}
    if (!pkg.dsh.profile) pkg.dsh.profile = {}
    pkg.dsh.profile.bundles = wantBundles
    changed = true
  }
  if (!pkg.dependencies) pkg.dependencies = {}
  for (const k of Object.keys(pkg.dependencies)) {
    if (!(k in canonical.dependencies)) {
      delete pkg.dependencies[k]
      changed = true
    }
  }
  if (runtimeRoot) {
    for (const [k, v] of Object.entries(canonical.dependencies)) {
      if (pkg.dependencies[k] !== v) {
        pkg.dependencies[k] = v
        changed = true
      }
    }
  }
  if (changed) write(path, JSON.stringify(pkg, null, 2) + '\n')

  const allowed = new Set([...ODM_PROFILE_BUNDLES, ...Object.keys(canonical.dependencies)])
  const mods = join(profileDir, 'node_modules')
  if (exists(mods)) {
    try {
      for (const ent of list(mods)) {
        if (!ent.isDirectory() && !ent.isSymbolicLink()) continue
        const name = ent.name
        if (name.startsWith('.')) continue
        if (name.startsWith('@')) {
          const scope = join(mods, name)
          try {
            for (const inner of list(scope)) {
              const full = `${name}/${inner.name}`
              if (!allowed.has(full)) {
                try { rm(join(scope, inner.name)) } catch { /* leftover link is not fatal */ }
              }
            }
            if (list(scope).length === 0) {
              try { rm(scope) } catch { /* empty scope */ }
            }
          } catch { /* listing is best-effort */ }
        } else if (!allowed.has(name)) {
          try { rm(join(mods, name)) } catch { /* leftover link is not fatal */ }
        }
      }
    } catch { /* listing is best-effort */ }
  }
  return { action: changed ? 'synced' : 'clean' }
}

function yamlString(s) {
  return JSON.stringify(String(s))
}

/** Cordis patch that *inserts* official MCP Memory via dsh-mcp-client (stdio, bundled Node).
 * A raw `- id:` row is a replace-patch and is skipped when the id is not already
 * in the document (dsh: "unknown targets … are warned and skipped"). */
export function memoryMcpPatchYaml({ nodeExe, entry, memoryFile }) {
  return [
    '- insert:',
    `    - id: ${MCP_MEMORY_PLUGIN_ID}`,
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    `        serverName: ${MCP_MEMORY_SERVER_NAME}`,
    '        transport: stdio',
    `        command: ${yamlString(nodeExe)}`,
    '        args:',
    `          - ${yamlString(entry)}`,
    '        env:',
    `          MEMORY_FILE_PATH: ${yamlString(memoryFile)}`,
    '        failOnStartupError: false',
    '',
  ].join('\n')
}

const MEMORY_MCP_INSERT_RE = /^- insert:\n[ \t]+- id: odm-mcp-memory\n(?:[ \t]+.*\n)*/m
const MEMORY_MCP_RAW_RE = /^- id: odm-mcp-memory\n(?:[ \t].*\n)*/m

export function upsertMemoryMcpPatch(text, opts) {
  const block = memoryMcpPatchYaml(opts)
  let t = text || ''
  if (t && !t.endsWith('\n')) t += '\n'
  t = t.replace(MEMORY_MCP_INSERT_RE, '').replace(MEMORY_MCP_RAW_RE, '')
  if (t && !t.endsWith('\n')) t += '\n'
  return t + block
}

/**
 * Write (or refresh) the MCP Memory client into the profile's cordis.patch.yml.
 * Paths are concrete so a packaged install never shells out to `npx` and never
 * writes the graph under extraResources.
 */
export function ensureMemoryMcp({
  profileDir, nodeExe, entry, memoryFile,
  exists = existsSync,
  read = (p) => readFileSync(p, 'utf8'),
  write = (p, t) => writeFileSync(p, t),
  mkdir = (p) => mkdirSync(p, { recursive: true }),
} = {}) {
  if (!profileDir || !nodeExe || !entry || !memoryFile) return { action: 'skip' }
  mkdir(profileDir)
  const patch = join(profileDir, 'cordis.patch.yml')
  const before = exists(patch) ? read(patch) : ''
  const after = upsertMemoryMcpPatch(before, { nodeExe, entry, memoryFile })
  if (after === before) return { action: 'unchanged', patch }
  write(patch, after)
  return { action: before.trim() ? 'updated' : 'created', patch }
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
