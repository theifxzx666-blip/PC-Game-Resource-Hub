import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { app } from 'electron'

const PLACEHOLDERS: Array<[string, string]> = [
  ['%USERPROFILE%', process.env.USERPROFILE ?? ''],
  ['%LOCALAPPDATA%', process.env.LOCALAPPDATA ?? ''],
  ['%APPDATA%', process.env.APPDATA ?? ''],
  ['%PROGRAMDATA%', process.env.PROGRAMDATA ?? ''],
  ['%TEMP%', process.env.TEMP ?? ''],
  ['%DOCUMENTS%', path.join(process.env.USERPROFILE ?? '', 'Documents')],
]

export function expandPlaceholders(input: string): string {
  let out = input.trim()
  for (const [token, value] of PLACEHOLDERS) {
    out = out.split(token).join(value)
    out = out.split(token.toLowerCase()).join(value)
  }
  return out
}

export function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

export function nowText(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export function isSubPath(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function safeJoin(root: string, relative: string): string {
  const cleaned = relative.replace(/\\/g, '/').replace(/^\/+/, '')
  if (cleaned.split('/').some((seg) => seg === '..')) {
    throw new Error(`拒绝越界路径：${relative}`)
  }
  const target = path.join(root, cleaned)
  if (!isSubPath(root, target)) throw new Error(`拒绝越界路径：${relative}`)
  return target
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

export function copyDir(src: string, dest: string): void {
  ensureDir(dest)
  fs.cpSync(src, dest, { recursive: true, force: true })
}

export function dirSize(dir: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        files += 1
        try {
          bytes += fs.statSync(full).size
        } catch {
          /* 忽略无法读取的文件 */
        }
      }
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return { bytes, files }
}

export function listFilesRecursive(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out
}

// ---------------------------------------------------------------------------
// 游戏名归一化（主进程唯一真源）
// ---------------------------------------------------------------------------
//
// 约束：electron/ 与 src/ 是两个独立编译单元（rootDir 不同），主进程代码
// 无法 import 渲染进程的 src/utils/gameName.ts。因此本函数与
// src/utils/gameName.ts 的 normKey 必须保持**逐字节一致**。
//
// 防漂移保障：scripts/verify-deps.cjs 同目录下的 tests 用同一份语料
// 断言两边输出相同；改动任一侧都会让测试失败。

/** 归一化时一律剥掉的符号（含商标号、度数、全角标点）。保留 CJK。 */
const NORM_SYMBOLS =
  /[™®©°′″·・:：,，.。!！?？'"“”‘’()（）[\]【】<>《》|｜/\\~～\-–—_+*&#@$%^;；＊]/g

/**
 * 游戏名 → 归一化键。剥掉全部符号与空白、转小写，保留 CJK。
 * 与 src/utils/gameName.ts 的 normKey 同口径，勿单独修改。
 */
export function normKey(value: string): string {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(NORM_SYMBOLS, '')
}

// ---------------------------------------------------------------------------
// 别名表（别名 → 正式名）
// ---------------------------------------------------------------------------
//
// 数据文件：resources/data/name-aliases.json（随包分发）
//   schema/1 + aliases: { "<别名或英文名>": "<正式名>" }
//   来源：game-aggregator 的 cn-names.json（由 steam-store-api 学习）+ aliases.json
//
// 用途：把用户输入的俗称/英文名映射到知识库里用的正式中文名。
//   例：「Stardew Valley」→「星露谷物语」，「大表哥2」→「荒野大镖客2」，
//       「泰拉」→「泰拉瑞亚」，「MC」→「我的世界」。
//   不接这张表的话，输入英文名在只收录中文名的知识库里必然 0 命中。
//
// 键值都以 normKey 归一化后存储，查询时同样归一化，避免全角/大小写差异。

let aliasMap: Map<string, string> | null = null

/** 数据目录候选（与 trainerLibrary.dataDir 同策略，但不依赖 app 是否打包）。 */
function aliasDataFile(): string {
  const candidates: string[] = []
  try {
    if (app?.isPackaged) candidates.push(path.join(process.resourcesPath, 'data', 'name-aliases.json'))
  } catch {
    /* app 不可用（单元测试）时忽略 */
  }
  try {
    const appPath = app?.getAppPath?.()
    if (appPath) candidates.push(path.join(appPath, 'resources', 'data', 'name-aliases.json'))
  } catch {
    /* 同上 */
  }
  candidates.push(path.join(process.cwd(), 'resources', 'data', 'name-aliases.json'))
  try {
    if (app?.isPackaged) {
      candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'data', 'name-aliases.json'))
    }
  } catch {
    /* 同上 */
  }
  for (const file of candidates) {
    if (file && fs.existsSync(file)) return file
  }
  return ''
}

/** 载入别名表（带缓存）。文件缺失或损坏时返回空表，不抛异常。 */
function loadAliases(): Map<string, string> {
  if (aliasMap) return aliasMap
  const map = new Map<string, string>()
  const file = aliasDataFile()
  if (file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { aliases?: Record<string, string> }
      for (const [alias, official] of Object.entries(parsed.aliases ?? {})) {
        const key = normKey(alias)
        if (key.length < 2) continue
        if (!map.has(key)) map.set(key, String(official))
      }
    } catch {
      /* 损坏时保留空表 */
    }
  }
  aliasMap = map
  return map
}

/**
 * 把用户的输入展开成候选名称列表（含原始输入本身）。
 *
 * 返回顺序：原始输入 → 命中的正式名 → 正式名可能再作为别名命中的下一跳（最多 2 跳，防环）。
 * 例：expandAlias('大表哥2') → ['大表哥2', '荒野大镖客2']
 */
export function expandAlias(value: string): string[] {
  const raw = String(value ?? '').trim()
  if (!raw) return []
  const out: string[] = [raw]
  const seen = new Set<string>([normKey(raw)])
  let cursor = raw
  for (let hop = 0; hop < 2; hop += 1) {
    const official = loadAliases().get(normKey(cursor))
    if (!official) break
    const key = normKey(official)
    if (seen.has(key)) break
    seen.add(key)
    out.push(official)
    cursor = official
  }
  return out
}

/** 别名表概况，供界面展示「已载入 N 条别名」。 */
export function aliasInfo(): { available: boolean; total: number } {
  const map = loadAliases()
  return { available: map.size > 0, total: map.size }
}

/** 清别名表缓存（测试用）。 */
export function resetAliasCache(): void {
  aliasMap = null
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function removeEmptyDirs(root: string, dir: string): void {
  let current = dir
  while (isSubPath(root, current) && path.resolve(current) !== path.resolve(root)) {
    try {
      if (fs.readdirSync(current).length > 0) return
      fs.rmdirSync(current)
    } catch {
      return
    }
    current = path.dirname(current)
  }
}
