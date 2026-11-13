// Douya desktop shell: open the local Douya (豆芽) server in one window.
// Reuses a server already on the port; otherwise runs the repo's own scripts/start-dsh.mjs.
import { app, BrowserWindow, dialog, nativeTheme, session, shell } from 'electron'
import { spawn, execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMMON_BIN_DIRS, DEFAULT_PORT, START_SCRIPT, bundledDshEntry, bundledNodeExe, bundledRuntimeRoot,
  decideStartup, isExternalOpenable, isInternalUrl,
  isPortOpen, isRepoRoot, locateDsh, mergePath, messages, readLoginUrl,
  resolveNodeExe, resolveOdmDataDir, resolvePackagedDshHome, resolveRepoRoot,
  sanitizeBounds, sanitizeSpawnEnv, tail, tokenWorks, waitForLogin,
} from './server.js'

const WARM_BG = '#f4f2ee' // dsh-muse-ui --bg
const PORT = Number(process.env.ODM_PORT || DEFAULT_PORT)
const DEV_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write', 'notifications', 'fullscreen'])

let win = null
let child = null
let childDead = false
let quitting = false

const t = () => messages(app.getLocale())
const settingsFile = () => join(app.getPath('userData'), 'settings.json')
const logFile = () => join(app.getPath('logs'), 'server.log')

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

function packagedRuntime() {
  return app.isPackaged ? bundledRuntimeRoot(process.resourcesPath) : null
}

async function pickRepoRoot() {
  const settings = loadSettings()
  const found = resolveRepoRoot({
    saved: settings.repoRoot,
    bundledRoot: packagedRuntime(),
    devRoot: app.isPackaged ? null : DEV_ROOT,
  })
  if (found) return found
  // Last-resort fallback: a checkout on disk. Packaged installs with app-runtime never reach this.
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
async function pickDshBin(root) {
  const settings = loadSettings()
  const found = locateDsh({
    saved: settings.dshBin,
    bundled: bundledDshEntry(root),
    onPath: (name) => findOnPath(name, serverPath()),
  })
  if (found) return found
  // Last-resort fallback. A packaged install with bundled dsh never reaches this.
  await dialog.showMessageBox({ type: 'info', message: t().noDsh })
  const res = await dialog.showOpenDialog({ title: t().pickDsh, properties: ['openFile'] })
  const file = res.filePaths?.[0]
  if (!file || !existsSync(file)) return null
  saveSettings({ dshBin: file })
  return file
}

function dataPaths(root) {
  const userData = app.getPath('userData')
  return {
    dataDir: resolveOdmDataDir({ packaged: app.isPackaged, userData, root }),
    dshHome: resolvePackagedDshHome({ packaged: app.isPackaged, userData, root }),
  }
}

function startServer(root, dshBin) {
  const PATH = serverPath()
  const { dataDir, dshHome } = dataPaths(root)
  const env = sanitizeSpawnEnv({ ...process.env, PORT: String(PORT) }, { path: PATH })
  if (dshBin) env.DSH_BIN = dshBin
  env.ODM_DATA_DIR = dataDir
  env.DSH_HOME = dshHome
  if (app.isPackaged) env.ODM_PACKAGED = '1'
  // Packaged: the vanilla Node we ship (dsh rejects Electron's Node fingerprint).
  // Dev: prefer the same `node` `npm start` uses, else Electron.
  const node = resolveNodeExe({
    packaged: app.isPackaged,
    execPath: process.execPath,
    bundledNode: bundledNodeExe(root),
    onPath: (name) => findOnPath(name, PATH),
  })
  const nodeExe = node.exe
  if (node.electronAsNode) env.ELECTRON_RUN_AS_NODE = '1'

  mkdirSync(dirname(logFile()), { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
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

async function boot() {
  nativeTheme.themeSource = 'light' // the Muse palette is light/warm; keep native chrome light too
  const root = await pickRepoRoot()
  if (!root) return app.quit()
  const { dataDir } = dataPaths(root)


  const portOpen = await isPortOpen(PORT)
  const login = readLoginUrl(root, { dataDir })
  const tokenOk = portOpen && login ? await tokenWorks(login.url) : false
  const plan = decideStartup({ portOpen, login, tokenOk, port: PORT })
  if (plan.action === 'reuse') {
    createWindow(plan.url)
    return
  }
  if (plan.action === 'conflict') return showError(t().conflict(PORT))

  const dshBin = await pickDshBin(root)
  if (!dshBin) return app.quit()
  const since = Date.now()
  startServer(root, dshBin)
  try {
    const ready = await waitForLogin({ root, dataDir, port: PORT, since, isDead: () => childDead })
    createWindow(ready.url)
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
    if (!liveDsh) return
    event.preventDefault()
    stopChild(child, { onDone: () => app.exit(0) })
  })
}
