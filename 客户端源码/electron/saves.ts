import fs from 'node:fs'
import path from 'node:path'
import { store } from './store.js'
import { createZip, extractArchive, requireExtractor } from './archive.js'
import {
  copyDir,
  dirSize,
  ensureDir,
  expandPlaceholders,
  listFilesRecursive,
  nowText,
  readJson,
  stamp,
  uid,
  writeJson,
} from './util.js'
import type { BackupEntry, Game } from './types.js'

interface BackupManifest {
  gameId: string
  gameName: string
  name: string
  note: string
  createdAt: string
  /** 与 data/p{i} 一一对应的原始存档路径 */
  savePaths: string[]
}

function requireGame(gameId: string): Game {
  const game = store.games().find((item) => item.id === gameId)
  if (!game) throw new Error('未找到该游戏，请先在游戏库中关联。')
  return game
}

function backupDirFor(gameId: string, backupId: string): string {
  return path.join(store.dirs.backups, gameId, backupId)
}

function writeManifest(dir: string, manifest: BackupManifest): void {
  writeJson(path.join(dir, 'manifest.json'), manifest)
}

function readManifest(dir: string): BackupManifest | null {
  return readJson<BackupManifest | null>(path.join(dir, 'manifest.json'), null)
}

export function listBackups(gameId?: string): BackupEntry[] {
  const list = store.backups()
  const filtered = gameId ? list.filter((item) => item.gameId === gameId) : list
  return filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

function rotate(gameId: string): void {
  const keep = Math.max(1, store.config().backupKeep)
  const all = store.backups()
  const targets = all
    .filter((item) => item.gameId === gameId && !item.pinned)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  const overflow = targets.slice(keep)
  if (overflow.length === 0) return
  for (const item of overflow) {
    fs.rmSync(path.join(store.dirs.backups, item.gameId, item.id), { recursive: true, force: true })
  }
  const removed = new Set(overflow.map((item) => item.id))
  store.saveBackups(all.filter((item) => !removed.has(item.id)))
}

export function createBackup(gameId: string, note = '', name = ''): BackupEntry {
  const game = requireGame(gameId)
  const expanded = game.savePaths.map(expandPlaceholders).filter(Boolean)
  if (expanded.length === 0) throw new Error('该游戏尚未配置存档路径，请先在游戏库中填写。')
  const existing = expanded.filter((dir) => fs.existsSync(dir))
  if (existing.length === 0) throw new Error('配置的存档路径在本机均不存在，请确认路径是否正确。')

  const id = uid('bak')
  const dir = backupDirFor(gameId, id)
  ensureDir(dir)
  expanded.forEach((sourcePath, index) => {
    if (!fs.existsSync(sourcePath)) return
    copyDir(sourcePath, path.join(dir, 'data', `p${index}`))
  })
  const { bytes, files } = dirSize(path.join(dir, 'data'))
  const createdAt = nowText()
  writeManifest(dir, {
    gameId,
    gameName: game.name,
    name: name || `${game.name} ${createdAt}`,
    note,
    createdAt,
    savePaths: expanded,
  })
  const entry: BackupEntry = {
    id,
    gameId,
    name: name || `${game.name} ${createdAt}`,
    note,
    createdAt,
    sizeBytes: bytes,
    fileCount: files,
    pinned: false,
    relativePath: path.join(gameId, id),
  }
  const list = store.backups()
  list.push(entry)
  store.saveBackups(list)
  rotate(gameId)
  return entry
}

export function restoreBackup(gameId: string, backupId: string): { autoBackupId: string; restored: string[] } {
  const game = requireGame(gameId)
  const entry = store.backups().find((item) => item.id === backupId && item.gameId === gameId)
  if (!entry) throw new Error('未找到该备份记录。')
  const dir = backupDirFor(gameId, backupId)
  const manifest = readManifest(dir)
  if (!manifest) throw new Error('备份缺少 manifest，无法确定恢复目标，已中止。')

  const auto = createBackup(gameId, `恢复「${entry.name}」前的自动备份`, `自动备份 ${nowText()}`)

  const restored: string[] = []
  manifest.savePaths.forEach((rawTarget, index) => {
    const source = path.join(dir, 'data', `p${index}`)
    if (!fs.existsSync(source)) return
    const target = expandPlaceholders(rawTarget)
    fs.rmSync(target, { recursive: true, force: true })
    ensureDir(target)
    copyDir(source, target)
    restored.push(target)
  })
  if (restored.length === 0) throw new Error('备份内没有可恢复的数据目录。')
  return { autoBackupId: auto.id, restored }
}

export function removeBackup(gameId: string, backupId: string): void {
  fs.rmSync(backupDirFor(gameId, backupId), { recursive: true, force: true })
  store.saveBackups(store.backups().filter((item) => !(item.id === backupId && item.gameId === gameId)))
}

export function setPinned(gameId: string, backupId: string, pinned: boolean): void {
  const list = store.backups()
  const target = list.find((item) => item.id === backupId && item.gameId === gameId)
  if (!target) throw new Error('未找到该备份记录。')
  target.pinned = pinned
  store.saveBackups(list)
}

export function inspectBackup(gameId: string, backupId: string): { total: number; files: string[] } {
  const dir = backupDirFor(gameId, backupId)
  if (!fs.existsSync(dir)) throw new Error('备份目录不存在。')
  const files = listFilesRecursive(path.join(dir, 'data')).map((full) => path.relative(path.join(dir, 'data'), full))
  return { total: files.length, files: files.slice(0, 200) }
}

export async function exportBackup(gameId: string, backupId: string, bundledDir: string): Promise<string> {
  const dir = backupDirFor(gameId, backupId)
  if (!fs.existsSync(dir)) throw new Error('备份目录不存在。')
  const tool = requireExtractor(bundledDir, store.config().archiveTool)
  const out = path.join(store.dirs.exports, `${gameId}_${backupId}_${stamp()}.zip`)
  await createZip(tool, out, dir)
  return out
}

export async function importArchive(zipPath: string, bundledDir: string): Promise<BackupEntry[]> {
  if (!fs.existsSync(zipPath)) throw new Error('归档文件不存在。')
  const tool = requireExtractor(bundledDir, store.config().archiveTool)
  const staging = path.join(store.dirs.staging, `import-${uid('tmp')}`)
  ensureDir(staging)
  try {
    await extractArchive(tool, zipPath, staging)
    const roots: string[] = []
    if (fs.existsSync(path.join(staging, 'manifest.json'))) roots.push(staging)
    else {
      for (const entry of fs.readdirSync(staging, { withFileTypes: true })) {
        if (entry.isDirectory() && fs.existsSync(path.join(staging, entry.name, 'manifest.json'))) {
          roots.push(path.join(staging, entry.name))
        }
      }
    }
    if (roots.length === 0) {
      throw new Error('归档内未找到备份清单（manifest.json），可能不是本工具导出的备份归档。')
    }
    const added: BackupEntry[] = []
    const list = store.backups()
    for (const root of roots) {
      const manifest = readManifest(root)
      if (!manifest) continue
      const id = uid('bak')
      const target = backupDirFor(manifest.gameId, id)
      ensureDir(path.dirname(target))
      copyDir(root, target)
      const { bytes, files } = dirSize(path.join(target, 'data'))
      const entry: BackupEntry = {
        id,
        gameId: manifest.gameId,
        name: `${manifest.name}（导入）`,
        note: manifest.note,
        createdAt: nowText(),
        sizeBytes: bytes,
        fileCount: files,
        pinned: false,
        relativePath: path.join(manifest.gameId, id),
      }
      list.push(entry)
      added.push(entry)
    }
    store.saveBackups(list)
    return added
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}
