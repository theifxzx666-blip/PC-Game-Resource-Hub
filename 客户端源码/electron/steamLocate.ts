/**
 * Steam 安装位置解析。
 *
 * 从 games.ts 抽出，供「启动游戏」「本地封面缓存」「商店匹配」三处复用，避免模块循环依赖。
 *
 * 解析优先级（全部只读）：
 * 1. 注册表 `HKCU\Software\Valve\Steam` 的 `SteamExe`（直接给出 steam.exe 全路径）。
 * 2. 同键下的 `SteamPath`（Steam 根目录）。
 * 3. 默认安装目录 `C:\Program Files (x86)\Steam`、`C:\Program Files\Steam`。
 *
 * 注意：本机 Steam 可能装在含方括号的路径（如 `E:\[Game]Steam`），
 * 因此所有路径处理一律走 `path.join` / `fs.existsSync`，不做字符串拼接与通配。
 */
import fs from 'node:fs'
import path from 'node:path'
import { run } from './exec.js'

const STEAM_REG_KEY = 'HKCU\\Software\\Valve\\Steam'
const FALLBACK_ROOTS = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']

let cachedExe: string | null | undefined

/** 读取注册表某个 REG_SZ 值；读不到返回空串（不抛错）。 */
async function regString(name: string): Promise<string> {
  try {
    const { stdout } = await run('reg', ['query', STEAM_REG_KEY, '/v', name])
    const match = new RegExp(`${name}\\s+REG_SZ\\s+(.+)`, 'i').exec(stdout)
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}

/** Steam 根目录；找不到返回 null。 */
export async function resolveSteamRoot(): Promise<string | null> {
  const fromReg = await regString('SteamPath')
  if (fromReg && fs.existsSync(fromReg)) return fromReg
  for (const candidate of FALLBACK_ROOTS) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/**
 * steam.exe 全路径；找不到返回 null。
 * 结果做进程内缓存：Steam 不会在应用运行期间搬家，避免每次启动游戏都查注册表。
 */
export async function resolveSteamExe(): Promise<string | null> {
  if (cachedExe !== undefined) return cachedExe
  const fromReg = await regString('SteamExe')
  if (fromReg && fs.existsSync(fromReg)) {
    cachedExe = fromReg
    return cachedExe
  }
  const root = await resolveSteamRoot()
  if (root) {
    const exe = path.join(root, 'steam.exe')
    if (fs.existsSync(exe)) {
      cachedExe = exe
      return cachedExe
    }
  }
  cachedExe = null
  return cachedExe
}

/** Steam 本地封面缓存根目录（`appcache/librarycache`）。 */
export function steamLibraryCacheDir(steamRoot: string): string {
  return path.join(steamRoot, 'appcache', 'librarycache')
}
