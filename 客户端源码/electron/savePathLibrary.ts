// 存档路径知识库：基于 Ludusavi manifest（MIT）的「游戏 → 存档路径」映射。
//
// 数据文件：resources/data/save-paths.json（随包分发，离线可用）
//   - 6613 款游戏、15042 条路径
//   - 路径用 POSIX 正斜杠书写，占位符为 Ludusavi 口径（见 resolveSavePath）
//   - bySteamId 索引用于和 Steam 库扫描结果直接 join，零模糊匹配
//
// 本模块只做「查表 + 占位符解析」，不做任何写操作，也不遍历磁盘
// （存在性与体积统计由调用方 savePathFinder 负责）。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { app } from 'electron'
import { normKey } from './util.js'

/** <storeUserId> 是通配符：指向平台账号 ID 目录，未替换时保留 * 由上层展开。 */
export const STORE_ID_WILDCARD = '<storeUserId>'

/** 在 Windows 上无意义、解析时直接判为不适用的占位符。 */
const NON_WINDOWS_PLACEHOLDER = ['<xdgData>', '<xdgConfig>', '<xdgCache>']

export interface LibraryPath {
  raw: string
  ph: string[]
  tags?: string[]
}

export interface LibraryGame {
  k: string
  name: string
  title?: string
  steamId: string
  installDir: string
  cloud: string[]
  paths: LibraryPath[]
  regs?: string[]
}

export interface SavePathLibrary {
  schema: number
  source: string
  generatedAt: string
  stats: Record<string, number>
  games: LibraryGame[]
  bySteamId: Record<string, number>
}

/** 本机标准目录。惰性求值，避免模块加载顺序影响 app.getPath。 */
let dirs: Record<string, string> | null = null

function localDirs(): Record<string, string> {
  if (dirs) return dirs
  const home = os.homedir()
  const roaming = app.getPath('appData') // %APPDATA% = <home>\AppData\Roaming
  const appDataRoot = path.join(roaming, '..') // <home>\AppData
  const systemRoot = path.parse(home).root.replace(/[\\/]+$/, '') // C:
  dirs = {
    home,
    roaming,
    local: path.join(appDataRoot, 'Local'),
    localLow: path.join(appDataRoot, 'LocalLow'),
    documents: app.getPath('documents'),
    savedGames: path.join(home, 'Saved Games'),
    public: path.join(systemRoot, 'Users', 'Public'),
    programData: path.join(systemRoot, 'ProgramData'),
    winDir: path.join(systemRoot, 'Windows'),
    systemRoot,
    osUserName: os.userInfo().username,
  }
  return dirs
}

/** 重置本机目录缓存（测试注入不同的 APPDATA 时需要）。 */
export function resetDirCache(): void {
  dirs = null
}

let cache: SavePathLibrary | null = null
let cacheFile = ''

/** 数据文件位置：打包后在 resources/data 下，开发态在源码 resources/data。 */
function dataFile(): string {
  if (cacheFile) return cacheFile
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'data', 'save-paths.json')]
    : [
        path.join(app.getAppPath(), 'resources', 'data', 'save-paths.json'),
        path.join(process.cwd(), 'resources', 'data', 'save-paths.json'),
      ]
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      cacheFile = file
      return file
    }
  }
  cacheFile = candidates[0]
  return cacheFile
}

/** 惰性加载知识库；文件缺失时返回空库而非抛错（功能降级为启发式探测）。 */
export function loadLibrary(): SavePathLibrary {
  if (cache) return cache
  const empty: SavePathLibrary = {
    schema: 1,
    source: '',
    generatedAt: '',
    stats: {},
    games: [],
    bySteamId: {},
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile(), 'utf8')) as Partial<SavePathLibrary>
    cache = {
      schema: parsed.schema ?? 1,
      source: parsed.source ?? '',
      generatedAt: parsed.generatedAt ?? '',
      stats: parsed.stats ?? {},
      games: parsed.games ?? [],
      bySteamId: parsed.bySteamId ?? {},
    }
  } catch {
    cache = empty
  }
  return cache
}

export function libraryAvailable(): boolean {
  return loadLibrary().games.length > 0
}

/** 知识库元信息，供设置页展示数据来源与规模。 */
export function libraryInfo(): {
  available: boolean
  source: string
  generatedAt: string
  games: number
  paths: number
  withSteam: number
} {
  const lib = loadLibrary()
  return {
    available: lib.games.length > 0,
    source: lib.source,
    generatedAt: lib.generatedAt,
    games: lib.games.length,
    paths: lib.stats.paths ?? 0,
    withSteam: lib.stats.withSteam ?? 0,
  }
}

/** 按 Steam appid 精确查（首选路径，零模糊匹配）。 */
export function findBySteamId(appid: string): LibraryGame | null {
  if (!appid) return null
  const lib = loadLibrary()
  const index = lib.bySteamId[String(appid)]
  return typeof index === 'number' ? (lib.games[index] ?? null) : null
}

/**
 * 归一化游戏名用于匹配：见 util.ts 的 normKey（主进程唯一真源）。
 * 本模块不再自行定义，避免同一语义出现第二份清洗规则。
 */
export { normKey }
let nameIndex: Map<string, LibraryGame> | null = null

/**
 * 名称索引。title 是「中文/英文/别名」斜杠拼接串，
 * 必须按 / 切段后分别建键 —— 整串归一化会让匹配率从 ~79% 掉到 2%。
 */
function ensureNameIndex(): Map<string, LibraryGame> {
  if (nameIndex) return nameIndex
  const index = new Map<string, LibraryGame>()
  const add = (key: string, game: LibraryGame): void => {
    if (key.length >= 2 && !index.has(key)) index.set(key, game)
  }
  for (const game of loadLibrary().games) {
    for (const seg of String(game.title || game.name || '').split('/')) add(normKey(seg), game)
    add(normKey(game.name || ''), game)
    add(normKey(game.installDir || ''), game)
  }
  nameIndex = index
  return index
}

/** 名称兜底匹配（无 Steam appid 时使用）。 */
export function findByName(name: string, aliases: string[] = []): LibraryGame | null {
  const index = ensureNameIndex()
  for (const candidate of [name, ...aliases]) {
    const key = normKey(candidate)
    if (key.length < 2) continue
    const hit = index.get(key)
    if (hit) return hit
  }
  return null
}

/**
 * 统一入口：优先 Steam appid 精确命中，其次按名称兜底。
 * @param storeIds 平台账号 ID，用于替换 <storeUserId>
 */
export function lookupSaveLibrary(
  game: { appid?: string; steamAppId?: string; name: string; aliases?: string[] },
  storeIds: string[] = [],
): LibraryGame | null {
  const hit =
    findBySteamId(game.steamAppId || '') ||
    findBySteamId(game.appid || '') ||
    findByName(game.name, game.aliases ?? [])
  if (!hit) return null
  const id = storeIds[0]
  if (!id) return hit
  return {
    ...hit,
    paths: hit.paths.map((p) => ({
      ...p,
      raw: p.raw.split(STORE_ID_WILDCARD).join(id),
      ph: p.ph.filter((x) => x !== STORE_ID_WILDCARD),
    })),
  }
}

/** 解析结果：本机绝对路径，可能含 * 通配符段。 */
export interface ResolvedSavePath {
  /** 解析后的本机路径（分隔符已转为当前平台） */
  path: string
  /** 是否含未展开的通配符（*） */
  wildcard: boolean
  tags: string[]
}

/**
 * 把一条 raw 路径解析成本机绝对路径。
 * - 含 <base> 时必须由调用方传入 gameDir，否则返回 null。
 * - <storeUserId> 未替换时保留 `*`，交由上层展开。
 * - Linux 专有占位符（xdg*）在 Windows 上直接返回 null。
 */
export function resolveSavePath(
  raw: string,
  opts: { gameDir?: string; storeIds?: string[] } = {},
): ResolvedSavePath | null {
  if (!raw) return null
  for (const ph of NON_WINDOWS_PLACEHOLDER) {
    if (raw.includes(ph)) return null
  }

  let text = raw
  if (opts.storeIds && opts.storeIds.length > 0) {
    text = text.split(STORE_ID_WILDCARD).join(opts.storeIds[0])
  }
  if (text.includes('<base>')) {
    if (!opts.gameDir) return null
    text = text.split('<base>').join(opts.gameDir.replace(/\\/g, '/'))
  }

  const d = localDirs()
  const substitutions: Array<[string, string]> = [
    ['<home>', d.home],
    ['<winLocalAppDataLow>', d.localLow], // 必须先于 <winLocalAppData>
    ['<winLocalAppData>', d.local],
    ['<winAppData>', d.roaming],
    ['<winDocuments>', d.documents],
    ['<winSavedGames>', d.savedGames],
    ['<winPublic>', d.public],
    ['<winProgramData>', d.programData],
    ['<winDir>', d.winDir],
    ['<osUserName>', d.osUserName],
    ['<root>', d.systemRoot],
  ]
  for (const [key, value] of substitutions) {
    if (text.includes(key)) text = text.split(key).join(value.replace(/\\/g, '/'))
  }

  const wildcard = text.includes('*')
  const converted = process.platform === 'win32' ? text.replace(/\//g, '\\') : text
  return {
    path: wildcard ? converted : path.normalize(converted),
    wildcard,
    tags: [],
  }
}

/** 清空缓存（设置页重新加载数据时用）。 */
export function resetLibraryCache(): void {
  cache = null
  cacheFile = ''
  nameIndex = null
}
