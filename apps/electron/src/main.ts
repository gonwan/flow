import { spawn, ChildProcess } from 'child_process'
import fs from 'fs'
import http from 'http'
import path from 'path'

import {
  app,
  dialog,
  globalShortcut,
  nativeImage,
  BrowserWindow,
  Menu,
} from 'electron'

let serverProc: ChildProcess | null = null
let mainWindow: BrowserWindow | null = null
let isQuitting = false

const PORT = process.env.PORT || '7127'
const SERVER_START_TIMEOUT = 20_000 // ms
const SERVER_POLL_INTERVAL = 400 // ms

function devStandalonePath() {
  return path.resolve(
    process.cwd(),
    'apps',
    'reader',
    '.next',
    'standalone',
    'apps',
    'reader',
    'server.js',
  )
}

function packagedStandalonePath() {
  return path.join(
    process.resourcesPath,
    'standalone',
    'apps',
    'reader',
    'server.js',
  )
}

function getStandaloneServerPath() {
  return app.isPackaged ? packagedStandalonePath() : devStandalonePath()
}

function createLogStreams() {
  const logDir = app.getPath('userData')
  try {
    fs.mkdirSync(logDir, { recursive: true })
  } catch {
    /* ignore */
  }
  const logPath = path.join(logDir, 'server.log')
  const out = fs.createWriteStream(logPath, { flags: 'a' })
  const err = fs.createWriteStream(logPath, { flags: 'a' })
  return { out, err, path: logPath }
}

function tailFileLines(filePath: string, lines = 50) {
  try {
    const data = fs.readFileSync(filePath, 'utf8')
    const parts = data.trim().split(/\r?\n/)
    return parts.slice(-lines).join('\n')
  } catch {
    return ''
  }
}

function startNextStandalone() {
  const serverPath = getStandaloneServerPath()
  const serverDir = path.dirname(serverPath)

  if (!fs.existsSync(serverPath)) {
    const msg = `Standalone server not found at ${serverPath}\nMake sure you built the reader standalone (pnpm --filter @flow/reader run build:standalone) before packaging.`
    console.error(msg)
    dialog.showErrorBox('Missing backend', msg)
    app.quit()
    return
  }

  const logs = createLogStreams()
  logs.out.write(`\n---- starting server: ${new Date().toISOString()} ----\n`)

  const env = { ...process.env, PORT, ELECTRON_RUN_AS_NODE: '1' }

  serverProc = spawn(process.execPath, [serverPath], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: serverDir,
  })

  serverProc.stdout?.on('data', (chunk) => {
    const s = chunk.toString()
    logs.out.write(`[stdout ${new Date().toISOString()}] ${s}`)
  })
  serverProc.stderr?.on('data', (chunk) => {
    const s = chunk.toString()
    logs.err.write(`[stderr ${new Date().toISOString()}] ${s}`)
  })

  serverProc.on('error', (err) => {
    logs.err.write(`[error ${new Date().toISOString()}] ${String(err)}\n`)
    console.error('Failed to start Next standalone server:', err)
  })

  serverProc.on('close', (code, signal) => {
    logs.out.write(
      `---- server exited: code=${code} signal=${signal} at ${new Date().toISOString()} ----\n`,
    )
    console.log('Next standalone server exited with', code, signal)
    const last = tailFileLines(logs.path, 200)
    if (!isQuitting && code !== 0) {
      dialog.showErrorBox(
        'Backend server exited',
        `The embedded server exited with code ${
          code ?? 'unknown'
        }. See logs at:\n\n${logs.path}\n\nLast log lines:\n\n${last}`,
      )
      app.quit()
    }
  })
}

function waitForServer(
  port: number,
  timeoutMs = SERVER_START_TIMEOUT,
): Promise<void> {
  const start = Date.now()
  return new Promise<void>((resolve, reject) => {
    const tryReq = () => {
      const req = http.request(
        { method: 'GET', hostname: '127.0.0.1', port, path: '/' },
        (res) => {
          res.resume()
          resolve()
        },
      )
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Timeout waiting for backend server'))
        } else {
          setTimeout(tryReq, SERVER_POLL_INTERVAL)
        }
      })
      req.setTimeout(2000, () => {
        req.destroy()
      })
      req.end()
    }
    tryReq()
  })
}

function getIconPath() {
  if (app.isPackaged)
    return path.join(process.resourcesPath, 'icons', '512.png')
  return path.join(
    process.cwd(),
    'apps',
    'reader',
    'public',
    'icons',
    '512.png',
  )
}

function createWindow() {
  const iconPath = getIconPath()
  const icon = nativeImage.createFromPath(iconPath)

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  /* simulate local shortcut */
  mainWindow.on('focus', () => {
    globalShortcut.register('Shift+CommandOrControl+I', () => {
      mainWindow?.webContents.openDevTools()
    })
  })
  mainWindow.on('blur', () => {
    globalShortcut.unregister('Shift+CommandOrControl+I')
  })

  const startUrl = process.env.ELECTRON_START_URL || `http://127.0.0.1:${PORT}`

  // Capture renderer console messages and attach handlers to quickly surface problems.
  mainWindow.webContents.on(
    'console-message',
    (_ev, level, message, line, sourceId) => {
      const logs = createLogStreams()
      const entry = `[renderer console ${new Date().toISOString()}] level=${level} ${message} (${sourceId}:${line})\n`
      logs.out.write(entry)
      console[level === 2 ? 'error' : 'log']('Renderer:', entry)
    },
  )

  mainWindow.webContents.on(
    'did-fail-load',
    (_ev, errorCode, errorDescription, validatedURL) => {
      const logs = createLogStreams()
      const last = tailFileLines(logs.path, 300)
      const msg = `Failed to load ${validatedURL}: (${errorCode}) ${errorDescription}\n\nServer log tail:\n${last}`
      console.error(msg)
      // open devtools to inspect UI
      try {
        mainWindow?.webContents.openDevTools({ mode: 'detach' })
      } catch {}
      dialog.showErrorBox('Load failed', msg)
    },
  )

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Renderer did-finish-load')
  })

  mainWindow.loadURL(startUrl).catch((err) => {
    console.error('Failed to load URL', startUrl, err)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

Menu.setApplicationMenu(null)

/* single-instance lock */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('ready', async () => {
  try {
    startNextStandalone()
    await waitForServer(Number(PORT))
    createWindow()
  } catch (errUnknown) {
    console.error('Failed to start backend server:', errUnknown)
    const message =
      errUnknown instanceof Error ? errUnknown.message : String(errUnknown)
    const logsPath = path.join(app.getPath('userData'), 'server.log')
    const tail = fs.existsSync(logsPath)
      ? tailFileLines(logsPath, 200)
      : '(no log file)'
    dialog.showErrorBox(
      'Startup failed',
      `The embedded backend failed to start: ${message}\n\nLogs: ${logsPath}\n\nLast lines:\n\n${tail}`,
    )
    app.quit()
  }
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => {
  isQuitting = true
})
app.on('quit', () => {
  if (serverProc) {
    serverProc.kill()
    serverProc = null
  }
})
