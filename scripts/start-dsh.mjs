#!/usr/bin/env node
/**
 * Boot Muse UI (port 7777) + real ds-bot via dsh profile `odm` (port 7788).
 * Chat on the Muse page talks only to ds-bot (Chief) over /api/bot.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = join(ROOT, '.odm-data')
const MUSE_PORT = process.env.PORT || process.argv[2] || '7777'
const DSBOT_PORT = process.env.DSBOT_PORT || '7788'
const DSH_LOG = '/tmp/odm-dsh.log'
const URL_FILE = join(HOME, 'dsh-web.url')

mkdirSync(HOME, { recursive: true })
const DSH_HOME = process.env.DSH_HOME || join(ROOT, '.dsh-odm')
mkdirSync(DSH_HOME, { recursive: true })
// Reuse the odm profile from the user's ~/.dsh/profiles via symlink once.
const profileLink = join(DSH_HOME, 'profiles', 'odm')
const userProfile = join(process.env.HOME || '', '.dsh/profiles/odm')
try {
  if (!existsSync(profileLink) && existsSync(userProfile)) {
    mkdirSync(join(DSH_HOME, 'profiles'), { recursive: true })
    spawn('ln', ['-sfn', userProfile, profileLink], { stdio: 'ignore' })
  }
} catch {}

// Prefer DeepSeek key from saved ODM config when env is empty.
try {
  const cfg = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8'))
  if (!process.env.OPENAI_API_KEY && cfg?.llm?.apiKey) process.env.OPENAI_API_KEY = cfg.llm.apiKey
  if (!process.env.COMPOSIO_API_KEY && cfg?.composioApiKey) process.env.COMPOSIO_API_KEY = cfg.composioApiKey
} catch {}
process.env.OPENAI_BASE_URL ||= 'https://api.deepseek.com'
process.env.DSBOT_URL = `http://127.0.0.1:${DSBOT_PORT}`

function killPort(port) {
  try {
    const out = spawn('bash', ['-lc', `lsof -tiTCP:${port} -sTCP:LISTEN | xargs -r kill`], { stdio: 'ignore' })
  } catch {}
}

console.log('🚀 Open Digital Mate — Muse UI + ds-bot')
console.log(`📁 Data: ${HOME}`)
console.log(`🧠 DSH_HOME: ${DSH_HOME}`)
console.log(`🤖 ds-bot (dsh --profile odm) → :${DSBOT_PORT}`)
console.log(`🖼  Muse UI → :${MUSE_PORT}`)

killPort(DSBOT_PORT)
killPort(MUSE_PORT)

const dshLog = createWriteStream(DSH_LOG, { flags: 'w' })
const dsh = spawn('dsh', ['--profile', 'odm', '--no-open', '--port', String(DSBOT_PORT)], {
  cwd: ROOT,
  env: { ...process.env, DSH_HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
})
dsh.stdout.pipe(dshLog)
dsh.stderr.pipe(dshLog)
dsh.stdout.on('data', buf => {
  const s = buf.toString()
  process.stdout.write(s)
  const m = s.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)
  if (m) {
    writeFileSync(URL_FILE, m[0] + '\n')
    const tok = m[0].match(/token=([^\s&]+)/)?.[1]
    if (tok) process.env.DSBOT_TOKEN = tok
    console.log(`🔑 ds-bot URL saved → ${URL_FILE}`)
  }
})
dsh.stderr.on('data', buf => process.stderr.write(buf))

function waitForToken(timeoutMs = 60_000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (process.env.DSBOT_TOKEN) return resolve(process.env.DSBOT_TOKEN)
      if (existsSync(URL_FILE)) {
        const text = readFileSync(URL_FILE, 'utf8')
        const tok = text.match(/token=([^\s&]+)/)?.[1]
        if (tok) { process.env.DSBOT_TOKEN = tok; return resolve(tok) }
      }
      if (Date.now() - start > timeoutMs) return reject(new Error('ds-bot did not print a token in time — see ' + DSH_LOG))
      if (dsh.exitCode != null) return reject(new Error(`dsh exited early with ${dsh.exitCode}`))
      setTimeout(tick, 400)
    }
    tick()
  })
}

const muse = await (async () => {
  await waitForToken()
  console.log('✅ ds-bot ready, starting Muse server…')
  return spawn(process.execPath, [join(ROOT, 'scripts/server.js'), String(MUSE_PORT)], {
    cwd: ROOT,
    env: { ...process.env, DSBOT_URL: process.env.DSBOT_URL, DSBOT_TOKEN: process.env.DSBOT_TOKEN, ODM_HOME: HOME, DSH_HOME },
    stdio: 'inherit',
  })
})().catch(err => {
  console.error('❌', err.message)
  dsh.kill('SIGTERM')
  process.exit(1)
})

function shutdown() {
  console.log('\n👋 shutting down…')
  try { muse?.kill('SIGTERM') } catch {}
  try { dsh.kill('SIGTERM') } catch {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
dsh.on('exit', code => {
  console.error(`ds-bot exited (${code})`)
  try { muse?.kill('SIGTERM') } catch {}
  process.exit(code || 1)
})
