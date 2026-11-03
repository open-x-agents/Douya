#!/usr/bin/env node
/**
 * Boot Open Digital Mate as the primary dsh web UI (replaces stock frontend).
 * One process: dsh --profile odm on PORT (default 7777).
 * Muse lives at /api/opendigitalmate/app (client redirects / → there).
 */
import { spawn } from 'node:child_process'
import { createWriteStream, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = join(ROOT, '.odm-data')
const DSH_HOME = process.env.DSH_HOME || join(ROOT, '.dsh-odm')
const PORT = process.env.PORT || process.argv[2] || '7777'
const DSH_BIN_CANDIDATES = [
  process.env.DSH_BIN,
  join('/workspace/dsh-rc5/prefix/bin', 'dsh'),
  'dsh',
].filter(Boolean)
const DSH_LOG = '/tmp/odm-dsh.log'
const URL_FILE = join(HOME, 'dsh-web.url')

mkdirSync(HOME, { recursive: true })
mkdirSync(DSH_HOME, { recursive: true })
mkdirSync(join(DSH_HOME, 'profiles'), { recursive: true })

// Link user odm profile + shared node_modules if present (Mac layout).
const userProfile = join(process.env.HOME || '', '.dsh/profiles/odm')
const profileLink = join(DSH_HOME, 'profiles', 'odm')
const userMods = join(process.env.HOME || '', '.dsh/profiles/node_modules')
const modsLink = join(DSH_HOME, 'profiles', 'node_modules')
try {
  if (existsSync(userProfile) && !existsSync(profileLink)) {
    spawn('ln', ['-sfn', userProfile, profileLink], { stdio: 'ignore' })
  }
  if (existsSync(userMods) && !existsSync(modsLink)) {
    spawn('ln', ['-sfn', userMods, modsLink], { stdio: 'ignore' })
  }
} catch {}

try {
  const cfg = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8'))
  if (!process.env.OPENAI_API_KEY && cfg?.llm?.apiKey) process.env.OPENAI_API_KEY = cfg.llm.apiKey
  if (!process.env.COMPOSIO_API_KEY && cfg?.composioApiKey) process.env.COMPOSIO_API_KEY = cfg.composioApiKey
} catch {}
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
const pathEnv = [
  join('/workspace/dsh-rc5/prefix/bin'),
  dirname(dshBin),
  process.env.PATH || '',
].filter(Boolean).join(':')

const log = createWriteStream(DSH_LOG, { flags: 'w' })
const child = spawn(dshBin, ['--profile', 'odm', '--no-open', '--port', String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, PATH: pathEnv, DSH_HOME, ODM_MUSE_URL: process.env.ODM_MUSE_URL, DSBOT_URL: process.env.DSBOT_URL },
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
  }
})
child.stderr.on('data', buf => process.stderr.write(buf))
child.on('exit', code => process.exit(code || 0))
process.on('SIGINT', () => { child.kill('SIGTERM'); process.exit(0) })
process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0) })
