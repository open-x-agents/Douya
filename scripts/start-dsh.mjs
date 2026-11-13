#!/usr/bin/env node
/**
 * Boot Open Digital Mate as the primary dsh web UI (replaces stock frontend).
 * One process: dsh --profile odm on PORT (default 7777).
 * Muse lives at /api/opendigitalmate/app (dsh-muse-ui client redirects / → there).
 */
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyLlmEnv, ensureAgentDefaultModel, ensureProfileDeepseekCatalog, DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_LEGACY_MODELS } from '../src/web/llm-env.js'
import { syncBotModels } from '../src/web/dsbot-chat.js'
import {
  bundledDshEntry, dshLogPath, ensureMemoryMcp, ensureOdmProfile, linkDir, mergePathEnv,
  resolveDshHome, resolveDshLaunch, resolveMemoryFilePath, resolveMemoryServerEntry,
  resolveOdmDataDir, uniquePathEnv, userHome,
} from './start-dsh-util.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = resolveOdmDataDir({ env: process.env, root: ROOT })
const DSH_HOME = resolveDshHome({ env: process.env, root: ROOT })
const PORT = process.env.PORT || process.argv[2] || '7777'
const DSH_BIN_CANDIDATES = [
  process.env.DSH_BIN,
  bundledDshEntry(ROOT),
  join('/workspace/dsh-rc5/prefix/bin', 'dsh'),
  'dsh',
].filter(Boolean)
const HOME_DIR = userHome()
const DSH_LOG = dshLogPath()
const URL_FILE = join(HOME, 'dsh-web.url')

mkdirSync(HOME, { recursive: true })
mkdirSync(DSH_HOME, { recursive: true })
mkdirSync(join(DSH_HOME, 'profiles'), { recursive: true })

// link:ds-bot resolves imports from vendor/ds-bot's real path, so deep-view must
// live under vendor/ds-bot/node_modules (profile node_modules alone is not enough).
function ensureVendorDsBotDeps() {
  const vendor = join(ROOT, 'vendor/ds-bot')
  const marker = join(vendor, 'node_modules/deep-view/package.json')
  if (existsSync(marker)) return
  // Packaged runtime is read-only (Program Files) and has no npm; deps are staged at build time.
  if (process.env.ODM_PACKAGED) {
    console.warn('[start-dsh] deep-view missing from the packaged runtime — ds-bot may not activate')
    return
  }
  console.log('[start-dsh] installing vendor/ds-bot deps (deep-view)…')
  const result = spawnSync('npm', ['install', '--no-fund', '--no-audit'], {
    cwd: vendor,
    encoding: 'utf8',
    env: process.env,
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    console.warn('[start-dsh] vendor/ds-bot npm install failed — ds-bot may not activate:')
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.stdout) process.stdout.write(result.stdout)
    console.warn('  Manual: npm install --prefix vendor/ds-bot')
    return
  }
  if (!existsSync(marker)) {
    console.warn('[start-dsh] deep-view still missing after install — ds-bot may not activate')
    console.warn('  Manual: npm install --prefix vendor/ds-bot')
  } else {
    console.log('[start-dsh] vendor/ds-bot deps ready (deep-view)')
  }
}
ensureVendorDsBotDeps()

// Source runs may reuse ~/.dsh/profiles/odm. A packaged app uses an isolated
// DSH_HOME under userData and provisions the odm profile from the bundled runtime
// (no pnpm, no network). Never write into the (possibly read-only) ROOT.
const userProfile = join(HOME_DIR, '.dsh/profiles/odm')
const profileLink = join(DSH_HOME, 'profiles', 'odm')
const userMods = join(HOME_DIR, '.dsh/profiles/node_modules')
const modsLink = join(DSH_HOME, 'profiles', 'node_modules')
if (!process.env.ODM_PACKAGED) {
  linkDir(userProfile, profileLink)
  linkDir(userMods, modsLink)
}
ensureOdmProfile({ dshHome: DSH_HOME, runtimeRoot: ROOT })
const profileDir = profileLink

let chatModel = DEEPSEEK_DEFAULT_MODEL
try {
  const cfg = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8'))
  applyLlmEnv(cfg?.llm || {})
  ensureAgentDefaultModel(DSH_HOME, cfg?.llm || { provider: 'deepseek', model: DEEPSEEK_DEFAULT_MODEL })
  if ((cfg?.llm?.provider || 'deepseek') === 'deepseek' && cfg?.llm?.model) chatModel = cfg.llm.model
  if (!process.env.COMPOSIO_API_KEY && cfg?.composioApiKey) process.env.COMPOSIO_API_KEY = cfg.composioApiKey
} catch {
  ensureAgentDefaultModel(DSH_HOME, { provider: 'deepseek', model: DEEPSEEK_DEFAULT_MODEL })
}
// Serve deepseek-flash (vision) on the profile's DeepSeek route so Chief can take native image parts.
try {
  const patch = join(profileDir, 'cordis.patch.yml')
  if (existsSync(profileDir) && ensureProfileDeepseekCatalog(patch, { defaultModel: chatModel === DEEPSEEK_DEFAULT_MODEL ? chatModel : null })) {
    console.log(`🖼  Profile DeepSeek route now serves ${DEEPSEEK_DEFAULT_MODEL} (text+image): ${patch}`)
  }
} catch (err) { console.warn(`[start-dsh] profile catalog update skipped: ${err?.message || err}`) }

// Long-term memory: official MCP Memory, launched by dsh-mcp-client with the
// bundled Node (no npx, no network). The JSONL lives in the writable data dir.
const memoryFile = resolveMemoryFilePath({ env: process.env, dataDir: HOME })
if (memoryFile) process.env.MEMORY_FILE_PATH = memoryFile
const memoryEntry = resolveMemoryServerEntry(ROOT)
try {
  const profilePkg = join(profileDir, 'package.json')
  if (existsSync(profilePkg)) {
    const pkg = JSON.parse(readFileSync(profilePkg, 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles || []
    const deps = pkg?.dependencies || {}
    const hasMuse = bundles.includes('dsh-muse-ui') || deps['dsh-muse-ui']
    if (!hasMuse) {
      console.warn('[start-dsh] dsh-muse-ui not in odm profile — stock dsh shell stays (no Muse Today page).')
      console.warn('  Install: dsh plugin --profile odm add link:' + join(ROOT, 'packages/dsh-muse-ui'))
    } else {
      console.log('🎨 Muse UI: dsh-muse-ui → /api/opendigitalmate/app')
    }
  }
} catch (err) { console.warn(`[start-dsh] profile check skipped: ${err?.message || err}`) }

process.env.ODM_CHAT_MODEL = chatModel
process.env.OPENAI_BASE_URL ||= 'https://api.deepseek.com'
process.env.ODM_MUSE_URL = `http://127.0.0.1:${PORT}`
process.env.DSBOT_URL = process.env.ODM_MUSE_URL
process.env.DSH_HOME = DSH_HOME

console.log('🚀 Open Digital Mate — dsh web UI replaced by Muse')
console.log(`📁 ODM data: ${HOME}`)
console.log(`🧠 DSH_HOME: ${DSH_HOME}`)
console.log(`🌐 http://127.0.0.1:${PORT}/  → redirects to Muse app`)

const dshBin = DSH_BIN_CANDIDATES.find(b => {
  try {
    if (b === 'dsh') return true
    return existsSync(b)
  } catch { return false }
}) || 'dsh'

const pathEnv = mergePathEnv(process.env.PATH || process.env.Path, [
  join('/workspace/dsh-rc5/prefix/bin'),
  dirname(dshBin),
])

function dshCommand(args, envExtra = {}) {
  const launch = resolveDshLaunch({ dshBin, nodeExe: process.execPath, env: process.env })
  const env = uniquePathEnv({
    ...launch.env,
    ...envExtra,
    DSH_HOME,
    ODM_DATA_DIR: HOME,
    ODM_MUSE_URL: process.env.ODM_MUSE_URL,
    DSBOT_URL: process.env.DSBOT_URL,
  }, pathEnv)
  return { exe: launch.exe, args: [...launch.args, ...args], env, shell: launch.shell }
}

// Register official MCP Memory on the odm profile (dsh-mcp-client + bundled Node).
// Rewritten every start so command / MEMORY_FILE_PATH stay current. No npx, no network.
try {
  if (memoryEntry && memoryFile) {
    mkdirSync(dirname(memoryFile), { recursive: true })
    const mcp = ensureMemoryMcp({
      profileDir,
      nodeExe: process.execPath,
      entry: memoryEntry,
      memoryFile,
    })
    if (mcp.action === 'skip') {
      console.warn('[start-dsh] MCP Memory config skipped — chat long-term memory stays off.')
    } else {
      console.log(`🧠 Long-term memory: MCP Memory → ${memoryFile} (tools mcp__memory__*)`)
    }
  } else {
    console.warn('[start-dsh] @modelcontextprotocol/server-memory not in the runtime — chat long-term memory stays off.')
  }
} catch (err) { console.warn(`[start-dsh] MCP Memory setup skipped: ${err?.message || err}`) }

const log = createWriteStream(DSH_LOG, { flags: 'w' })
const cmd = dshCommand(['--profile', 'odm', '--no-open', '--port', String(PORT)])
// cwd is the writable data dir: ROOT may be read-only under Program Files.
const child = spawn(cmd.exe, cmd.args, {
  cwd: HOME,
  env: cmd.env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  shell: cmd.shell,
})
child.stdout.pipe(log)
child.stderr.pipe(log)
child.stdout.on('data', buf => {
  const s = buf.toString()
  process.stdout.write(s)
  const m = s.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)
  if (m) {
    writeFileSync(URL_FILE, m[0] + '\n')
    console.log(`🔑 Login URL saved → ${URL_FILE}`)
    console.log(`🖼  Muse UI: ${m[0].replace(/\?token=.*/, '')}api/opendigitalmate/app (after login)`)
    // Bots still pinned to a legacy text-only alias move to the configured chat model.
    if (!DEEPSEEK_LEGACY_MODELS.has(chatModel)) {
      setTimeout(() => {
        syncBotModels({ home: HOME, to: `deepseek/${chatModel}`, from: [...DEEPSEEK_LEGACY_MODELS].map(x => `deepseek/${x}`) })
          .then(r => { if (r.updated.length) console.log(`🧠 Bots moved to deepseek/${chatModel}: ${r.updated.join(', ')}`) })
          .catch(err => console.warn(`[start-dsh] bot model sync skipped: ${err?.message || err}`))
      }, 3_000)
    }
  }
})
child.stderr.on('data', buf => process.stderr.write(buf))
child.on('exit', code => process.exit(code || 0))
process.on('SIGINT', () => { child.kill('SIGTERM'); process.exit(0) })
process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0) })
