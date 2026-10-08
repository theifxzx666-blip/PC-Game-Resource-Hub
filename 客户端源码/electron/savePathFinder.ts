// 存档路径自动定位：知识库 + 内置规则 + 目录名匹配 + 快照差分（四路合一）。
//
// 候选来源优先级（高 → 低）：
//  1. savePathLibrary：Ludusavi manifest 知识库（6613 款游戏的确切路径），
//     优先按 Steam appid 精确命中，其次按名称兜底。
//  2. 内置规则表：知识库未收录的热门游戏。
//  3. 目录名匹配：扫描系统常见存档根目录，按游戏名词元匹配。
//  4. 安装目录内扫描。
//  快照差分独立于以上四路，用于「实测」确认真正发生变动的目录。
//
// 设计原则：只读扫描用户已授权的范围（游戏安装目录 + 系统存档常见根目录），
// 不遍历整个磁盘；匹配不到时明确返回空列表而不是猜。

import fs from 'node:fs'
import path from 'node:path'
import { expandPlaceholders } from './util.js'
import { libraryInfo, lookupSaveLibrary, resolveSavePath } from './savePathLibrary.js'
import type { Game } from './types.js'

/** 候选来源，用于在界面上解释「为什么推荐它」。 */
export type SavePathOrigin =
  | 'library' // 命中 Ludusavi 存档路径知识库
  | 'known-rule' // 命中了内置规则表
  | 'game-name-dir' // 目录名与游戏名匹配
  | 'appdata' // 来自 %APPDATA% / %LOCALAPPDATA%
  | 'documents' // 来自「我的文档」
  | 'saved-games' // 来自「保存的游戏」
  | 'install-dir' // 位于游戏安装目录内
  | 'snapshot' // 由启动前后差分确认

export interface SavePathCandidate {
  /** 展开占位符后的绝对路径 */
  path: string
  /** 命中来源 */
  origin: SavePathOrigin
  /** 0–100，越高越可能是真正的存档目录 */
  score: number
  /** 该目录是否存在 */
  exists: boolean
  /** 目录内文件数（递归，最多统计 2000 个即停） */
  fileCount: number
  /** 目录总字节数 */
  sizeBytes: number
  /** 最近修改时间（ISO 字符串，空表示未取到） */
  lastModified: string
  /** 面向用户的一句话理由 */
  reason: string
  /** 知识库标注的路径用途标签（config / save 等） */
  tags?: string[]
}

export interface ProbeResult {
  gameId: string
  candidates: SavePathCandidate[]
  /** 已扫描过的根目录，便于用户理解扫描范围 */
  scannedRoots: string[]
  /** 被跳过的原因（例如未配置安装目录） */
  skipped: string[]
  /** 本次探测的知识库命中情况，供界面提示数据来源 */
  library: {
    available: boolean
    /** 知识库中命中的游戏名（未命中为空） */
    matched: string
    /** 命中方式 */
    matchBy: 'steam' | 'name' | ''
    /** 知识库统计的路径条数 */
    pathCount: number
  }
}

/** 内置规则：游戏名关键词 → 相对系统存档根目录的子路径。 */
interface KnownRule {
  /** 匹配关键词（小写，任一命中即可） */
  match: string[]
  /** 相对路径模板，可用 {name} 代表游戏名 */
  paths: string[]
  note: string
}

/**
 * 内置规则表。只收录存档位置确定、玩家常问的热门游戏；
 * 未命中时依靠目录名匹配 + 快照差分兜底，不依赖这张表。
 */
const KNOWN_RULES: KnownRule[] = [
  {
    match: ['stardew valley', '星露谷'],
    paths: ['%APPDATA%/StardewValley/Saves'],
    note: '星露谷物语存档固定位于 AppData 下的 StardewValley\\Saves',
  },
  {
    match: ['the witcher 3', '巫师3', '巫师三'],
    paths: ['%USERPROFILE%/Documents/The Witcher 3/gamesaves'],
    note: '巫师 3 存档位于「我的文档\\The Witcher 3\\gamesaves」',
  },
  {
    match: ['elden ring', '艾尔登法环'],
    paths: ['%APPDATA%/EldenRing'],
    note: '艾尔登法环存档位于 AppData\\EldenRing\\<SteamID>',
  },
  {
    match: ['baldurs gate 3', '博德之门3', '博德之门'],
    paths: ['%LOCALAPPDATA%/Larian Studios/Baldur\'s Gate 3/PlayerProfiles'],
    note: '博德之门 3 存档位于 LocalAppData\\Larian Studios 下',
  },
  {
    match: ['cyberpunk 2077', '赛博朋克'],
    paths: ['%USERPROFILE%/Saved Games/CD Projekt Red/Cyberpunk 2077'],
    note: '赛博朋克 2077 存档位于「保存的游戏\\CD Projekt Red」下',
  },
  {
    match: ['skyrim', '上古卷轴'],
    paths: ['%USERPROFILE%/Documents/My Games/Skyrim Special Edition/Saves'],
    note: '上古卷轴 5 存档位于「我的文档\\My Games」下',
  },
  {
    match: ['fallout 4', '辐射4', '辐射 4'],
    paths: ['%USERPROFILE%/Documents/My Games/Fallout4/Saves'],
    note: '辐射 4 存档位于「我的文档\\My Games」下',
  },
  {
    match: ['hollow knight', '空洞骑士'],
    paths: ['%USERPROFILE%/AppData/LocalLow/Team Cherry/Hollow Knight'],
    note: '空洞骑士存档位于 AppData\\LocalLow\\Team Cherry 下',
  },
  {
    match: ['terraria', '泰拉瑞亚'],
    paths: ['%USERPROFILE%/Documents/My Games/Terraria'],
    note: '泰拉瑞亚存档位于「我的文档\\My Games\\Terraria」下',
  },
  {
    match: ['don\'t starve', '饥荒'],
    paths: ['%USERPROFILE%/Documents/Klei/DoNotStarveTogether'],
    note: '饥荒存档位于「我的文档\\Klei」下',
  },
  {
    match: ['dark souls', '黑暗之魂'],
    paths: ['%APPDATA%/DarkSoulsIII'],
    note: '黑魂系列存档位于 AppData 下的 DarkSouls* 目录',
  },
  {
    match: ['monster hunter', '怪物猎人'],
    paths: ['%APPDATA%/../Local/MonsterHunterWorld'],
    note: '怪物猎人：世界存档位于 AppData 下的 MonsterHunterWorld',
  },
  {
    match: ['resident evil', '生化危机'],
    paths: ['%APPDATA%/RE8', '%APPDATA%/RE4'],
    note: '生化危机存档位于 AppData 下的 RE* 目录',
  },
  {
    match: ['nioh', '仁王'],
    paths: ['%USERPROFILE%/Documents/KOEI/Nioh2'],
    note: '仁王存档位于「我的文档\\KOEI」下',
  },
  {
    match: ['nier', '尼尔'],
    paths: ['%USERPROFILE%/Documents/My Games/NieRAutomata'],
    note: '尼尔：机械纪元存档位于「我的文档\\My Games」下',
  },
]

/** 系统级存档根目录（相对占位符），用于全量扫描。 */
const SAVE_ROOTS = [
  '%APPDATA%',
  '%LOCALAPPDATA%',
  '%USERPROFILE%/Documents/My Games',
  '%USERPROFILE%/Saved Games',
  '%USERPROFILE%/Documents',
  '%USERPROFILE%/AppData/LocalLow',
]

/** 明显不是存档的目录名，扫描时跳过。 */
const NOISE_DIRS = new Set([
  'microsoft',
  'windows',
  'packages',
  'temp',
  'cache',
  'caches',
  'crashdumps',
  'nvidia',
  'intel',
  'amd',
  'd3dscache',
  'google',
  'mozilla',
  'adobe',
  '$recycle.bin',
  'system volume information',
  'programs',
  'programdata',
  'connecteddevicesplatform',
  'comms',
  'virtualstore',
  'history',
  'inetcookies',
  'nethood',
  'printhood',
  'recent',
  'sendto',
  'templates',
])

/** 目录名命中这些词时，强烈提示是存档目录。 */
const SAVE_HINTS = ['save', 'saves', 'saved', 'savegame', 'savegames', '存档', 'profile', 'profiles', 'playerdata']

/** 只看目录条目的浅层扫描深度上限。 */
const MAX_DEPTH = 4
/** 单个候选目录统计文件数上限（避免卡住）。 */
const MAX_COUNT_FILES = 2000

function fileStatCount(dir: string): { fileCount: number; sizeBytes: number; lastModified: string } {
  let fileCount = 0
  let sizeBytes = 0
  let latest = 0
  const walk = (current: string, depth: number): void => {
    if (fileCount >= MAX_COUNT_FILES || depth > 6) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (fileCount >= MAX_COUNT_FILES) return
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (entry.isFile()) {
        fileCount += 1
        try {
          const st = fs.statSync(full)
          sizeBytes += st.size
          if (st.mtimeMs > latest) latest = st.mtimeMs
        } catch {
          /* 忽略读不到的文件 */
        }
      }
    }
  }
  walk(dir, 0)
  return {
    fileCount,
    sizeBytes,
    lastModified: latest ? new Date(latest).toISOString() : '',
  }
}

/** 目录名短于该长度不参与「名字匹配」，避免 de / 01 这类碎片误报。 */
const MIN_MATCH_DIR_LEN = 5

/** 目录名含这些片段时视为缓存/资源目录，不当作存档候选。 */
const NOISE_FRAGMENTS = [
  'cache',
  'caches',
  'resource_cache',
  'index-v5',
  '_cacache',
  'imagefiles',
  'log',
  'logs',
  'crash',
  'tmp',
  'temp',
  'backup',
  'staging',
  'downloads',
  'installer',
]

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
}

/** 把「游戏名」拆成可比较的词元，用于目录名匹配。 */
function nameTokens(name: string): string[] {
  const lowered = name.toLowerCase()
  // 只取长度 >= 4 的词元；像 "Stardew Valley" 里的 "valley" 也有意义，
  // 但 "de"、"of" 这类碎片必须排除，否则会命中海量无关目录。
  const parts = lowered.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((x) => x.length >= 4)
  const joined = normalize(name)
  const tokens = [...new Set([...parts, joined].filter((x) => x.length >= 4))]
  // 中文游戏名整体作为一个词元
  const cjk = name.match(/[\u4e00-\u9fa5]{2,}/g)
  if (cjk) tokens.push(...cjk)
  return [...new Set(tokens)]
}

function isNoiseDirName(name: string): boolean {
  const lower = name.toLowerCase()
  return NOISE_FRAGMENTS.some((frag) => lower.includes(frag))
}

/**
 * 从知识库取候选路径（最高优先级来源）。
 *
 * 路径可能含 `<storeUserId>`（通配符）或 `<base>`（游戏安装目录）：
 * - `<storeUserId>` 未替换时保留 `*`，这里展开「* 目录」为实际子目录后再入候选；
 * - `<base>` 需要游戏安装目录，未配置游戏目录时跳过该条。
 */
function fromLibrary(game: Game): {
  candidates: SavePathCandidate[]
  matched: string
  matchBy: 'steam' | 'name' | ''
  pathCount: number
  availableHint: boolean
} {
  const info = libraryInfo()
  const empty = {
    candidates: [] as SavePathCandidate[],
    matched: '',
    matchBy: '' as const,
    pathCount: 0,
    availableHint: info.available,
  }
  if (!info.available) return empty

  const matchBy: 'steam' | 'name' = game.appid || game.steamAppId ? 'steam' : 'name'
  const hit = lookupSaveLibrary(game)
  if (!hit) return { ...empty, matchBy }

  const label = hit.title || hit.name
  const out: SavePathCandidate[] = []

  for (const entry of hit.paths) {
    const resolved = resolveSavePath(entry.raw, { gameDir: game.dir })
    if (!resolved) continue
    const reason = `存档路径知识库（Ludusavi）命中${matchBy === 'steam' ? ' Steam appid' : '游戏名'}：${label}`
    const tags = entry.tags ?? []

    if (resolved.wildcard) {
      // 通配符段（通常是 Steam 账号 ID 目录）：展开为实际子目录逐个入候选
      for (const actual of expandWildcard(resolved.path)) {
        out.push(makeCandidate(actual, 'library', 99, `${reason}（含账号 ID 目录）`, tags))
      }
    } else {
      out.push(makeCandidate(resolved.path, 'library', 99, reason, tags))
    }
  }

  return { candidates: out, matched: label, matchBy, pathCount: hit.paths.length, availableHint: true }
}

/** 展开路径里的 `*` 段：只对「*」所在的直接父目录列一层。 */
function expandWildcard(target: string): string[] {
  const starIndex = target.indexOf('*')
  if (starIndex < 0) return [target]
  const sep = path.sep
  const head = target.slice(0, starIndex)
  const tail = target.slice(starIndex + 1)
  const parent = head.endsWith(sep) ? head.slice(0, -1) : path.dirname(head.replace(/[\\/]+$/, ''))
  const root = parent || head
  try {
    if (!fs.existsSync(root)) return []
    const out: string[] = []
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      out.push(path.normalize(`${root}${sep}${entry.name}${tail}`))
    }
    return out
  } catch {
    return []
  }
}

function makeCandidate(
  rawPath: string,
  origin: SavePathOrigin,
  score: number,
  reason: string,
  tags: string[] = [],
): SavePathCandidate {
  // 模板里用正斜杠书写更易读，这里统一 normalize 成当前平台的分隔符
  const expanded = path.normalize(path.resolve(expandPlaceholders(rawPath)))
  let exists = false
  try {
    exists = fs.statSync(expanded).isDirectory()
  } catch {
    exists = false
  }
  const stat = exists ? fileStatCount(expanded) : { fileCount: 0, sizeBytes: 0, lastModified: '' }
  return {
    path: expanded,
    origin,
    score: Math.max(0, Math.min(100, Math.round(score))),
    exists,
    fileCount: stat.fileCount,
    sizeBytes: stat.sizeBytes,
    lastModified: stat.lastModified,
    reason,
    tags: tags.length > 0 ? tags : undefined,
  }
}

/** 匹配内置规则表。 */
function fromKnownRules(game: Game): SavePathCandidate[] {
  const names = [game.name, ...game.aliases].map((x) => x.toLowerCase()).filter(Boolean)
  const out: SavePathCandidate[] = []
  for (const rule of KNOWN_RULES) {
    const hit = rule.match.find((kw) => names.some((n) => n.includes(kw)))
    if (!hit) continue
    for (const template of rule.paths) {
      out.push(makeCandidate(template, 'known-rule', 95, rule.note))
    }
  }
  return out
}

/** 在指定根目录下按游戏名词元浅层搜索匹配的目录。 */
function searchByName(rootRaw: string, game: Game, origin: SavePathOrigin): SavePathCandidate[] {
  const root = expandPlaceholders(rootRaw)
  if (!fs.existsSync(root)) return []
  const tokens = nameTokens(game.name)
  if (tokens.length === 0) return []

  const out: SavePathCandidate[] = []
  const visit = (current: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const lower = entry.name.toLowerCase()
      if (NOISE_DIRS.has(lower)) continue
      const full = path.join(current, entry.name)
      const normalizedDir = normalize(entry.name)

      // 目录名过短 → 不参与名字匹配（避免 de / 01 之类碎片误报）
      const longEnough = normalizedDir.length >= MIN_MATCH_DIR_LEN
      // 双向匹配：目录名包含游戏名词元，或游戏名包含目录名（要求目录名足够长且非噪音）
      const matched =
        longEnough &&
        !isNoiseDirName(entry.name) &&
        tokens.some((t) => normalizedDir.includes(t) || (normalizedDir.length >= 6 && t.includes(normalizedDir)))

      if (matched) {
        // 目录名本身像存档目录，或目录内直接含存档文件 → 加分
        const dirLike = SAVE_HINTS.some((h) => lower.includes(h))
        const score = dirLike ? 88 : 72
        out.push(
          makeCandidate(
            full,
            origin,
            score - depth * 3,
            dirLike
              ? `目录名与游戏名匹配，且名字里带存档关键词（${origin}）`
              : `目录名与游戏名匹配（${origin}）`,
          ),
        )
        // 命中的目录再往下找一层 Saves 之类的子目录
        try {
          for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
            if (!sub.isDirectory()) continue
            const subLower = sub.name.toLowerCase()
            if (SAVE_HINTS.some((h) => subLower.includes(h))) {
              out.push(
                makeCandidate(
                  path.join(full, sub.name),
                  origin,
                  Math.max(60, score - depth * 3),
                  `上级目录与游戏名匹配，本目录名含存档关键词（${origin}）`,
                ),
              )
            }
          }
        } catch {
          /* 忽略 */
        }
      }
      visit(full, depth + 1)
    }
  }
  visit(root, 1)
  return out
}

/** 扫描游戏安装目录内部，找 Saves / savegames 之类的子目录。 */
function fromInstallDir(game: Game): SavePathCandidate[] {
  if (!game.dir || !fs.existsSync(game.dir)) return []
  const out: SavePathCandidate[] = []
  try {
    for (const entry of fs.readdirSync(game.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const lower = entry.name.toLowerCase()
      if (!SAVE_HINTS.some((h) => lower.includes(h))) continue
      out.push(
        makeCandidate(
          path.join(game.dir, entry.name),
          'install-dir',
          70,
          '位于游戏安装目录内，且目录名含存档关键词',
        ),
      )
    }
  } catch {
    /* 忽略 */
  }
  return out
}

/** 合并去重（同一路径保留得分最高的那条）。 */
function dedupe(list: SavePathCandidate[]): SavePathCandidate[] {
  const map = new Map<string, SavePathCandidate>()
  for (const item of list) {
    const key = item.path.toLowerCase().replace(/\\/g, '/')
    const prev = map.get(key)
    if (!prev || item.score > prev.score) map.set(key, item)
  }
  return [...map.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.exists !== b.exists) return a.exists ? -1 : 1
    return b.fileCount - a.fileCount
  })
}

/**
 * 一键探测：多来源收集候选路径，打分排序后返回。
 * 只读扫描，不做任何写入。
 */
export function probeSavePaths(game: Game): ProbeResult {
  const skipped: string[] = []
  const collected: SavePathCandidate[] = []

  // ① 知识库（最高优先级）：优先 Steam appid 精确命中，其次按名称兜底
  const lib = fromLibrary(game)
  collected.push(...lib.candidates)
  if (lib.matched) {
    const missing = lib.candidates.filter((c) => !c.exists).length
    if (missing > 0) {
      skipped.push(
        `知识库收录了该游戏的 ${lib.pathCount} 条路径，其中 ${missing} 条在本机不存在（游戏可能尚未安装到该位置，或还没保存过存档）。`,
      )
    }
  }

  collected.push(...fromKnownRules(game))

  const roots: string[] = []
  for (const rootRaw of SAVE_ROOTS) {
    const expanded = expandPlaceholders(rootRaw)
    if (fs.existsSync(expanded)) roots.push(expanded)
  }

  for (const rootRaw of SAVE_ROOTS) {
    const origin: SavePathOrigin = rootRaw.includes('LocalLow')
      ? 'appdata'
      : rootRaw.includes('APPDATA') || rootRaw.includes('LOCALAPPDATA')
        ? 'appdata'
        : rootRaw.includes('Saved Games')
          ? 'saved-games'
          : 'documents'
    collected.push(...searchByName(rootRaw, game, origin))
  }

  collected.push(...fromInstallDir(game))

  if (!game.dir) skipped.push('未关联游戏安装目录，已跳过安装目录内扫描。')

  const candidates = dedupe(collected).slice(0, 40)
  return {
    gameId: game.id,
    candidates,
    scannedRoots: roots,
    skipped,
    library: {
      available: lib.availableHint,
      matched: lib.matched,
      matchBy: lib.matchBy,
      pathCount: lib.pathCount,
    },
  }
}

// ---------------------------------------------------------------------------
// 快照差分：先在候选目录上建立基线，启动游戏后对比出真正发生变动的目录。
// ---------------------------------------------------------------------------

export interface SnapshotState {
  gameId: string
  capturedAt: string
  /** 路径 → 该目录的聚合指纹 */
  entries: Array<{ path: string; fileCount: number; sizeBytes: number; latestMtime: number }>
}

function snapshotOf(dir: string): { fileCount: number; sizeBytes: number; latestMtime: number } {
  const stat = fileStatCount(dir)
  const latest = stat.lastModified ? new Date(stat.lastModified).getTime() : 0
  return { fileCount: stat.fileCount, sizeBytes: stat.sizeBytes, latestMtime: latest }
}

/** 在给定候选路径上建立基线快照（只读）。 */
export function recordSnapshot(gameId: string, dirs: string[]): SnapshotState {
  const entries: SnapshotState['entries'] = []
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    const s = snapshotOf(dir)
    entries.push({ path: dir, ...s })
  }
  return { gameId, capturedAt: new Date().toISOString(), entries }
}

export interface SnapshotDiffItem {
  path: string
  fileCountDelta: number
  sizeBytesDelta: number
  modified: boolean
  score: number
  reason: string
}

/**
 * 对比快照，找出发生变动的目录。
 * 变动越明显（新增文件 / 体积增长 / mtime 更新）→ 越可能是真正的存档目录。
 */
export function diffSnapshot(before: SnapshotState, dirs: string[]): SnapshotDiffItem[] {
  const baseline = new Map(before.entries.map((e) => [e.path.toLowerCase(), e]))
  const out: SnapshotDiffItem[] = []

  const targets = dirs.length > 0 ? dirs : before.entries.map((e) => e.path)
  for (const dir of targets) {
    if (!fs.existsSync(dir)) continue
    const now = snapshotOf(dir)
    const prev = baseline.get(dir.toLowerCase())
    const fileCountDelta = prev ? now.fileCount - prev.fileCount : now.fileCount
    const sizeBytesDelta = prev ? now.sizeBytes - prev.sizeBytes : now.sizeBytes
    const modified = prev ? now.latestMtime > prev.latestMtime : now.fileCount > 0
    if (!modified && fileCountDelta === 0 && sizeBytesDelta === 0) continue

    let score = 50
    if (fileCountDelta > 0) score += 25
    if (sizeBytesDelta > 0) score += 15
    if (modified) score += 10
    if (fileCountDelta > 3 || sizeBytesDelta > 64 * 1024) score += 10

    const bits: string[] = []
    if (fileCountDelta > 0) bits.push(`新增 ${fileCountDelta} 个文件`)
    else if (fileCountDelta < 0) bits.push(`减少 ${Math.abs(fileCountDelta)} 个文件`)
    if (sizeBytesDelta !== 0) bits.push(`体积变化 ${sizeBytesDelta > 0 ? '+' : ''}${sizeBytesDelta} 字节`)
    if (modified) bits.push('有文件被写入')

    out.push({
      path: dir,
      fileCountDelta,
      sizeBytesDelta,
      modified,
      score: Math.min(100, score),
      reason: `启动游戏前后对比：${bits.join('、') || '出现变动'}`,
    })
  }
  return out.sort((a, b) => b.score - a.score)
}
