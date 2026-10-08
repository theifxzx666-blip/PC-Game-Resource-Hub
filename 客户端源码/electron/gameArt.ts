/**
 * 游戏图标与封面。
 *
 * 目标：让游戏库里每个游戏都有可辨认的图标，而不是只有一行文字。
 *
 * 取图优先级（离线优先，逐级降级，全部失败则返回空串由界面画首字母占位）：
 * 1. **Steam 本地库封面缓存**：`<Steam>/appcache/librarycache/<appid>/library_600x900[_schinese].jpg` 等。
 *    实测本机该目录存在（144 个 appid 子目录），无需联网、质量最高。
 * 2. **安装目录主程序图标**：用 `app.getFileIcon()` 提取 exe 图标（分辨率较低，但任何游戏都有）。
 * 3. **Steam CDN 封面**：`cdn.cloudflare.steamstatic.com/steam/apps/<appid>/library_600x900.jpg`
 *    → `header.jpg` → 商店搜索返回的 `tiny_image`。
 *
 * 结果统一居中裁成方形、缩放到 `ICON_PX`，写成 PNG 落在 `<数据目录>/icons/<gameId>.png`，
 * 之后每次读取都直接命中缓存（`force` 可强制重算）。
 *
 * 全部为只读外部来源 + 只写应用自身数据目录，不触碰用户文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { app, nativeImage } from 'electron'
import { store } from './store.js'
import { ensureDir } from './util.js'
import { resolveSteamRoot } from './steamLocate.js'
import { downloadImage, steamCoverUrls, steamLocalCoverPaths } from './steamStore.js'
import type { Game } from './types.js'

/** 缓存图标边长（像素），足够列表与大卡片清晰显示，又不至于让 dataURL 过大。 */
const ICON_PX = 160

/** 前缀命中的安装器 / 运行库类 exe，不是游戏主程序。 */
const NOISE_EXE_PREFIX =
  /^(unins|setup|install|vcredist|vc_redist|dxsetup|directx|dotnet|oalinst|physx|update|updater|helper|service|launcher_helper|easyanticheat|battleye|be_service|steamerrorreporter)/i

/**
 * 名字里任意位置命中即排除的可疑可执行文件。
 * 实测踩坑：`BALLxPIT` 目录里 `UnityCrashHandler64.exe`（1.6 MB）比真正的主程序
 * `Balls.exe`（0.9 MB）更大，只按体积挑就会选中崩溃处理器，因此必须按名字排除。
 */
const NOISE_EXE_ANY = /(crashhandler|crashreport|createdump|errorreport|reporter|diagnostic|uninstall)/i

function isNoiseExe(name: string): boolean {
  return NOISE_EXE_PREFIX.test(name) || NOISE_EXE_ANY.test(name)
}

/** 无需下钻的附属目录。 */
const SKIP_DIR = /^(redist|redistributable|directx|vcredist|_commonredist|support|docs?|manual|sdk|assets|data|thirdparty)$/i

const ICON_SOURCE_LABEL: Record<string, string> = {
  'steam-cover': 'Steam 本地封面',
  'steam-cdn': 'Steam 官方封面',
  exe: '主程序图标',
  cache: '本地缓存',
}

export function iconSourceLabel(source: string): string {
  return ICON_SOURCE_LABEL[source] ?? source
}

/** 图标的落盘路径。gameId 只含字母数字与短横线，仍做一次净化以防手改数据越界。 */
export function iconFile(gameId: string): string {
  return path.join(store.dirs.icons, `${gameId.replace(/[^A-Za-z0-9._-]/g, '_')}.png`)
}

function toDataUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString('base64')}`
}

/** 读取已缓存的图标 dataURL；无缓存返回空串。 */
export function readIconDataUrl(gameId: string): string {
  try {
    const file = iconFile(gameId)
    if (!fs.existsSync(file)) return ''
    return toDataUrl(fs.readFileSync(file))
  } catch {
    return ''
  }
}

/** 居中裁成方形并缩放到 ICON_PX，输出 PNG。解码失败返回 null。 */
function toSquarePng(buffer: Buffer, target = ICON_PX): Buffer | null {
  try {
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) return null
    const { width, height } = image.getSize()
    if (width <= 0 || height <= 0) return null
    const side = Math.min(width, height)
    const square =
      side < Math.max(width, height)
        ? image.crop({
            x: Math.floor((width - side) / 2),
            y: Math.floor((height - side) / 2),
            width: side,
            height: side,
          })
        : image
    // 只缩小不放大：放大会虚，且白白增大 dataURL。
    const scaled = side > target ? square.resize({ width: target, height: target, quality: 'good' }) : square
    return scaled.toPNG()
  } catch {
    return null
  }
}

async function exeIconPng(exe: string): Promise<Buffer | null> {
  try {
    const image = await app.getFileIcon(exe, { size: 'large' })
    if (image.isEmpty()) return null
    return toSquarePng(image.toPNG())
  } catch {
    return null
  }
}

/**
 * 在安装目录里挑最可能的「主程序」exe。
 *
 * 打分规则（分数高者胜），已在 4 个真实游戏目录上校准：
 * - 文件名与游戏名 / 目录名完全一致：+6000（例如 `Stardew Valley\Stardew Valley.exe`）。
 * - 互相包含：+2000。
 * - 与游戏名 / 目录名共享 ≥5 个字符前缀：+2500
 *   （例如 `wallpaper_engine` → `distribution\wallpaper64.exe`，
 *   借此压过更深层的 `distribution\bin\wallpaperui.exe` 与更浅的 `launcher.exe`）。
 * - 体积越大越像主程序（上限 300 分，避免被巨型资源文件带偏）。
 * - 路径越深扣分越多（每层 −1500），因为主程序通常在根目录。
 */
export function resolveMainExe(dir: string, gameName = ''): string {
  if (!dir || !fs.existsSync(dir)) return ''
  const found: string[] = []

  const collect = (target: string, depth: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(target, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isFile() && /\.exe$/i.test(entry.name) && !isNoiseExe(entry.name)) {
        found.push(path.join(target, entry.name))
      }
    }
    if (depth <= 0) return
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIR.test(entry.name)) collect(path.join(target, entry.name), depth - 1)
    }
  }

  // 下钻两层：覆盖 `<游戏>/Binaries/Win64/Game-Win64-Shipping.exe` 这类 Unreal 目录结构。
  collect(dir, 2)
  if (found.length === 0) return ''
  if (found.length === 1) return found[0]

  const normalize = (input: string) => input.toLowerCase().replace(/[\s_.\-:：()[\]【】]/g, '')
  const folder = normalize(path.basename(dir))
  const target = normalize(gameName)

  /** 两串共同前缀长度（用于识别 `wallpaper` 这种同源命名）。 */
  const sharedPrefix = (a: string, b: string): number => {
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1
    return i
  }

  const score = (file: string): number => {
    const base = normalize(path.basename(file, path.extname(file)))
    let value = 0
    if (base && (base === folder || base === target)) value += 6000
    else if (base && ((folder && (base.includes(folder) || folder.includes(base))) || (target && (base.includes(target) || target.includes(base))))) {
      value += 2000
    } else if (base && (sharedPrefix(base, folder) >= 5 || sharedPrefix(base, target) >= 5)) {
      value += 2500
    }
    try {
      value += Math.min(fs.statSync(file).size / 1024 / 1024, 300)
    } catch {
      /* 取不到体积就不加分 */
    }
    value -= file.split(path.sep).length * 1500
    return value
  }

  return [...found].sort((a, b) => score(b) - score(a))[0]
}

interface BuiltIcon {
  png: Buffer
  source: string
}

/** 按优先级尝试所有来源，产出图标字节与来源标记。 */
async function buildIcon(game: Game): Promise<BuiltIcon | null> {
  const appid = (game.steamAppId || game.appid || '').trim()

  // 1) Steam 本地库封面缓存（离线、质量最高）
  if (appid) {
    const root = await resolveSteamRoot()
    if (root) {
      for (const candidate of steamLocalCoverPaths(root, appid)) {
        try {
          if (!fs.existsSync(candidate)) continue
          const png = toSquarePng(fs.readFileSync(candidate))
          if (png) return { png, source: 'steam-cover' }
        } catch {
          /* 单个候选失败继续下一个 */
        }
      }
    }
  }

  // 2) 安装目录主程序图标
  const exe = resolveMainExe(game.dir, game.name)
  if (exe) {
    const png = await exeIconPng(exe)
    if (png) return { png, source: 'exe' }
  }

  // 3) Steam CDN 官方封面
  if (appid) {
    const urls = [...steamCoverUrls(appid), game.storeCoverUrl].filter(Boolean)
    for (const url of urls) {
      const buffer = await downloadImage(url)
      if (!buffer) continue
      const png = toSquarePng(buffer)
      if (png) return { png, source: 'steam-cdn' }
    }
  }

  return null
}

export interface IconResult {
  /** 可直接喂给 <img src> 的 dataURL；取不到时为 ''。 */
  dataUrl: string
  /** 来源标记：steam-cover / steam-cdn / exe / cache / ''。 */
  source: string
  /** 是否本次新生成（false 表示命中缓存）。 */
  generated: boolean
}

/**
 * 确保某个游戏有可用图标。
 * 命中缓存直接返回；否则按优先级生成并落盘；全部失败时保留旧缓存（若有）。
 */
export async function ensureGameIcon(game: Game, options: { force?: boolean } = {}): Promise<IconResult> {
  if (!options.force) {
    const cached = readIconDataUrl(game.id)
    if (cached) return { dataUrl: cached, source: game.iconSource || 'cache', generated: false }
  }

  const built = await buildIcon(game)
  if (!built) {
    const cached = readIconDataUrl(game.id)
    return { dataUrl: cached, source: cached ? game.iconSource || 'cache' : '', generated: false }
  }

  ensureDir(store.dirs.icons)
  fs.writeFileSync(iconFile(game.id), built.png)
  return { dataUrl: toDataUrl(built.png), source: built.source, generated: true }
}

/** 批量取图标（只补齐缺失项，命中缓存不重复计算）。 */
export async function ensureIcons(list: Game[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const game of list) {
    try {
      const result = await ensureGameIcon(game)
      if (result.dataUrl) out[game.id] = result.dataUrl
    } catch {
      /* 单个游戏取图标失败不影响其他游戏 */
    }
  }
  return out
}
