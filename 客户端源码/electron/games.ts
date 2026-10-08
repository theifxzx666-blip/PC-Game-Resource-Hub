import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { shell } from 'electron'
import { nowText, uid } from './util.js'
import { resolveMainExe } from './gameArt.js'
import { resolveSteamExe, resolveSteamRoot } from './steamLocate.js'
import type { Game } from './types.js'

/** 极简 Valve KeyValues 解析：只处理 libraryfolders.vdf 与 appmanifest_*.acf 的实际结构。 */
function parseKeyValues(text: string): Record<string, unknown> {
  const tokens: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|(\{)|(\})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) tokens.push(m[1].replace(/\\(.)/g, '$1'))
    else if (m[2] !== undefined) tokens.push('{')
    else tokens.push('}')
  }
  let i = 0
  const parseObject = (): Record<string, unknown> => {
    const obj: Record<string, unknown> = {}
    while (i < tokens.length) {
      const key = tokens[i]
      if (key === '}') {
        i += 1
        break
      }
      i += 1
      if (tokens[i] === '{') {
        i += 1
        obj[key] = parseObject()
      } else {
        obj[key] = tokens[i] ?? ''
        i += 1
      }
    }
    return obj
  }
  if (tokens.length === 0) return {}
  if (tokens[1] === '{') {
    i = 2
    return { [tokens[0]]: parseObject() }
  }
  i = 0
  return parseObject()
}

function collectLibraryPaths(steamRoot: string): string[] {
  const paths = new Set<string>([steamRoot])
  const candidates = [
    path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'),
    path.join(steamRoot, 'config', 'libraryfolders.vdf'),
  ]
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    try {
      const parsed = parseKeyValues(fs.readFileSync(file, 'utf8'))
      const root = parsed['libraryfolders'] as Record<string, unknown> | undefined
      if (!root) continue
      for (const value of Object.values(root)) {
        if (value && typeof value === 'object') {
          const p = (value as Record<string, unknown>)['path']
          if (typeof p === 'string' && p) paths.add(p)
        }
      }
    } catch {
      /* 单个 vdf 解析失败不影响其他库 */
    }
  }
  return [...paths]
}

export interface SteamScanResult {
  steamRoot: string
  detected: Game[]
  skipped: string[]
}

export async function scanSteam(): Promise<SteamScanResult> {
  const steamRoot = await resolveSteamRoot()
  if (!steamRoot) throw new Error('未检测到本机 Steam 安装路径。请在注册表 SteamPath 或默认目录安装 Steam，或手动添加游戏目录。')
  const detected: Game[] = []
  const skipped: string[] = []
  for (const library of collectLibraryPaths(steamRoot)) {
    const steamapps = path.join(library, 'steamapps')
    if (!fs.existsSync(steamapps)) continue
    for (const file of fs.readdirSync(steamapps)) {
      if (!/^appmanifest_\d+\.acf$/i.test(file)) continue
      try {
        const parsed = parseKeyValues(fs.readFileSync(path.join(steamapps, file), 'utf8'))
        const state = parsed['AppState'] as Record<string, unknown> | undefined
        if (!state) continue
        const appid = String(state['appid'] ?? '').trim()
        const name = String(state['name'] ?? '').trim()
        const installdir = String(state['installdir'] ?? '').trim()
        if (!appid || !name || !installdir) continue
        if (appid === '228980') continue
        const dir = path.join(steamapps, 'common', installdir)
        detected.push({
          id: `steam-${appid}`,
          name,
          aliases: [],
          dir: fs.existsSync(dir) ? dir : '',
          savePaths: [],
          source: 'steam',
          appid,
          steamLibrary: library,
          version: '',
          createdAt: nowText(),
          steamAppId: '',
          storeUrl: '',
          storeCoverUrl: '',
          iconSource: '',
          iconUpdatedAt: '',
        })
      } catch {
        skipped.push(file)
      }
    }
  }
  return { steamRoot, detected, skipped }
}

/**
 * 手动添加游戏。
 * 名称做了三级兜底（显式名称 → 目录名 → 「未命名游戏」），
 * 避免渲染层因 `window.prompt` 不可用而传回 undefined 时抛 `undefined.trim()`。
 */
export function buildManualGame(name: string, dir: string): Game {
  const explicit = typeof name === 'string' ? name.trim() : ''
  const fromDir = typeof dir === 'string' ? path.basename(dir.trim().replace(/[\\/]+$/, '')) : ''
  return {
    id: uid('game'),
    name: explicit || fromDir || '未命名游戏',
    aliases: [],
    dir: typeof dir === 'string' ? dir.trim() : '',
    savePaths: [],
    source: 'manual',
    appid: '',
    steamLibrary: '',
    version: '',
    createdAt: nowText(),
    steamAppId: '',
    storeUrl: '',
    storeCoverUrl: '',
    iconSource: '',
    iconUpdatedAt: '',
  }
}

/** 用 detached 方式拉起外部程序：父进程退出后子进程继续存活，且不弹出控制台窗口。 */
function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

/**
 * 启动游戏。
 *
 * **不再依赖 `steam://` 协议注册**：本机实测 `shell.openExternal('steam://…')`
 * 会被系统判为「需要新应用以打开此 Steam 链接」，因为协议关联不一定落在当前用户/提权上下文。
 *
 * 分级策略：
 * 1. Steam 游戏：用注册表解析到的 `steam.exe -applaunch <appid>`（最正规，能带上 Steam 覆盖层与云存档）。
 * 2. 有安装目录：在目录里挑主程序 exe 直接启动（离线可用的兜底）。
 * 3. 以上都不可用且是 Steam 游戏：最后才回退 `steam://rungameid/<appid>`。
 */
export async function launchGame(game: Game): Promise<string> {
  if (game.appid) {
    const steamExe = await resolveSteamExe()
    if (steamExe) {
      spawnDetached(steamExe, ['-applaunch', game.appid])
      return `已通过 Steam 启动（appid ${game.appid}）`
    }
  }

  const exe = resolveMainExe(game.dir, game.name)
  if (exe) {
    const result = await shell.openPath(exe)
    if (result) throw new Error(`启动失败：${result}`)
    return `已启动 ${path.basename(exe)}`
  }

  if (game.appid) {
    await shell.openExternal(`steam://rungameid/${game.appid}`)
    return `已请求 Steam 启动（appid ${game.appid}）`
  }

  if (!game.dir) throw new Error('该游戏未关联安装目录，也没有 Steam appid，无法启动。')
  throw new Error('未在游戏目录下找到可执行文件，请手动启动游戏。')
}
