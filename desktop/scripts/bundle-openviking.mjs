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
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, rmSync, renameSync, readdirSync, statSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import { dirname, join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { LOCAL_EMBED_FILENAME, LOCAL_EMBED_MODEL } from '../src/openviking.js'

export const PBS_RELEASE = '20261026'
export const PYTHON_VERSION = '3.13.18'
export const OPENVIKING_VERSION = '0.5.4'

// Official OpenViking 0.5.4 local model (MIT, Chinese, 512-d). SHA-256 is the Hugging Face LFS oid.
export const LOCAL_EMBED_URL = 'https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-f16.gguf?download=true'
export const LOCAL_EMBED_SHA256 = 'ab9b81d9cd329c712eee379cf0068eabe6a5e2a01d0def61535eba9384085e2c'
export const LOCAL_EMBED_BYTES = 47886240
export const LLAMA_CPP_PYTHON_VERSION = '0.3.36'
// Official CPU wheels from the llama-cpp-python GitHub release (sha256 from the release digest).
// macOS Intel has no recent wheel, so that job builds from the PyPI sdist.
export const LLAMA_CPP_WHEELS = {
  'darwin-arm64': {
    name: 'llama_cpp_python-0.3.36-py3-none-macosx_11_0_arm64.whl',
    sha256: '1bec5e1d9fc7c4919aaece647bbd3e1a7f36ac8fd2714c8cda7e6991a544557b',
    bytes: 24928299,
  },
  'linux-x64': {
    name: 'llama_cpp_python-0.3.36-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl',
    sha256: 'c8a3e98093e950d7a770f794842e36f2db82b2933e8762ed7b5ffd435011e8e4',
    bytes: 27077498,
  },
  'win32-x64': {
    name: 'llama_cpp_python-0.3.36-py3-none-win_amd64.whl',
    sha256: 'ae5e88a2cf464e5a2dde7c8898c2d5c71cc24d03cac6396bf7509456bde0b9fb',
    bytes: 7767370,
  },
}

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

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function downloadAndVerify(url, dest, sha256, expectedBytes) {
  await download(url, dest)
  const st = statSync(dest)
  if (expectedBytes != null && st.size !== expectedBytes) {
    throw new Error(`size mismatch for ${dest}: got ${st.size}, expected ${expectedBytes}`)
  }
  const got = sha256File(dest)
  if (got !== sha256) {
    try { unlinkSync(dest) } catch {}
    throw new Error(`sha256 mismatch for ${dest}: got ${got}, expected ${sha256}`)
  }
}

export function llamaCppWheelSpec(platform, arch) {
  return LLAMA_CPP_WHEELS[`${platform}-${arch}`] || null
}

export function hasLlamaCppWheel(platform, arch) {
  return Boolean(llamaCppWheelSpec(platform, arch))
}

export function llamaCppWheelUrl(platform, arch) {
  const spec = llamaCppWheelSpec(platform, arch)
  if (!spec) return null
  return `https://github.com/abetlen/llama-cpp-python/releases/download/v${LLAMA_CPP_PYTHON_VERSION}/${spec.name}`
}

async function installLlamaCpp(python, site, platform, arch) {
  const spec = llamaCppWheelSpec(platform, arch)
  if (spec) {
    const url = llamaCppWheelUrl(platform, arch)
    const dest = join(dirname(site), spec.name)
    console.log(`[bundle-ov] uv pip install llama-cpp-python==${LLAMA_CPP_PYTHON_VERSION} (CPU wheel ${spec.name})`)
    await downloadAndVerify(url, dest, spec.sha256, spec.bytes)
    run('uv', ['pip', 'install', '--python', python, '--target', site, dest])
    try { unlinkSync(dest) } catch {}
    return 'wheel'
  }
  // Install from PyPI only. Do not pass the HTML CPU wheel index: uv would pin
  // to that index, hide the sdist, and refuse macOS Intel with "no matching wheel".
  console.log(`[bundle-ov] uv pip install llama-cpp-python==${LLAMA_CPP_PYTHON_VERSION} (source, no wheel for ${platform}-${arch})`)
  const env = {
    ...process.env,
    CMAKE_ARGS: '-DGGML_METAL=OFF -DGGML_CUDA=OFF -DGGML_NATIVE=OFF -DGGML_BLAS=OFF',
    FORCE_CMAKE: '1',
  }
  run('uv', ['pip', 'install', '--python', python, '--target', site, `llama-cpp-python==${LLAMA_CPP_PYTHON_VERSION}`], { env })
  return 'source'
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
  const llamaHow = await installLlamaCpp(python, site, platform, arch)

  const modelsDir = join(out, 'models')
  mkdirSync(modelsDir, { recursive: true })
  const modelPath = join(modelsDir, LOCAL_EMBED_FILENAME)
  console.log(`[bundle-ov] downloading ${LOCAL_EMBED_MODEL}`)
  await downloadAndVerify(LOCAL_EMBED_URL, modelPath, LOCAL_EMBED_SHA256, LOCAL_EMBED_BYTES)

  pruneRuntime(out)
  writeFileSync(
    join(out, 'VERSION'),
    `${OPENVIKING_VERSION}\npython ${PYTHON_VERSION}+${PBS_RELEASE}\nembedding ${LOCAL_EMBED_MODEL} sha256:${LOCAL_EMBED_SHA256}\nllama-cpp-python ${LLAMA_CPP_PYTHON_VERSION} (${llamaHow})\n`,
  )
  console.log(`[bundle-ov] ready at ${out}`)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:path')).resolve(process.argv[1])
if (isMain) {
  main().catch((err) => { console.error(`[bundle-ov] ${err.stack || err.message}`) ; process.exit(1) })
}
