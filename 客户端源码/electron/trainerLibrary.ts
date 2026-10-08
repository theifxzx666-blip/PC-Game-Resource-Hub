// 修改器 / MOD 元数据知识库：机地社区帖离线快照（仅元数据）。
//
// 数据文件：resources/data/trainers.json（随包分发，离线可用）
//   - 8943 条：7825 MOD + 1118 修改器
//   - 每条含：标题、所属游戏、封面、作者、时间、正文摘要、网盘来源分类、来源帖地址
//
// ★ 合规边界（不可放宽）
//   本模块**只读元数据**，不提供任何下载直链，也不含抓取逻辑：
//     · downloadUrl 恒为空串 —— 数据集在构建期就已剔除
//     · homepage 指向来源帖子详情页，用户需自行在浏览器打开查看
//     · 不实现反爬、签名伪造、DRM 绕过或破解分发
//   风险字段：修改器一律记「中」（内存修改类工具），纯 MOD 记「低」，
//   状态一律「待核实」—— 未经本项目核验，界面必须显式提示这一点。
//
// 与 onlineSearch 的关系：本模块是**内置离线源**，
// 在线源可用时其结果参与聚合；在线源全挂时作为兜底，保证「永远有结果」。

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { normKey } from './util.js'
import type { CatalogResource, ResourceKind, ResourceRisk } from './types.js'

/** 数据集里单条记录：CatalogResource + 本数据集扩展字段。 */
export interface TrainerRecord extends CatalogResource {
  /** 封面图地址（机地 CDN）。 */
  cover?: string
  /** 网盘来源分类，如 ['百度网盘','夸克网盘']。不含链接本身。 */
  linkKinds?: string[]
  /** 原始帖正文里出现过的链接条数（仅计数，不含内容）。 */
  linkCount?: number
  /** 发帖日期 YYYY-MM-DD。 */
  postedAt?: string
}

export interface TrainerStats {
  total: number
  byKind: Record<string, number>
  withLinks: number
  byNetdisk: Record<string, number>
}

export interface TrainerLibrary {
  schema: number
  source: string
  generatedAt: string
  notice: string
  stats: TrainerStats
  resources: TrainerRecord[]
}

const EMPTY: TrainerLibrary = {
  schema: 1,
  source: '',
  generatedAt: '',
  notice: '',
  stats: { total: 0, byKind: {}, withLinks: 0, byNetdisk: {} },
  resources: [],
}

let cache: TrainerLibrary | null = null
let nameIndex: Map<string, TrainerRecord[]> | null = null

/**
 * 数据目录解析。
 *
 * 候选顺序：
 *   1. 打包后 process.resourcesPath/data（electron-builder extraResources）
 *   2. 开发态 app.getAppPath()/resources/data（app 路径最可靠）
 *   3. 开发态 process.cwd()/resources/data（兜底）
 *
 * 逐个探测 trainers.json 是否真的存在；都找不到返回空串（不是错误）。
 * 注意不能直接 `return candidates[0]` —— 开发态下 isPackaged 为 false 时
 * candidates[0] 是未验证的第一个候选，可能并不存在。
 */
function dataDir(): string {
  const candidates: string[] = []
  try {
    if (app?.isPackaged) candidates.push(path.join(process.resourcesPath, 'data'))
  } catch {
    /* app 不可用（测试环境）时忽略 */
  }
  try {
    const appPath = app?.getAppPath?.()
    if (appPath) candidates.push(path.join(appPath, 'resources', 'data'))
  } catch {
    /* 同上 */
  }
  candidates.push(path.join(process.cwd(), 'resources', 'data'))
  // 打包后 asar 内也放一份兜底（若 extraResources 未生效时不至于完全没数据）
  try {
    if (app?.isPackaged) candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'data'))
  } catch {
    /* 同上 */
  }

  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'trainers.json'))) return dir
  }
  return ''
}

/** 载入数据集（带缓存）。文件缺失或损坏时返回空库，不抛异常。 */
export function loadTrainers(): TrainerLibrary {
  if (cache) return cache
  const dir = dataDir()
  const file = dir ? path.join(dir, 'trainers.json') : ''
  if (!file || !fs.existsSync(file)) {
    cache = EMPTY
    return cache
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as TrainerLibrary
    if (!parsed || !Array.isArray(parsed.resources)) {
      cache = EMPTY
      return cache
    }
    cache = {
      schema: parsed.schema ?? 1,
      source: parsed.source ?? '',
      generatedAt: parsed.generatedAt ?? '',
      notice: parsed.notice ?? '',
      stats: parsed.stats ?? EMPTY.stats,
      resources: parsed.resources,
    }
  } catch {
    cache = EMPTY
  }
  return cache
}

export function trainersAvailable(): boolean {
  return loadTrainers().resources.length > 0
}

/** 数据集概况，供界面展示「内置知识库已载入 N 条」。 */
export function trainersInfo(): {
  available: boolean
  total: number
  generatedAt: string
  source: string
  notice: string
  byKind: Record<string, number>
} {
  const lib = loadTrainers()
  return {
    available: lib.resources.length > 0,
    total: lib.resources.length,
    generatedAt: lib.generatedAt,
    source: lib.source,
    notice: lib.notice,
    byKind: lib.stats.byKind ?? {},
  }
}

/**
 * 游戏名索引。与存档路径库同样的坑：标题里可能含斜杠分隔的中英混排，
 * 必须按 / 切段建键，不能整串归一化。
 * 值为数组——同一款游戏会有几十条 MOD，不能只留一条。
 */
function ensureNameIndex(): Map<string, TrainerRecord[]> {
  if (nameIndex) return nameIndex
  const index = new Map<string, TrainerRecord[]>()
  const add = (key: string, rec: TrainerRecord): void => {
    if (key.length < 2) return
    const bucket = index.get(key)
    if (bucket) bucket.push(rec)
    else index.set(key, [rec])
  }
  for (const rec of loadTrainers().resources) {
    for (const seg of String(rec.gameName || '').split('/')) add(normKey(seg), rec)
    for (const alias of rec.gameAliases ?? []) add(normKey(alias), rec)
  }
  nameIndex = index
  return index
}

/** 按游戏名取该游戏的全部 MOD / 修改器条目。 */
export function trainersForGame(gameName: string, aliases: string[] = []): TrainerRecord[] {
  if (!gameName && aliases.length === 0) return []
  const index = ensureNameIndex()
  const seen = new Set<string>()
  const out: TrainerRecord[] = []
  for (const candidate of [gameName, ...aliases]) {
    const key = normKey(candidate ?? '')
    if (key.length < 2) continue
    for (const rec of index.get(key) ?? []) {
      if (seen.has(rec.id)) continue
      seen.add(rec.id)
      out.push(rec)
    }
  }
  return out
}

/** 关键词检索（标题 + 游戏名 + 描述 + 标签），供离线兜底搜索用。 */
export function searchTrainers(keyword: string, kinds: ResourceKind[] = [], limit = 120): TrainerRecord[] {
  const lib = loadTrainers()
  const kw = normKey(keyword ?? '')
  const kindSet = new Set(kinds)
  const out: TrainerRecord[] = []
  for (const rec of lib.resources) {
    if (kindSet.size && !kindSet.has(rec.kind)) continue
    if (kw) {
      const hay = normKey(
        `${rec.title}|${rec.gameName}|${rec.description}|${(rec.tags ?? []).join('|')}`,
      )
      if (!hay.includes(kw)) continue
    }
    out.push(rec)
    if (out.length >= limit) break
  }
  return out
}

/** 全部条目（调用方自行分页）。 */
export function allTrainers(): TrainerRecord[] {
  return loadTrainers().resources
}

/** 把数据集记录转成本项目的风险枚举（防御性，数据集里可能被手改坏）。 */
export function coerceRisk(value: unknown): ResourceRisk {
  return value === '中' ? '中' : '低'
}

/** 清缓存（测试用）。 */
export function resetTrainerCache(): void {
  cache = null
  nameIndex = null
}
