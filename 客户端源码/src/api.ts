import type {
  AppConfig,
  BackupEntry,
  CatalogResource,
  CatalogState,
  DownloadTask,
  Game,
  GameIconResult,
  IpcResult,
  LibraryItem,
  LogEntry,
  ModEntry,
  ModProfile,
  PlanItem,
  SearchQuery,
  SearchResult,
  SearchSource,
  SourceTestResult,
  SteamStoreCandidate,
} from './types'

export interface AppInfo {
  dataDir: string
  version: string
  packaged: boolean
  toolsDir: string
  toolsAvailable: boolean
}

export interface SteamScanResult {
  steamRoot: string
  detected: Game[]
  skipped: string[]
  added: number
}

export interface ModImportResult {
  imported: ModEntry[]
  failed: string[]
}

export interface UpdateItem {
  taskId: string
  title: string
  localVersion: string
  remoteVersion: string
}

/** 存档路径候选来源 */
export type SavePathOrigin =
  | 'known-rule'
  | 'game-name-dir'
  | 'appdata'
  | 'documents'
  | 'saved-games'
  | 'install-dir'
  | 'snapshot'

export interface SavePathCandidate {
  path: string
  origin: SavePathOrigin
  score: number
  exists: boolean
  fileCount: number
  sizeBytes: number
  lastModified: string
  reason: string
}

export interface SaveProbeResult {
  gameId: string
  candidates: SavePathCandidate[]
  scannedRoots: string[]
  skipped: string[]
}

export interface SaveSnapshotResult {
  capturedAt: string
  monitored: number
}

export interface SaveDiffItem {
  path: string
  fileCountDelta: number
  sizeBytesDelta: number
  modified: boolean
  score: number
  reason: string
}

export interface SaveDiffResult {
  capturedAt: string
  items: SaveDiffItem[]
}

export interface AppApi {
  info: () => Promise<IpcResult<AppInfo>>
  openPath: (target: string) => Promise<IpcResult<string>>
  openDataDir: () => Promise<IpcResult<string>>
  openExternal: (url: string) => Promise<IpcResult<void>>
  revealFile: (target: string) => Promise<IpcResult<boolean>>
  config: {
    get: () => Promise<IpcResult<AppConfig>>
    update: (patch: Partial<AppConfig>) => Promise<IpcResult<AppConfig>>
  }
  dialog: {
    pickDirectory: () => Promise<IpcResult<string>>
    pickFiles: (filters?: Array<{ name: string; extensions: string[] }>) => Promise<IpcResult<string[]>>
  }
  games: {
    list: () => Promise<IpcResult<Game[]>>
    scanSteam: () => Promise<IpcResult<SteamScanResult>>
    add: (payload: { name: string; dir: string; savePaths?: string[]; aliases?: string[] }) => Promise<IpcResult<Game>>
    update: (id: string, patch: Partial<Game>) => Promise<IpcResult<Game>>
    remove: (id: string) => Promise<IpcResult<boolean>>
    launch: (id: string) => Promise<IpcResult<string>>
    openDir: (id: string) => Promise<IpcResult<string>>
    icons: () => Promise<IpcResult<Record<string, string>>>
    refreshIcon: (id: string) => Promise<IpcResult<GameIconResult>>
    steamSearch: (term: string) => Promise<IpcResult<SteamStoreCandidate[]>>
    applySteamMatch: (
      id: string,
      payload: { appid: string; storeUrl?: string; coverUrl?: string },
    ) => Promise<IpcResult<{ game: Game; icon: GameIconResult }>>
  }
  saves: {
    list: (gameId?: string) => Promise<IpcResult<BackupEntry[]>>
    backup: (gameId: string, note?: string) => Promise<IpcResult<BackupEntry>>
    restore: (gameId: string, backupId: string) => Promise<IpcResult<{ autoBackupId: string; restored: string[] }>>
    remove: (gameId: string, backupId: string) => Promise<IpcResult<boolean>>
    pin: (gameId: string, backupId: string, pinned: boolean) => Promise<IpcResult<boolean>>
    inspect: (gameId: string, backupId: string) => Promise<IpcResult<{ total: number; files: string[] }>>
    export: (gameId: string, backupId: string) => Promise<IpcResult<string>>
    import: (file: string) => Promise<IpcResult<BackupEntry[]>>
    probePaths: (gameId: string) => Promise<IpcResult<SaveProbeResult>>
    snapshotTake: (gameId: string, dirs?: string[]) => Promise<IpcResult<SaveSnapshotResult>>
    snapshotDiff: (gameId: string, dirs?: string[]) => Promise<IpcResult<SaveDiffResult>>
  }
  mods: {
    list: (gameId?: string) => Promise<IpcResult<ModEntry[]>>
    import: (paths: string[], gameId: string) => Promise<IpcResult<ModImportResult>>
    plan: (modId: string) => Promise<IpcResult<{ items: PlanItem[]; overwriteCount: number }>>
    install: (modId: string) => Promise<IpcResult<ModEntry>>
    uninstall: (modId: string) => Promise<IpcResult<ModEntry>>
    setEnabled: (modId: string, enabled: boolean) => Promise<IpcResult<ModEntry>>
    remove: (modId: string) => Promise<IpcResult<boolean>>
    update: (modId: string, patch: Partial<ModEntry>) => Promise<IpcResult<ModEntry>>
    conflicts: (gameId: string) => Promise<IpcResult<Array<{ target: string; modIds: string[]; modNames: string[] }>>>
    profiles: {
      list: (gameId?: string) => Promise<IpcResult<ModProfile[]>>
      save: (gameId: string, name: string) => Promise<IpcResult<ModProfile>>
      apply: (profileId: string) => Promise<IpcResult<boolean>>
      remove: (profileId: string) => Promise<IpcResult<boolean>>
    }
  }
  catalog: {
    load: (force?: boolean) => Promise<IpcResult<CatalogState>>
    download: (resourceId: string) => Promise<IpcResult<DownloadTask>>
    downloads: () => Promise<IpcResult<DownloadTask[]>>
    removeDownload: (id: string) => Promise<IpcResult<boolean>>
    localImport: (paths: string[]) => Promise<IpcResult<DownloadTask[]>>
    checkUpdates: () => Promise<IpcResult<UpdateItem[]>>
  }
  search: {
    query: (query: SearchQuery, force?: boolean) => Promise<IpcResult<SearchResult>>
    sources: () => Promise<IpcResult<SearchSource[]>>
    testSource: (source: SearchSource) => Promise<IpcResult<SourceTestResult>>
    clearCache: () => Promise<IpcResult<boolean>>
    cacheMeta: () => Promise<IpcResult<{ capturedAt: string; count: number }>>
    enqueueDownload: (resource: CatalogResource) => Promise<IpcResult<DownloadTask>>
  }
  library: {
    list: () => Promise<IpcResult<LibraryItem[]>>
    add: (payload: { resourceId: string; title: string; kind: LibraryItem['kind']; gameName: string }) => Promise<IpcResult<LibraryItem[]>>
    remove: (resourceId: string) => Promise<IpcResult<boolean>>
  }
  logs: {
    list: (limit?: number) => Promise<IpcResult<LogEntry[]>>
    clear: () => Promise<IpcResult<boolean>>
  }
  onLog: (cb: (entry: LogEntry) => void) => () => void
  onDownloadProgress: (cb: (task: DownloadTask) => void) => () => void
}

declare global {
  interface Window {
    api: AppApi
  }
}

export const api: AppApi = window.api

/** 统一解包 IPC 结果：失败直接抛出，成功返回 data。 */
export async function call<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise
  if (!result || typeof result !== 'object' || !('ok' in result)) {
    throw new Error('主进程未返回有效结果，请重启应用。')
  }
  if (!result.ok) throw new Error(result.error)
  return result.data
}

export function shortPath(value: string, max = 48): string {
  if (!value) return ''
  return value.length <= max ? value : `…${value.slice(value.length - max + 1)}`
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
