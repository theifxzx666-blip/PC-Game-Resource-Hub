import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { store } from './store.js'
import { registerIpc } from './ipc.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 固定为一个 ASCII 数据目录，避免中文 productName 带来的编码问题；可在设置中查看与打开。
app.setName('PCGameResourceHub')
app.setPath('userData', path.join(app.getPath('appData'), 'PCGameResourceHub'))

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#f7f8fa',
    title: 'PC 游戏资源服务工具',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    window.loadURL(devServerUrl)
  } else {
    window.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  store.init()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
