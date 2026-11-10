#!/usr/bin/env node
/**
 * Build a relocatable OpenViking runtime for the desktop installer:
 *   python-build-standalone (CPython 3.13) + `pip install openviking` into py/ + lib/.
 *
 * Usage:
 *   node desktop/scripts/bundle-openviking.mjs [--out desktop/resources/openviking]
 *       [--platform darwin|win32|linux] [--arch arm64|x64]
 *
 * Needs `uv` and `tar` on PATH. Run on the target OS/arch (or an arch-matched runner).
 * Unused Volcengine service SDKs pulled in by volcengine-python-sdk are pruned after install.
 */
import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, rmSync, renameSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

export const PBS_RELEASE = '20261026'
export const PYTHON_VERSION = '3.13.18'
export const OPENVIKING_VERSION = '0.5.4'

const TRIPLES = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
}

// Keep only the Volcengine packages the server actually needs for Ark / VikingDB / core auth.
const VOLC_KEEP = new Set([
  'volcengine',
  'volcenginesdkark',
  'volcenginesdkarkruntime',
  'volcenginesdkcore',
  'volcenginesdkvikingdb',
])

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : fallback
}

function pythonTriple(platform, arch) {
  const key = `${platform}-${arch}`
  const triple = TRIPLES[key]
  if (!triple) throw new Error(`No python-build-standalone build for ${key}`)
  return triple
}

export function archiveName(platform, arch) {
  return `cpython-${PYTHON_VERSION}+${PBS_RELEASE}-${pythonTriple(platform, arch)}-install_only_stripped.tar.gz`
}

export function archiveUrl(platform, arch) {
  return `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${archiveName(platform, arch)}`
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`)
}

function which(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    for (const ext of exts) {
      if (dir && existsSync(join(dir, name + ext))) return true
    }
  }
  return false
}

async function download(url, dest) {
  console.log(`[bundle-ov] downloading ${url}`)
  let lastErr
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
      return
    } catch (err) {
      lastErr = err
      console.warn(`[bundle-ov] download retry ${i + 1}: ${err.message}`)
    }
  }
  throw lastErr
}

function walk(dir, visit) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, visit)
    visit(p, name, st)
  }
}

function rmRf(p) {
  try { rmSync(p, { recursive: true, force: true }) } catch {}
}

export function pruneRuntime(root) {
  const lib = existsSync(join(root, 'lib')) ? join(root, 'lib') : join(root, 'site-packages')
  const py = existsSync(join(root, 'py')) ? join(root, 'py') : join(root, 'python')

  // Drop the unused Volcengine service SDKs (CDN, VPC, RDS, …) that the [ark] extra used to pull.
  if (existsSync(lib)) {
    for (const name of readdirSync(lib)) {
      if (!name.startsWith('volcengine')) continue
      // dist-info / underscore package names: volcenginesdk_ark-…, volcengine-1.0.….dist-info
      const keep = [...VOLC_KEEP].some((k) =>
        name === k || name.startsWith(k + '-') || name.startsWith(k + '_') || name.startsWith(k + '.'))
        || name.startsWith('volcengine_ark_runtime')
        || name.startsWith('volcengine_python_sdk')
        || name.startsWith('volcenginesdk_ark')
        || name.startsWith('volcenginesdk_core')
        || name.startsWith('volcenginesdk_vikingdb')
        || name === 'volcengine' || name.startsWith('volcengine-')
      // arkclaw is not ark
      if (name.includes('arkclaw') || name.includes('sdk_arkclaw')) { rmRf(join(lib, name)); continue }
      if (!keep) rmRf(join(lib, name))
    }
    walk(lib, (p, name, st) => {
      if (st.isDirectory() && (name === '__pycache__' || name === 'tests' || name === 'test')) rmRf(p)
      else if (st.isFile() && (name.endsWith('.pyc') || name.endsWith('.pyo'))) {
        try { unlinkSync(p) } catch {}
      }
    })
  }
  // Headers and Tcl/Tk share data are not needed to run the server.
  if (existsSync(py)) {
    rmRf(join(py, 'include'))
    rmRf(join(py, 'share'))
  }
}

async function main() {
  const platform = arg('--platform', process.platform)
  const arch = arg('--arch', process.arch === 'arm64' ? 'arm64' : 'x64')
  const out = arg('--out', join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'openviking'))
  const url = archiveUrl(platform, arch)

  if (!which('uv') && !which('uv.exe')) {
    throw new Error('uv is required (https://docs.astral.sh/uv/). CI installs it with astral-sh/setup-uv.')
  }

  mkdirSync(dirname(out), { recursive: true })
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })

  const archive = join(out, archiveName(platform, arch))
  await download(url, archive)
  run('tar', ['-xzf', archive, '-C', out])
  unlinkSync(archive)

  const extracted = join(out, 'python')
  if (!existsSync(extracted)) throw new Error(`archive did not contain python/: ${out}`)
  const pyDir = join(out, 'py')
  renameSync(extracted, pyDir)

  const python = platform === 'win32' ? join(pyDir, 'python.exe') : join(pyDir, 'bin', 'python3')
  if (!existsSync(python)) throw new Error(`python executable missing: ${python}`)

  const site = join(out, 'lib')
  mkdirSync(site, { recursive: true })
  console.log(`[bundle-ov] uv pip install openviking==${OPENVIKING_VERSION}`)
  run('uv', ['pip', 'install', '--python', python, '--target', site, `openviking==${OPENVIKING_VERSION}`])

  pruneRuntime(out)
  writeFileSync(join(out, 'VERSION'), `${OPENVIKING_VERSION}\npython ${PYTHON_VERSION}+${PBS_RELEASE}\n`)
  console.log(`[bundle-ov] ready at ${out}`)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:path')).resolve(process.argv[1])
if (isMain) {
  main().catch((err) => { console.error(`[bundle-ov] ${err.stack || err.message}`) ; process.exit(1) })
}
