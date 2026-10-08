import fs from 'node:fs'
import path from 'node:path'
import { store } from './store.js'
import { extractArchive, requireExtractor, supportsRar } from './archive.js'
import { copyDir, ensureDir, nowText, removeEmptyDirs, safeJoin, stamp, uid } from './util.js'
import type { DeployRecord, Game, ModEntry, ModProfile } from './types.js'

const SKIP_NAMES = new Set([
  'readme',
  'readme.txt',
  'readme.md',
  'license',
  'license.txt',
  'changelog',
  'changelog.txt',
  '说明.txt',
  '使用说明.txt',
  '.ds_store',
  'thumbs.db',
])

const ARCHIVE_EXT = new Set(['.zip', '.7z', '.rar'])

function detectType(dir: string): string {
  const names: string[] = []
  const walk = (current: string, depth: number) => {
    if (depth > 4) return
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(current, entry.name), depth + 1)
      else names.push(entry.name.toLowerCase())
    }
  }
  walk(dir, 0)
  if (names.some((n) => n.endsWith('.pak') || n.endsWith('.ucas') || n.endsWith('.utoc'))) return 'PAK'
  if (names.some((n) => /\.(esp|esm|bsa|ba2)$/.test(n))) return '插件'
  if (names.some((n) => n.endsWith('.dll'))) return '脚本'
  if (names.some((n) => /\.(json|ini|cfg|xml|yaml)$/.test(n))) return '配置'
  return '文件'
}

/** 导入一个 MOD 来源（目录或压缩包），落到工具内的独立目录。 */
async function importOne(sourcePath: string, gameId: string, bundledDir: string): Promise<ModEntry> {
  const id = uid('mod')
  const destDir = path.join(store.dirs.mods, id)
  ensureDir(destDir)
  const ext = path.extname(sourcePath).toLowerCase()
  if (ARCHIVE_EXT.has(ext)) {
    const tool = requireExtractor(bundledDir, store.config().archiveTool)
    if (ext === '.rar' && !(await supportsRar(tool))) {
      throw new Error(`「${path.basename(sourcePath)}」是 rar 包，当前解压工具不支持。请安装 7-Zip 并在设置中指定路径。`)
    }
    await extractArchive(tool, sourcePath, destDir)
  } else if (fs.statSync(sourcePath).isDirectory()) {
    copyDir(sourcePath, destDir)
  } else {
    fs.copyFileSync(sourcePath, path.join(destDir, path.basename(sourcePath)))
  }

  const tops = fs.readdirSync(destDir, { withFileTypes: true })
  const root = tops.length === 1 && tops[0].isDirectory() ? path.join(destDir, tops[0].name) : destDir
  const baseName = tops.length === 1 && tops[0].isDirectory() ? tops[0].name : path.basename(sourcePath).replace(/\.[^.]+$/, '')

  const entry: ModEntry = {
    id,
    gameId,
    name: baseName,
    version: '',
    type: detectType(root),
    tags: [],
    enabled: false,
    importedAt: nowText(),
    installedAt: '',
    sourceDir: root,
    entryCount: countFiles(root),
    deployed: [],
  }
  const list = store.mods()
  list.push(entry)
  store.saveMods(list)
  return entry
}

function countFiles(dir: string): number {
  let count = 0
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(current, entry.name))
      else count += 1
    }
  }
  walk(dir)
  return count
}

export async function importMods(
  paths: string[],
  gameId: string,
  bundledDir: string,
): Promise<{ imported: ModEntry[]; failed: string[] }> {
  const imported: ModEntry[] = []
  const failed: string[] = []
  for (const target of paths) {
    try {
      imported.push(await importOne(target, gameId, bundledDir))
    } catch (error) {
      failed.push(`${path.basename(target)}：${(error as Error).message}`)
    }
  }
  return { imported, failed }
}

export interface PlanItem {
  source: string
  target: string
  overwrite: boolean
}

function requireGame(gameId: string): Game {
  const game = store.games().find((item) => item.id === gameId)
  if (!game) throw new Error('未找到该游戏。')
  return game
}

function buildPlan(mod: ModEntry): PlanItem[] {
  const game = requireGame(mod.gameId)
  if (!game.dir) throw new Error('该游戏未关联安装目录，无法安装 MOD。')
  const plan: PlanItem[] = []
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const rel = path.relative(mod.sourceDir, full)
      const segments = rel.split(/[\\/]/)
      if (segments.some((seg) => seg.startsWith('.'))) continue
      if (SKIP_NAMES.has(entry.name.toLowerCase())) continue
      const target = safeJoin(game.dir, rel)
      plan.push({ source: full, target, overwrite: fs.existsSync(target) })
    }
  }
  walk(mod.sourceDir)
  return plan
}

export function planMod(modId: string): { items: PlanItem[]; overwriteCount: number } {
  const mod = store.mods().find((item) => item.id === modId)
  if (!mod) throw new Error('未找到该 MOD。')
  const items = buildPlan(mod)
  return { items, overwriteCount: items.filter((item) => item.overwrite).length }
}

export function installMod(modId: string): ModEntry {
  const list = store.mods()
  const mod = list.find((item) => item.id === modId)
  if (!mod) throw new Error('未找到该 MOD。')
  if (mod.deployed.length > 0) return mod
  const plan = buildPlan(mod)
  if (plan.length === 0) throw new Error('该 MOD 目录内没有可安装的文件。')

  const restoreDir = path.join(store.root, 'mods', 'restore', modId, stamp())
  const deployed: DeployRecord[] = []
  try {
    for (const item of plan) {
      if (item.overwrite) {
        const rel = path.relative(requireGame(mod.gameId).dir, item.target)
        const backupTarget = safeJoin(restoreDir, rel)
        ensureDir(path.dirname(backupTarget))
        fs.copyFileSync(item.target, backupTarget)
      }
      ensureDir(path.dirname(item.target))
      fs.copyFileSync(item.source, item.target)
      deployed.push({ source: item.source, target: item.target, created: !item.overwrite })
    }
  } catch (error) {
    for (const record of deployed) {
      try {
        fs.rmSync(record.target, { force: true })
      } catch {
        /* 回滚尽力而为 */
      }
    }
    throw new Error(`安装失败已回滚：${(error as Error).message}`)
  }

  mod.deployed = deployed
  mod.installedAt = nowText()
  mod.enabled = true
  store.saveMods(list)
  return mod
}

export function uninstallMod(modId: string): ModEntry {
  const list = store.mods()
  const mod = list.find((item) => item.id === modId)
  if (!mod) throw new Error('未找到该 MOD。')
  const game = requireGame(mod.gameId)
  for (const record of mod.deployed) {
    try {
      fs.rmSync(record.target, { force: true })
      removeEmptyDirs(game.dir, path.dirname(record.target))
    } catch {
      /* 单个文件删除失败不中断整体卸载 */
    }
  }
  mod.deployed = []
  mod.installedAt = ''
  mod.enabled = false
  store.saveMods(list)
  return mod
}

export function setModEnabled(modId: string, enabled: boolean): ModEntry {
  return enabled ? installMod(modId) : uninstallMod(modId)
}

export function removeMod(modId: string): void {
  const list = store.mods()
  const mod = list.find((item) => item.id === modId)
  if (!mod) return
  if (mod.deployed.length > 0) throw new Error('请先卸载该 MOD 再删除。')
  fs.rmSync(path.join(store.dirs.mods, modId), { recursive: true, force: true })
  store.saveMods(list.filter((item) => item.id !== modId))
}

export function updateMod(modId: string, patch: Partial<Pick<ModEntry, 'name' | 'version' | 'tags' | 'type'>>): ModEntry {
  const list = store.mods()
  const mod = list.find((item) => item.id === modId)
  if (!mod) throw new Error('未找到该 MOD。')
  Object.assign(mod, patch)
  store.saveMods(list)
  return mod
}

export interface ConflictItem {
  target: string
  modIds: string[]
  modNames: string[]
}

export function listConflicts(gameId: string): ConflictItem[] {
  const mods = store.mods().filter((item) => item.gameId === gameId && item.enabled && item.deployed.length > 0)
  const map = new Map<string, string[]>()
  for (const mod of mods) {
    for (const record of mod.deployed) {
      const key = record.target.toLowerCase()
      const list = map.get(key) ?? []
      list.push(mod.id)
      map.set(key, list)
    }
  }
  const result: ConflictItem[] = []
  for (const [target, modIds] of map) {
    if (modIds.length < 2) continue
    result.push({
      target,
      modIds,
      modNames: modIds.map((id) => store.mods().find((item) => item.id === id)?.name ?? id),
    })
  }
  return result
}

export function listProfiles(gameId?: string): ModProfile[] {
  const list = store.profiles()
  return gameId ? list.filter((item) => item.gameId === gameId) : list
}

export function saveProfile(gameId: string, name: string): ModProfile {
  const mods = store.mods().filter((item) => item.gameId === gameId)
  const profile: ModProfile = {
    id: uid('profile'),
    gameId,
    name: name.trim() || `档案 ${nowText()}`,
    enabled: mods.filter((item) => item.enabled).map((item) => item.id),
    order: mods.map((item) => item.id),
    createdAt: nowText(),
  }
  const list = store.profiles()
  list.push(profile)
  store.saveProfiles(list)
  return profile
}

export function applyProfile(profileId: string): void {
  const profile = store.profiles().find((item) => item.id === profileId)
  if (!profile) throw new Error('未找到该配置档案。')
  for (const mod of store.mods().filter((item) => item.gameId === profile.gameId)) {
    const shouldEnable = profile.enabled.includes(mod.id)
    if (shouldEnable && mod.deployed.length === 0) installMod(mod.id)
    if (!shouldEnable && mod.deployed.length > 0) uninstallMod(mod.id)
  }
}

export function deleteProfile(profileId: string): void {
  store.saveProfiles(store.profiles().filter((item) => item.id !== profileId))
}
