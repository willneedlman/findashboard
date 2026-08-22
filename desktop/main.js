'use strict'
const { app, BrowserWindow, Menu, shell, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { start } = require('./server')

// Point the app at a different backend with ALPHATAPE_API=http://127.0.0.1:8000
const UPSTREAM = process.env.ALPHATAPE_API || 'https://finance-terminal.fly.dev'
const DIST = app.isPackaged
  ? path.join(process.resourcesPath, 'dist')
  : path.join(__dirname, '..', 'frontend', 'dist')

const STATE = path.join(app.getPath('userData'), 'window-state.json')
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return {} } }
const writeState = win => {
  if (!win || win.isDestroyed() || win.isMinimized()) return
  const b = win.getBounds()
  try { fs.writeFileSync(STATE, JSON.stringify({ ...b, maximized: win.isMaximized() })) } catch { /* not fatal */ }
}

let server = null
let mainWindow = null

function createWindow(port) {
  const s = readState()
  mainWindow = new BrowserWindow({
    width: s.width || 1600, height: s.height || 1000,
    x: s.x, y: s.y,
    minWidth: 900, minHeight: 620,
    backgroundColor: '#101c2e',           // paints before first frame, no white flash
    titleBarStyle: 'hiddenInset',          // traffic lights over the app's own chrome
    trafficLightPosition: { x: 14, y: 13 },
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  if (s.maximized) mainWindow.maximize()
  mainWindow.loadURL(`http://127.0.0.1:${port}/app`)
  mainWindow.once('ready-to-show', () => mainWindow.show())
  // The hiddenInset traffic lights float over the app's own chrome, and the
  // sidebar starts at y=0, so they landed on the ALPHATAPE wordmark. Inset the
  // sidebar from here rather than in the web build: the browser has no traffic
  // lights and should not carry the gap.
  const CHROME_CSS = `
    .ft-app-nav { padding-top: 26px !important; position: relative; }
    /* Dragging the strip moves the window, the way a titlebar would. */
    .ft-app-nav::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 26px;
      -webkit-app-region: drag; pointer-events: auto;
    }
    /* Buttons anywhere in the shell stay clickable inside a drag region. */
    .ft-app-nav button, .ft-app-nav a { -webkit-app-region: no-drag; }
  `
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS(CHROME_CSS)
    console.log('[alphatape] window loaded')
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) =>
    console.error('[alphatape] load failed', code, desc, url))
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('[renderer]', message)
  })

  // Anything not on the local origin belongs in the user's browser, not here.
  const external = url => { if (!url.startsWith(`http://127.0.0.1:${port}`)) { shell.openExternal(url); return true } return false }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => (external(url) ? { action: 'deny' } : { action: 'allow' }))
  mainWindow.webContents.on('will-navigate', (e, url) => { if (external(url)) e.preventDefault() })

  for (const ev of ['resize', 'move', 'close']) mainWindow.on(ev, () => writeState(mainWindow))
  mainWindow.on('closed', () => { mainWindow = null })
}

const send = channel => () => mainWindow?.webContents.send(channel)
const go = route => () => mainWindow?.webContents.executeJavaScript(
  `window.history.pushState({}, '', ${JSON.stringify(route)});` +
  `window.dispatchEvent(new PopStateEvent('popstate'));`,
)

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    { label: 'File', submenu: [
      { label: 'Search Tools and Tickers', accelerator: 'CmdOrCtrl+K', click: () =>
        mainWindow?.webContents.executeJavaScript("window.dispatchEvent(new Event('cmdk:open'))") },
      { type: 'separator' },
      { label: 'Reload Data', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
      { type: 'separator' }, { role: 'close' },
    ] },
    { role: 'editMenu' },
    { label: 'Go', submenu: [
      { label: 'Home', accelerator: 'CmdOrCtrl+1', click: go('/app') },
      { label: 'My Dashboard', accelerator: 'CmdOrCtrl+2', click: go('/dashboard') },
      { label: 'Portfolio Manager', accelerator: 'CmdOrCtrl+3', click: go('/portfolio-manager') },
      { label: 'Report Creator', accelerator: 'CmdOrCtrl+4', click: go('/report-creator') },
      { type: 'separator' },
      { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => mainWindow?.webContents.navigationHistory.goBack() },
      { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => mainWindow?.webContents.navigationHistory.goForward() },
    ] },
    { label: 'View', submenu: [
      { role: 'togglefullscreen' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'toggleDevTools' },
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'Backend', click: () => dialog.showMessageBox(mainWindow, {
        type: 'info', message: 'Data source', detail: UPSTREAM, buttons: ['OK'] }) },
    ] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    dialog.showErrorBox('Build missing', `No frontend build at:\n${DIST}\n\nRun "npm run build" in frontend/ first.`)
    return app.quit()
  }
  server = await start({ root: DIST, upstream: UPSTREAM })
  buildMenu()
  console.log(`[alphatape] serving ${DIST} on :${server.port} -> ${UPSTREAM}`)
  createWindow(server.port)
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(server.port) })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { writeState(mainWindow); server?.close() })
