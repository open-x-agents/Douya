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
import { dshLogPath, linkDir, mergePathEnv, uniquePathEnv, userHome } from './start-dsh-util.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = join(ROOT, '.odm-data')
const DSH_HOME = process.env.DSH_HOME || join(ROOT, '.dsh-odm')
const PORT = process.env.PORT || process.argv[2] || '7777'
const DSH_BIN_CANDIDATES = [
  process.env.DSH_BIN,
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
  console.log('[start-dsh] installing vendor/ds-bot deps (deep-view)…')
  const result = spawnSync('npm', ['install', '--no-fund', '--no-audit'], {
    cwd: vendor,
    encoding: 'utf8',
    env: process.env,
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

// Link user odm profile + shared node_modules if present (symlink, or a junction / copy on Windows).
const userProfile = join(HOME_DIR, '.dsh/profiles/odm')
const profileLink = join(DSH_HOME, 'profiles', 'odm')
const userMods = join(HOME_DIR, '.dsh/profiles/node_modules')
const modsLink = join(DSH_HOME, 'profiles', 'node_modules')
linkDir(userProfile, profileLink)
linkDir(userMods, modsLink)

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
  const patch = join(userProfile, 'cordis.patch.yml')
  if (existsSync(userProfile) && ensureProfileDeepseekCatalog(patch, { defaultModel: chatModel === DEEPSEEK_DEFAULT_MODEL ? chatModel : null })) {
    console.log(`🖼  Profile DeepSeek route now serves ${DEEPSEEK_DEFAULT_MODEL} (text+image): ${patch}`)
  }
} catch (err) { console.warn(`[start-dsh] profile catalog update skipped: ${err?.message || err}`) }

// Long-term memory: OpenViking (`@openviking/dsh-memory-plugin`). Needs a reachable
// OpenViking server (default http://127.0.0.1:1933) + ~/.openviking/ovcli.conf.
try {
  const profilePkg = join(userProfile, 'package.json')
  if (existsSync(profilePkg)) {
    const pkg = JSON.parse(readFileSync(profilePkg, 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles || []
    const deps = pkg?.dependencies || {}
    const hasOv = bundles.includes('@openviking/dsh-memory-plugin') || deps['@openviking/dsh-memory-plugin']
    if (hasOv) {
      const ovUrl = process.env.OPENVIKING_URL || process.env.OPENVIKING_BASE_URL || 'http://127.0.0.1:1933'
      console.log(`🧠 Long-term memory: OpenViking → ${ovUrl} (Muse Glimpse reads viking://~/memories)`)
    }
    if (bundles.includes('dsh-memory') || deps['dsh-memory']) {
      console.warn('[start-dsh] legacy dsh-memory still listed — remove after OpenViking is healthy (SQLite is Glimpse fallback only).')
    }
    const hasMuse = bundles.includes('dsh-muse-ui') || deps['dsh-muse-ui']
    if (!hasMuse) {
      console.warn('[start-dsh] dsh-muse-ui not in odm profile — stock dsh shell stays (no Muse Today page).')
      console.warn('  Install: dsh plugin --profile odm add link:' + join(ROOT, 'packages/dsh-muse-ui'))
    } else {
      console.log('🎨 Muse UI: dsh-muse-ui → /api/opendigitalmate/app')
    }
  }
} catch (err) { console.warn(`[start-dsh] memory plugin check skipped: ${err?.message || err}`) }

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

// Fresh machines: add the memory plugin so the bundled OpenViking server is actually used.
try {
  const profilePkg = join(userProfile, 'package.json')
  if (existsSync(profilePkg)) {
    const pkg = JSON.parse(readFileSync(profilePkg, 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles || []
    const deps = pkg?.dependencies || {}
    const hasOv = bundles.includes('@openviking/dsh-memory-plugin') || deps['@openviking/dsh-memory-plugin']
    if (!hasOv) {
      console.warn('[start-dsh] @openviking/dsh-memory-plugin not in odm profile — trying to add it.')
      const add = spawnSync(dshBin, ['plugin', '--profile', 'odm', 'add', '@openviking/dsh-memory-plugin@0.5.33'], {
        encoding: 'utf8', env: process.env, timeout: 120_000,
      })
      if (add.status !== 0) {
        console.warn('[start-dsh] auto-add failed — chat long-term memory stays off until you run:')
        console.warn('  dsh plugin --profile odm add @openviking/dsh-memory-plugin@0.5.33')
        if (add.stderr) process.stderr.write(add.stderr)
      } else {
        console.log('[start-dsh] added @openviking/dsh-memory-plugin@0.5.33 to the odm profile')
      }
    }
  }
} catch (err) { console.warn(`[start-dsh] memory plugin auto-add skipped: ${err?.message || err}`) }

const pathEnv = mergePathEnv(process.env.PATH || process.env.Path, [
  join('/workspace/dsh-rc5/prefix/bin'),
  dirname(dshBin),
])

const log = createWriteStream(DSH_LOG, { flags: 'w' })
const child = spawn(dshBin, ['--profile', 'odm', '--no-open', '--port', String(PORT)], {
  cwd: ROOT,
  env: uniquePathEnv({ ...process.env, DSH_HOME, ODM_MUSE_URL: process.env.ODM_MUSE_URL, DSBOT_URL: process.env.DSBOT_URL }, pathEnv),
  stdio: ['ignore', 'pipe', 'pipe'],
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
