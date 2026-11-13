// Douya desktop shell: open the local Douya (豆芽) server in one window.
// Reuses a server already on the port; otherwise runs the repo's own scripts/start-dsh.mjs.
import { app, BrowserWindow, dialog, nativeTheme, session, shell } from 'electron'
import { spawn, execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMMON_BIN_DIRS, DEFAULT_PORT, START_SCRIPT, decideStartup, isExternalOpenable, isInternalUrl,
  isPortOpen, isRepoRoot, locateDsh, mergePath, messages, readLoginUrl, resolveRepoRoot,
  sanitizeBounds, tail, tokenWorks, waitForLogin,
} from './server.js'
import {
  bundledCommand, decideOpenViking, ensureOpenVikingConfig,
  probeOpenVikingHealth, resolveBundledModel, resolveBundledRuntime, sanitizeSpawnEnv, waitForHealth,
} from './openviking.js'

const WARM_BG = '#f4f2ee' // dsh-muse-ui --bg
const PORT = Number(process.env.ODM_PORT || DEFAULT_PORT)
const DEV_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write', 'notifications', 'fullscreen'])

let win = null
let child = null
let childDead = false
let ovChild = null
let ovDead = false
let ovStartedByUs = false
let ovNote = null // { kind: 'models' | 'failed' | 'conflict' | 'skip', detail? }
let quitting = false

const t = () => messages(app.getLocale())
const settingsFile = () => join(app.getPath('userData'), 'settings.json')
const logFile = () => join(app.getPath('logs'), 'server.log')
const ovLogFile = () => join(app.getPath('logs'), 'openviking.log')
const homeDir = () => process.env.HOME || process.env.USERPROFILE || ''

function loadSettings() {
  try { return JSON.parse(readFileSync(settingsFile(), 'utf8')) } catch { return {} }
}
function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch }
  mkdirSync(dirname(settingsFile()), { recursive: true })
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2))
}

// Finder/Explorer launches get a bare PATH; borrow the login shell's so `node`, `npm`, `dsh` resolve.
function loginShellPath() {
  if (process.platform === 'win32') return ''
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__ODM__%s__ODM__" "$PATH"'],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] })
    return (out.match(/__ODM__(.*)__ODM__/) || [])[1] || ''
  } catch { return '' }
}

function findOnPath(name, pathEnv) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of pathEnv.split(process.platform === 'win32' ? ';' : ':')) {
    for (const ext of exts) if (dir && existsSync(join(dir, name + ext))) return join(dir, name + ext)
  }
  return null
}

async function pickRepoRoot() {
  const settings = loadSettings()
  const found = resolveRepoRoot({ saved: settings.repoRoot, devRoot: app.isPackaged ? null : DEV_ROOT })
  if (found) return found
  await dialog.showMessageBox({ type: 'info', message: t().noRepo })
  const res = await dialog.showOpenDialog({ title: t().pickRepo, properties: ['openDirectory'] })
  const dir = res.filePaths?.[0]
  if (!dir || !isRepoRoot(dir)) return null
  saveSettings({ repoRoot: dir })
  return dir
}

let serverPathCache = null
const serverPath = () => (serverPathCache ??= mergePath(process.env.PATH, [loginShellPath(), ...COMMON_BIN_DIRS]))

// Without dsh, start-dsh dies before it is ready; ask for it up front (like the repo folder).
async function pickDshBin() {
  const settings = loadSettings()
  const found = locateDsh({ saved: settings.dshBin, onPath: (name) => findOnPath(name, serverPath()) })
  if (found) return found
  await dialog.showMessageBox({ type: 'info', message: t().noDsh })
  const res = await dialog.showOpenDialog({ title: t().pickDsh, properties: ['openFile'] })
  const file = res.filePaths?.[0]
  if (!file || !existsSync(file)) return null
  saveSettings({ dshBin: file })
  return file
}

function startServer(root, dshBin) {
  const PATH = serverPath()
  const env = sanitizeSpawnEnv({ ...process.env, PORT: String(PORT) }, { path: PATH })
  if (dshBin) env.DSH_BIN = dshBin
  // Prefer the user's Node (same one `npm start` uses); fall back to Electron's bundled Node.
  let nodeExe = findOnPath('node', PATH)
  if (!nodeExe) { nodeExe = process.execPath; env.ELECTRON_RUN_AS_NODE = '1' }

  mkdirSync(dirname(logFile()), { recursive: true })
  const log = createWriteStream(logFile(), { flags: 'w' })
  childDead = false
  child = spawn(nodeExe, [join(root, START_SCRIPT), String(PORT)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  child.on('error', (err) => { log.write(`\n[desktop] spawn failed: ${err.message}\n`); childDead = true })
  child.on('exit', () => {
    childDead = true
    child = null
    if (!quitting && win) showError(t().exited)
  })
}

async function showError(reason) {
  let detail = `${t().log}: ${logFile()}`
  try { detail = `${tail(readFileSync(logFile(), 'utf8'))}\n\n${detail}` } catch {}
  const { response } = await dialog.showMessageBox({
    type: 'error', title: t().title, message: reason, detail, buttons: [t().retry, t().quit], defaultId: 0, cancelId: 1,
  })
  if (response === 0) { app.relaunch(); }
  app.quit()
}

function createWindow(url) {
  const settings = loadSettings()
  const bounds = sanitizeBounds(settings.bounds)
  const origin = new URL(url).origin
  win = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    title: 'Douya · 豆芽',
    backgroundColor: WARM_BG,
    show: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  })
  if (bounds.maximized) win.maximize()

  const remember = () => {
    if (!win || win.isMinimized()) return
    saveSettings({ bounds: { ...(win.isMaximized() ? settings.bounds : win.getBounds()), maximized: win.isMaximized() } })
  }
  win.on('close', remember)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => { win = null })

  // Only the Douya origin may ask for mic / notifications; everything else is denied.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(isInternalUrl(details.requestingUrl || wc.getURL(), origin) && ALLOWED_PERMISSIONS.has(permission))
  })

  const openOutside = (target) => { if (isExternalOpenable(target)) shell.openExternal(target) }
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isInternalUrl(target, origin)) return { action: 'allow' }
    openOutside(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, target) => {
    if (!isInternalUrl(target, origin)) { event.preventDefault(); openOutside(target) }
  })

  win.loadURL(url)
}


function bundledOvRoot() {
  if (app.isPackaged) return join(process.resourcesPath, 'openviking')
  return join(DEV_ROOT, 'desktop', 'resources', 'openviking')
}

function stopChild(c, { onDone, timeoutMs = 4000 } = {}) {
  if (!c) { onDone?.(); return }
  let finished = false
  const done = () => { if (finished) return; finished = true; onDone?.() }
  const force = setTimeout(() => { try { c.kill('SIGKILL') } catch {} }, timeoutMs)
  const stuck = setTimeout(done, timeoutMs + 2000)
  c.once('exit', () => { clearTimeout(force); clearTimeout(stuck); done() })
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true })
  else c.kill('SIGTERM')
}

async function ensureMemory() {
  const portOpen = await isPortOpen(1933)
  const healthy = portOpen ? await probeOpenVikingHealth() : false
  const ovRoot = bundledOvRoot()
  const runtime = resolveBundledRuntime(ovRoot)
  const plan = decideOpenViking({ portOpen, healthy, bundled: Boolean(runtime) })
  if (plan.action === 'reuse') return
  if (plan.action === 'conflict') { ovNote = { kind: 'conflict' }; return }
  if (plan.action === 'skip') { ovNote = { kind: 'skip' }; return }

  const cfg = ensureOpenVikingConfig({
    homeDir: homeDir(),
    userDataDir: app.getPath('userData'),
    bundledModelPath: resolveBundledModel(ovRoot),
  })
  const cmd = bundledCommand(runtime, { confPath: cfg.confPath })
  mkdirSync(dirname(ovLogFile()), { recursive: true })
  const log = createWriteStream(ovLogFile(), { flags: 'w' })
  const env = sanitizeSpawnEnv({ ...process.env, ...cmd.env })
  ovDead = false
  ovStartedByUs = true
  ovChild = spawn(cmd.exe, cmd.args, { cwd: cmd.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  ovChild.stdout.pipe(log)
  ovChild.stderr.pipe(log)
  ovChild.on('error', (err) => { log.write(`\n[desktop] openviking spawn failed: ${err.message}\n`); ovDead = true })
  ovChild.on('exit', () => { ovDead = true; ovChild = null })
  try {
    await waitForHealth({ isDead: () => ovDead })
    if (!cfg.models.ok) ovNote = { kind: 'models' }
  } catch (err) {
    ovNote = { kind: 'failed', detail: err.message }
  }
}

function memoryNoteText(kind) {
  const m = t()
  if (kind === 'models') return m.ovModels
  if (kind === 'failed') return m.ovFailed(ovLogFile())
  if (kind === 'conflict') return m.ovConflict
  if (kind === 'skip') return m.ovSkip
  return ''
}

async function showMemoryNote() {
  if (!ovNote) return
  const message = memoryNoteText(ovNote.kind)
  if (!message) return
  await dialog.showMessageBox({ type: 'info', title: t().ovTitle, message, buttons: [t().ok], defaultId: 0 })
}

async function boot() {
  nativeTheme.themeSource = 'light' // the Muse palette is light/warm; keep native chrome light too
  const root = await pickRepoRoot()
  if (!root) return app.quit()

  await ensureMemory()

  const portOpen = await isPortOpen(PORT)
  const login = readLoginUrl(root)
  const tokenOk = portOpen && login ? await tokenWorks(login.url) : false
  const plan = decideStartup({ portOpen, login, tokenOk, port: PORT })
  if (plan.action === 'reuse') {
    createWindow(plan.url)
    showMemoryNote()
    return
  }
  if (plan.action === 'conflict') return showError(t().conflict(PORT))

  const dshBin = await pickDshBin()
  if (!dshBin) return app.quit()
  const since = Date.now()
  startServer(root, dshBin)
  try {
    const ready = await waitForLogin({ root, port: PORT, since, isDead: () => childDead })
    createWindow(ready.url)
    showMemoryNote()
  } catch (err) {
    showError(err.code === 'timeout' ? t().timeout : t().exited)
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  app.whenReady().then(boot)
  app.on('window-all-closed', () => app.quit())
  // Stop only the server we started; a reused one belongs to whoever ran it.
  app.on('before-quit', (event) => {
    quitting = true
    const liveDsh = child && !childDead
    const liveOv = ovStartedByUs && ovChild && !ovDead
    if (!liveDsh && !liveOv) return
    event.preventDefault()
    let left = (liveDsh ? 1 : 0) + (liveOv ? 1 : 0)
    const done = () => { if (--left <= 0) app.exit(0) }
    if (liveDsh) stopChild(child, { onDone: done })
    // Only the OpenViking process we started; a reused one on :1933 stays up.
    if (liveOv) stopChild(ovChild, { onDone: done })
  })
}
