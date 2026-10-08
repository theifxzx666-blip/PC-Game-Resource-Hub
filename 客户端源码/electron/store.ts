import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { ensureDir, readJson, uid, writeJson } from './util.js'
import { withPresets } from './presetSources.js'
import type {
  AppConfig,
  BackupEntry,
  DownloadTask,
  Game,
  LibraryItem,
  LogEntry,
  ModEntry,
  ModProfile,
} from './types.js'

const DEFAULT_CONFIG: AppConfig = {
  backupKeep: 5,
  archiveTool: '',
  catalogBaseUrl: '',
  catalogAutoRefresh: true,
  searchSources: [],
  searchCacheTtlMinutes: 30,
  searchTimeoutMs: 8000,
}

class Store {
  root = ''

  get files() {
    return {
      config: path.join(this.root, 'config.json'),
      games: path.join(this.root, 'games.json'),
      library: path.join(this.root, 'library.json'),
      logs: path.join(this.root, 'logs.json'),
      backupsIndex: path.join(this.root, 'backups', 'index.json'),
      modsIndex: path.join(this.root, 'mods', 'index.json'),
      modProfiles: path.join(this.root, 'mods', 'profiles.json'),
      catalogCache: path.join(this.root, 'catalog', 'cache.json'),
      downloadsIndex: path.join(this.root, 'downloads', 'index.json'),
      /** 存档路径快照基线，按游戏 id 索引（用于启动前后差分定位） */
      saveSnapshots: path.join(this.root, 'saves', 'snapshots.json'),
      /** 在线检索聚合结果缓存 */
      searchCache: path.join(this.root, 'catalog', 'search-cache.json'),
    }
  }

  get dirs() {
    return {
      backups: path.join(this.root, 'backups'),
      mods: path.join(this.root, 'mods', 'files'),
      catalog: path.join(this.root, 'catalog'),
      downloads: path.join(this.root, 'downloads'),
      exports: path.join(this.root, 'exports'),
      staging: path.join(this.root, 'staging'),
      /** 游戏图标/封面缓存（PNG，按 gameId 命名） */
      icons: path.join(this.root, 'icons'),
    }
  }

  init(): void {
    this.root = path.join(app.getPath('userData'), 'data')
    ensureDir(this.root)
    for (const dir of Object.values(this.dirs)) ensureDir(dir)
    if (!fs.existsSync(this.files.config)) writeJson(this.files.config, DEFAULT_CONFIG)
  }

  read<T>(file: string, fallback: T): T {
    return readJson<T>(file, fallback)
  }

  write(file: string, data: unknown): void {
    writeJson(file, data)
  }

  config(): AppConfig {
    const raw = this.read<Partial<AppConfig>>(this.files.config, {})
    const merged = { ...DEFAULT_CONFIG, ...raw }
    // 旧版本 config.json 无该字段，做一次归一，避免 undefined 传到渲染层。
    if (!Array.isArray(merged.searchSources)) merged.searchSources = []
    if (typeof merged.searchCacheTtlMinutes !== 'number' || merged.searchCacheTtlMinutes <= 0) {
      merged.searchCacheTtlMinutes = DEFAULT_CONFIG.searchCacheTtlMinutes
    }
    if (typeof merged.searchTimeoutMs !== 'number' || merged.searchTimeoutMs <= 0) {
      merged.searchTimeoutMs = DEFAULT_CONFIG.searchTimeoutMs
    }
    // 首次读取（含从旧版本升级）注入内置预置源，随后落盘标记，保证用户删掉后不再加回。
    if (!raw.searchSourcesSeeded) {
      merged.searchSources = withPresets(merged.searchSources)
      merged.searchSourcesSeeded = true
      this.write(this.files.config, merged)
    }
    return merged
  }

  saveConfig(patch: Partial<AppConfig>): AppConfig {
    const next = { ...this.config(), ...patch }
    this.write(this.files.config, next)
    return next
  }

  games(): Game[] {
    const list = this.read<Game[]>(this.files.games, [])
    if (!Array.isArray(list)) return []
    // 旧版本 games.json 缺少图标与 Steam 匹配字段，统一补齐，避免 undefined 传到渲染层。
    return list.map((item) => ({
      ...item,
      aliases: Array.isArray(item.aliases) ? item.aliases : [],
      savePaths: Array.isArray(item.savePaths) ? item.savePaths : [],
      appid: typeof item.appid === 'string' ? item.appid : '',
      steamLibrary: typeof item.steamLibrary === 'string' ? item.steamLibrary : '',
      steamAppId: typeof item.steamAppId === 'string' ? item.steamAppId : '',
      storeUrl: typeof item.storeUrl === 'string' ? item.storeUrl : '',
      storeCoverUrl: typeof item.storeCoverUrl === 'string' ? item.storeCoverUrl : '',
      iconSource: typeof item.iconSource === 'string' ? item.iconSource : '',
      iconUpdatedAt: typeof item.iconUpdatedAt === 'string' ? item.iconUpdatedAt : '',
    }))
  }

  saveGames(list: Game[]): void {
    this.write(this.files.games, list)
  }

  library(): LibraryItem[] {
    return this.read<LibraryItem[]>(this.files.library, [])
  }

  saveLibrary(list: LibraryItem[]): void {
    this.write(this.files.library, list)
  }

  backups(): BackupEntry[] {
    return this.read<BackupEntry[]>(this.files.backupsIndex, [])
  }

  saveBackups(list: BackupEntry[]): void {
    this.write(this.files.backupsIndex, list)
  }

  mods(): ModEntry[] {
    return this.read<ModEntry[]>(this.files.modsIndex, [])
  }

  saveMods(list: ModEntry[]): void {
    this.write(this.files.modsIndex, list)
  }

  profiles(): ModProfile[] {
    return this.read<ModProfile[]>(this.files.modProfiles, [])
  }

  saveProfiles(list: ModProfile[]): void {
    this.write(this.files.modProfiles, list)
  }

  downloads(): DownloadTask[] {
    return this.read<DownloadTask[]>(this.files.downloadsIndex, [])
  }

  saveDownloads(list: DownloadTask[]): void {
    this.write(this.files.downloadsIndex, list)
  }

  logs(): LogEntry[] {
    return this.read<LogEntry[]>(this.files.logs, [])
  }

  saveLogs(list: LogEntry[]): void {
    this.write(this.files.logs, list)
  }

  /** 存档路径快照基线：{ [gameId]: SnapshotState } */
  saveSnapshots(map: Record<string, unknown>): void {
    this.write(this.files.saveSnapshots, map)
  }

  saveSnapshotFor(gameId: string, snapshot: unknown): void {
    const map = this.read<Record<string, unknown>>(this.files.saveSnapshots, {})
    map[gameId] = snapshot
    this.write(this.files.saveSnapshots, map)
  }

  snapshotFor<T>(gameId: string): T | null {
    const map = this.read<Record<string, T>>(this.files.saveSnapshots, {})
    return map[gameId] ?? null
  }

  clearSnapshotFor(gameId: string): void {
    const map = this.read<Record<string, unknown>>(this.files.saveSnapshots, {})
    if (gameId in map) {
      delete map[gameId]
      this.write(this.files.saveSnapshots, map)
    }
  }
}

export const store = new Store()
export { uid }
