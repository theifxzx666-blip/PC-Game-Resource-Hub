/**
 * Steam 商店公开接口对接（按游戏名匹配资料页 + 拉取封面）。
 *
 * 实测（2026-10-07）：
 * GET `https://store.steampowered.com/api/storesearch/?term=<关键词>&l=schinese&cc=CN`
 * → `200`，JSON `{ total: number, items: Array<{ type, name, id, price?, metascore?, platforms?, tiny_image? }> }`
 * 免鉴权、无需 API Key。`l=schinese` 让 name / 封面走中文资源。
 *
 * 网络出口：走 Node 内置 fetch（undici）。Electron 主进程默认跟随系统代理设置，
 * 本机经系统代理可直连该域；若失败按「匹配失败」降级，不影响其他功能。
 *
 * 合规：只读取商店公开信息用于展示与匹配，不涉及任何购买、登录态或绕过行为。
 */
import path from 'node:path'
import { steamLibraryCacheDir } from './steamLocate.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

export interface SteamStoreCandidate {
  appid: string
  name: string
  /** 商店返回的小图（capsule_231x87），作为兜底封面。 */
  image: string
  /** 形如 `¥33.60`；无价格信息时为空串。 */
  price: string
  metascore: string
  /** 形如 `Windows / macOS`。 */
  platforms: string
  storeUrl: string
}

export function steamStoreUrl(appid: string): string {
  return `https://store.steampowered.com/app/${appid}/`
}

/** 带超时的 GET，返回文本；非 2xx 抛错。 */
async function getText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json, image/*, */*' },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim())
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

function formatPrice(value: unknown): string {
  const cents = Number(value)
  if (!Number.isFinite(cents) || cents <= 0) return ''
  return `¥${(cents / 100).toFixed(2)}`
}

function formatPlatforms(value: unknown): string {
  const p = value as Record<string, unknown> | undefined
  if (!p || typeof p !== 'object') return ''
  const names: Array<[string, string]> = [
    ['windows', 'Windows'],
    ['mac', 'macOS'],
    ['linux', 'Linux'],
  ]
  return names.filter(([key]) => p[key] === true).map(([, label]) => label).join(' / ')
}

function parseStoreSearch(text: string): SteamStoreCandidate[] {
  const payload = JSON.parse(text) as Record<string, unknown>
  const items = Array.isArray(payload?.items) ? (payload.items as Array<Record<string, unknown>>) : []
  const out: SteamStoreCandidate[] = []
  for (const item of items) {
    const appid = String(item.id ?? '').trim()
    const name = String(item.name ?? '').trim()
    if (!appid || !name) continue
    out.push({
      appid,
      name,
      image: String(item.tiny_image ?? '').trim(),
      price: formatPrice((item.price as Record<string, unknown> | undefined)?.final),
      metascore: String(item.metascore ?? '').trim(),
      platforms: formatPlatforms(item.platforms),
      storeUrl: steamStoreUrl(appid),
    })
  }
  return out
}

/**
 * 按关键词检索 Steam 商店，返回候选列表。
 *
 * 本机实测该域可达但**网络抖动明显**（同类请求可能一次成功、一次 `fetch failed`），
 * 因此内置一次重试；两次都失败才向上抛错，由界面提示用户稍后重试。
 */
export async function searchSteamStore(term: string, timeoutMs = 8000): Promise<SteamStoreCandidate[]> {
  const keyword = term.trim()
  if (!keyword) return []
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(keyword)}&l=schinese&cc=CN`

  let lastError: Error | null = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return parseStoreSearch(await getText(url, timeoutMs))
    } catch (error) {
      lastError = error as Error
      if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  const reason = lastError?.name === 'AbortError' ? `请求超时（>${timeoutMs} ms）` : (lastError?.message ?? '未知错误')
  throw new Error(`连接 Steam 商店失败：${reason}。可稍后重试；已安装的 Steam 游戏图标不依赖联网，仍会正常显示。`)
}

/**
 * 下载图片字节；失败返回 null（调用方降级，不抛错）。
 * 与商店检索同样做一次重试，应对本机对该 CDN 的偶发抖动。
 */
export async function downloadImage(url: string, timeoutMs = 10000): Promise<Buffer | null> {
  if (!url.trim()) return null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'image/*,*/*' },
        signal: controller.signal,
        redirect: 'follow',
      })
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer())
        if (buffer.length > 0) return buffer
      }
    } catch {
      /* 落到重试 */
    } finally {
      clearTimeout(timer)
    }
    if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return null
}

/**
 * 商店封面候选地址，按「质量优先」排列。
 * `library_600x900` 是竖版库封面（最高质量），`header` 是横版头图，最后才是搜索小图。
 */
export function steamCoverUrls(appid: string): string[] {
  const base = 'https://cdn.cloudflare.steamstatic.com/steam/apps'
  return [`${base}/${appid}/library_600x900.jpg`, `${base}/${appid}/header.jpg`]
}

/**
 * Steam 本地库封面缓存里的候选文件名（离线优先，无需联网）。
 * 实测 `appcache/librarycache/<appid>/` 下可能是 `library_600x900.jpg`、
 * `library_600x900_schinese.jpg`、`header.jpg`、`header_schinese.jpg`、`logo.png`。
 */
export function steamLocalCoverNames(): string[] {
  return [
    'library_600x900_schinese.jpg',
    'library_600x900.jpg',
    'header_schinese.jpg',
    'header.jpg',
    'library_hero_schinese.jpg',
    'library_hero.jpg',
    'logo.png',
  ]
}

/** 拼出某个 appid 的本地封面候选绝对路径（不判断存在性）。 */
export function steamLocalCoverPaths(steamRoot: string, appid: string): string[] {
  if (!steamRoot || !appid) return []
  const dir = path.join(steamLibraryCacheDir(steamRoot), appid)
  return steamLocalCoverNames().map((name) => path.join(dir, name))
}
