#!/usr/bin/env node
/**
 * Stage the Douya server runtime into desktop/resources/app-runtime so a
 * packaged installer can start without a git checkout, a Node install, or a
 * separate dsh. Copies the host sources and installs @deepseek-ai/dsh plus the
 * profile plugins' production dependencies.
 *
 * Usage:
 *   node desktop/scripts/bundle-app-runtime.mjs [--out desktop/resources/app-runtime]
 *       [--repo <root>] [--skip-npm] [--force-npm]
 *
 * Run on the target OS/arch (CI already does). Needs npm on PATH at build time only.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUNDLED_PACKAGES = {
  '@deepseek-ai/dsh': '0.2.2-rc.1',
  '@modelcontextprotocol/server-memory': '2.1.1',
  'deep-view': '0.1.0',
}

/** dsh and the official MCP Memory server go in the staged root package.json so one
 *  `npm install` fills both (Memory has no conflicting dsh peers). deep-view still
 *  has older peer ranges and is installed under vendor/ds-bot. */
export const ROOT_PACKAGES = {
  '@deepseek-ai/dsh': BUNDLED_PACKAGES['@deepseek-ai/dsh'],
  '@modelcontextprotocol/server-memory': BUNDLED_PACKAGES['@modelcontextprotocol/server-memory'],
}

export const MEMORY_SERVER = '@modelcontextprotocol/server-memory'
export const MEMORY_SERVER_VERSION = BUNDLED_PACKAGES[MEMORY_SERVER]
// Back-compat aliases used by older tests; both now refer to the MCP Memory server.
export const MEMORY_PLUGIN = MEMORY_SERVER
export const MEMORY_PLUGIN_VERSION = MEMORY_SERVER_VERSION

// Official Node 24, matching dsh's engines.node (>=24.9.0). We ship this binary
// because dsh's node-addon-require-builtin rejects Electron 45.2.3
// (supported fingerprints stop at 45.0.0-alpha.6; ELECTRON_RUN_AS_NODE has no V8 context).
export const NODE_VERSION = '24.22.1'
export const NODE_DIST = 'https://nodejs.org/dist'
export const NODE_ARCHIVES = {
  'linux-x64': {
    name: 'node-v24.22.1-linux-x64.tar.xz',
    sha256: '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6',
    bytes: 32026916,
  },
  'linux-arm64': {
    name: 'node-v24.22.1-linux-arm64.tar.xz',
    sha256: 'dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e',
    bytes: 30978868,
  },
  'darwin-x64': {
    name: 'node-v24.22.1-darwin-x64.tar.gz',
    sha256: 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035',
    bytes: 54382566,
  },
  'darwin-arm64': {
    name: 'node-v24.22.1-darwin-arm64.tar.gz',
    sha256: '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7',
    bytes: 53062778,
  },
  'win32-x64': {
    name: 'node-v24.22.1-win-x64.zip',
    sha256: 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
    bytes: 37748064,
  },
}

export function nodeArchive(platform, arch) {
  const key = `${platform}-${arch}`
  const info = NODE_ARCHIVES[key]
  if (!info) throw new Error(`No official Node ${NODE_VERSION} build for ${key}`)
  return info
}

export function bundledNodeExe(runtimeRoot, platform = process.platform) {
  if (platform === 'win32') return join(runtimeRoot, 'node', 'node.exe')
  return join(runtimeRoot, 'node', 'bin', 'node')
}

export const RUNTIME_FILES = [
  'index.js',
  'package.json',
  'config.yml',
  'cordis.patch.yml',
]

export const RUNTIME_DIRS = ['scripts', 'src', 'packages', 'vendor']

// Dropped from a copied tree: tests, design docs, nested installs, runtime data.
export const SKIP_DIR_NAMES = new Set([
  '.git', 'node_modules', 'test', 'tests', 'acceptance-cases', 'design', 'docs',
  'desktop', 'data', '.odm-data', '.dsh-odm', '.dsh', 'dist', 'coverage',
])

const DEFAULT_REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function arg(flag, fallback, argv = process.argv) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : fallback
}

export function hasFlag(flag, argv = process.argv) {
  return argv.includes(flag)
}

export function bundledDshEntry(runtimeRoot) {
  return join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

export function shouldCopy(src, repoRoot) {
  const rel = relative(repoRoot, src)
  if (!rel || rel.startsWith('..')) return false
  const parts = rel.split(/[/\\]/)
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (SKIP_DIR_NAMES.has(p)) return false
    if (p === '.env' || p.startsWith('.env.')) return false
    if (p === '.DS_Store') return false
    // vendor/ds-bot's own test/dev trees are not needed at runtime.
    if (parts[0] === 'vendor' && parts[1] === 'ds-bot' && (p === 'dev' || p === 'test')) return false
  }
  return true
}

function copyFiltered(from, to, repoRoot) {
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      // cpSync also asks about the root itself; always allow the starting point.
      if (src === from) return true
      return shouldCopy(src, repoRoot)
    },
  })
}

export function stageSources(repoRoot, outDir) {
  mkdirSync(outDir, { recursive: true })
  for (const name of RUNTIME_FILES) {
    const from = join(repoRoot, name)
    if (!existsSync(from)) throw new Error(`missing ${name} in ${repoRoot}`)
    cpSync(from, join(outDir, name))
  }
  // vendor/ds-bot/node_modules is installed in this tree and must survive a refresh.
  const vendorMods = join(outDir, 'vendor', 'ds-bot', 'node_modules')
  const stash = join(outDir, '.vendor-node-modules.stash')
  if (existsSync(stash)) rmSync(stash, { recursive: true, force: true })
  if (existsSync(vendorMods)) renameSync(vendorMods, stash)
  for (const name of RUNTIME_DIRS) {
    const from = join(repoRoot, name)
    if (!existsSync(from)) throw new Error(`missing ${name}/ in ${repoRoot}`)
    const dest = join(outDir, name)
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
    copyFiltered(from, dest, repoRoot)
  }
  if (existsSync(stash)) {
    mkdirSync(dirname(vendorMods), { recursive: true })
    if (existsSync(vendorMods)) rmSync(vendorMods, { recursive: true, force: true })
    renameSync(stash, vendorMods)
  }
}

export function applyBundledDeps(pkg) {
  const next = { ...pkg, dependencies: { ...(pkg.dependencies || {}), ...ROOT_PACKAGES } }
  // These are installed into the staged tree; they must not stay peer/dev-only.
  delete next.devDependencies
  delete next.optionalDependencies
  return next
}

export function writeStagedPackageJson(outDir) {
  const pkg = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'))
  const next = applyBundledDeps(pkg)
  writeFileSync(join(outDir, 'package.json'), JSON.stringify(next, null, 2) + '\n')
  return next
}

function runNpm(args, cwd) {
  const result = spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: process.env,
    shell: process.platform === 'win32',
    timeout: 20 * 60 * 1000,
  })
  if (result.status !== 0) {
    const err = (result.stderr || '') + (result.stdout || '') + (result.error?.message || '')
    throw new Error(`npm ${args.join(' ')} failed in ${cwd}:\n${err.slice(-4000)}`)
  }
  return result
}


function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe', env: process.env, shell: process.platform === 'win32' })
  if (result.status !== 0) {
    const err = (result.stderr || '') + (result.stdout || '') + (result.error?.message || '')
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${err.slice(-3000)}`)
  }
  return result
}

function downloadVerified(url, dest, expectedSha, expectedBytes) {
  mkdirSync(dirname(dest), { recursive: true })
  const result = spawnSync('curl', ['-fsSL', '-o', dest, url], { stdio: 'pipe', env: process.env })
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || result.error?.message || '').toString()
    throw new Error(`download ${url} failed:\n${err.slice(-2000)}`)
  }
  const size = statSync(dest).size
  if (expectedBytes && size !== expectedBytes) throw new Error(`${dest} is ${size} bytes, expected ${expectedBytes}`)
  const got = sha256(dest)
  if (got !== expectedSha) throw new Error(`${dest} sha256 ${got}, expected ${expectedSha}`)
}

/** Install a vanilla Node ${NODE_VERSION} binary next to the staged sources. */
export function installBundledNode(outDir, { platform = process.platform, arch = process.arch, force = false } = {}) {
  outDir = resolve(outDir)
  const dest = bundledNodeExe(outDir, platform)
  if (!force && existsSync(dest)) return { skipped: true, dest }
  const info = nodeArchive(platform, arch)
  const tmp = join(outDir, '.node-download')
  mkdirSync(tmp, { recursive: true })
  const archive = join(tmp, info.name)
  downloadVerified(`${NODE_DIST}/v${NODE_VERSION}/${info.name}`, archive, info.sha256, info.bytes)
  const extracted = join(tmp, 'extracted')
  if (existsSync(extracted)) rmSync(extracted, { recursive: true, force: true })
  mkdirSync(extracted, { recursive: true })
  if (info.name.endsWith('.zip')) run('tar', ['-xf', archive, '-C', extracted])
  else if (info.name.endsWith('.tar.xz')) run('tar', ['-xJf', archive, '-C', extracted])
  else run('tar', ['-xzf', archive, '-C', extracted])
  const entries = readdirSync(extracted)
  const root = entries.length === 1 ? join(extracted, entries[0]) : extracted
  const src = platform === 'win32'
    ? join(root, 'node.exe')
    : join(root, 'bin', 'node')
  if (!existsSync(src)) throw new Error(`Node binary missing in archive: ${src}`)
  const finalDir = dirname(dest)
  mkdirSync(finalDir, { recursive: true })
  cpSync(src, dest)
  if (platform !== 'win32') chmodSync(dest, 0o755)
  rmSync(tmp, { recursive: true, force: true })
  if (!existsSync(dest)) throw new Error(`bundled Node missing after install: ${dest}`)
  return { skipped: false, dest }
}

// Official MCP Memory is a root dependency (see ROOT_PACKAGES). deep-view still
// declares older @deepseek-ai/dsh-* peers; at runtime dsh provides its own copies.
export function memoryServerPath(outDir) {
  return join(outDir, 'node_modules', '@modelcontextprotocol', 'server-memory', 'dist', 'index.js')
}
export function memoryPluginPath(outDir) {
  return join(outDir, 'node_modules', MEMORY_SERVER, 'package.json')
}

export function installRuntimeDeps(outDir, { force = false } = {}) {
  const dsh = bundledDshEntry(outDir)
  const deepView = join(outDir, 'vendor', 'ds-bot', 'node_modules', 'deep-view', 'package.json')
  const memory = memoryPluginPath(outDir)
  if (!force && existsSync(dsh) && existsSync(deepView) && existsSync(memory) && existsSync(memoryServerPath(outDir))) {
    return { skipped: true }
  }
  if (force && existsSync(join(outDir, 'node_modules'))) {
    rmSync(join(outDir, 'node_modules'), { recursive: true, force: true })
  }
  runNpm(['install', '--omit=dev', '--no-fund', '--no-audit'], outDir)
  const vendor = join(outDir, 'vendor', 'ds-bot')
  if (existsSync(join(vendor, 'package.json'))) {
    runNpm(['install', '--omit=dev', '--legacy-peer-deps', '--no-fund', '--no-audit'], vendor)
  }
  if (!existsSync(dsh)) {
    throw new Error(`dsh entry missing after npm install: ${dsh}`)
  }
  if (!existsSync(memoryServerPath(outDir))) {
    throw new Error(`MCP Memory server missing after npm install: ${memoryServerPath(outDir)}`)
  }
  return { skipped: false }
}

export function writeManifest(outDir) {
  const manifest = {
    packages: BUNDLED_PACKAGES,
    node: NODE_VERSION,
    builtAt: new Date().toISOString(),
    dshEntry: relative(outDir, bundledDshEntry(outDir)).split(sep).join('/'),
  }
  writeFileSync(join(outDir, 'RUNTIME.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

export function stageAppRuntime(repoRoot, outDir, { skipNpm = false, forceNpm = false } = {}) {
  if (!repoRoot || !outDir) throw new Error('repo root and output dir are required')
  if (!existsSync(join(repoRoot, 'scripts', 'start-dsh.mjs'))) {
    throw new Error(`${repoRoot} is not an openDigitalMate root`)
  }
  mkdirSync(outDir, { recursive: true })
  stageSources(repoRoot, outDir)
  writeStagedPackageJson(outDir)
  let install = { skipped: true }
  let node = { skipped: true }
  if (!skipNpm) {
    install = installRuntimeDeps(outDir, { force: forceNpm })
    node = installBundledNode(outDir, { force: forceNpm })
  }
  const manifest = writeManifest(outDir)
  return { outDir, install, node, manifest }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isMain) {
  const repo = arg('--repo', DEFAULT_REPO)
  const out = arg('--out', join(repo, 'desktop', 'resources', 'app-runtime'))
  try {
    const result = stageAppRuntime(repo, out, {
      skipNpm: hasFlag('--skip-npm'),
      forceNpm: hasFlag('--force-npm'),
    })
    console.log(`[bundle-app-runtime] staged ${result.outDir}`)
    console.log(`[bundle-app-runtime] dsh ${BUNDLED_PACKAGES['@deepseek-ai/dsh']} ${result.install.skipped ? '(kept existing node_modules)' : '(installed)'}`)
    console.log(`[bundle-app-runtime] node ${NODE_VERSION} ${result.node?.skipped ? '(kept existing binary)' : result.node?.dest ? '(installed)' : '(skipped)'}`)
  } catch (err) {
    console.error(`[bundle-app-runtime] ${err.message || err}`)
    process.exit(1)
  }
}
