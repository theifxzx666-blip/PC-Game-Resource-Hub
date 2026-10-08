import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfig,
  BackupEntry,
  CatalogFile,
  CatalogResource,
  DownloadTask,
  Game,
  LibraryItem,
  LogEntry,
  ModEntry,
  ModProfile,
  SearchQuery,
  SearchSource,
  SearchResult,
  SourceTestResult,
} from './types.js'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

const api = {
  info: () => invoke('app:info'),
  openPath: (target: string) => invoke('app:openPath', target),
  openDataDir: () => invoke('app:openDataDir'),
  openExternal: (url: string) => invoke('app:openExternal', url),
  revealFile: (target: string) => invoke('app:revealFile', target),

  config: {
    get: () => invoke('config:get'),
    update: (patch: Partial<AppConfig>) => invoke('config:update', patch),
  },

  dialog: {
    pickDirectory: () => invoke<string>('dialog:pickDirectory'),
    pickFiles: (filters: Array<{ name: string; extensions: string[] }> = []) =>
      invoke<string[]>('dialog:pickFiles', filters),
  },

  games: {
    list: () => invoke<Game[]>('games:list'),
    scanSteam: () => invoke('games:scanSteam'),
    add: (payload: { name: string; dir: string; savePaths?: string[]; aliases?: string[] }) =>
      invoke<Game>('games:add', payload),
    update: (id: string, patch: Partial<Game>) => invoke<Game>('games:update', id, patch),
    remove: (id: string) => invoke('games:remove', id),
    launch: (id: string) => invoke<string>('games:launch', id),
    openDir: (id: string) => invoke('games:openDir', id),
    icons: () => invoke<Record<string, string>>('games:icons'),
    refreshIcon: (id: string) => invoke('games:refreshIcon', id),
    steamSearch: (term: string) => invoke('games:steamSearch', term),
    applySteamMatch: (id: string, payload: { appid: string; storeUrl?: string; coverUrl?: string }) =>
      invoke('games:applySteamMatch', id, payload),
  },

  saves: {
    list: (gameId?: string) => invoke<BackupEntry[]>('saves:list', gameId),
    backup: (gameId: string, note = '') => invoke<BackupEntry>('saves:backup', gameId, note),
    restore: (gameId: string, backupId: string) => invoke('saves:restore', gameId, backupId),
    remove: (gameId: string, backupId: string) => invoke('saves:remove', gameId, backupId),
    pin: (gameId: string, backupId: string, pinned: boolean) => invoke('saves:pin', gameId, backupId, pinned),
    inspect: (gameId: string, backupId: string) => invoke<{ total: number; files: string[] }>('saves:inspect', gameId, backupId),
    export: (gameId: string, backupId: string) => invoke<string>('saves:export', gameId, backupId),
    import: (file: string) => invoke<BackupEntry[]>('saves:import', file),
    probePaths: (gameId: string) => invoke('saves:probePaths', gameId),
    snapshotTake: (gameId: string, dirs?: string[]) => invoke('saves:snapshotTake', gameId, dirs),
    snapshotDiff: (gameId: string, dirs?: string[]) => invoke('saves:snapshotDiff', gameId, dirs),
  },

  mods: {
    list: (gameId?: string) => invoke<ModEntry[]>('mods:list', gameId),
    import: (paths: string[], gameId: string) => invoke('mods:import', paths, gameId),
    plan: (modId: string) => invoke('mods:plan', modId),
    install: (modId: string) => invoke<ModEntry>('mods:install', modId),
    uninstall: (modId: string) => invoke<ModEntry>('mods:uninstall', modId),
    setEnabled: (modId: string, enabled: boolean) => invoke<ModEntry>('mods:setEnabled', modId, enabled),
    remove: (modId: string) => invoke('mods:remove', modId),
    update: (modId: string, patch: Partial<ModEntry>) => invoke<ModEntry>('mods:update', modId, patch),
    conflicts: (gameId: string) => invoke('mods:conflicts', gameId),
    profiles: {
      list: (gameId?: string) => invoke<ModProfile[]>('mods:profiles:list', gameId),
      save: (gameId: string, name: string) => invoke<ModProfile>('mods:profiles:save', gameId, name),
      apply: (profileId: string) => invoke('mods:profiles:apply', profileId),
      remove: (profileId: string) => invoke('mods:profiles:delete', profileId),
    },
  },

  catalog: {
    load: (force = false) => invoke<{ source: string; file: CatalogFile; error: string }>('catalog:load', force),
    download: (resourceId: string) => invoke<DownloadTask>('catalog:download', resourceId),
    downloads: () => invoke<DownloadTask[]>('catalog:downloads'),
    removeDownload: (id: string) => invoke('catalog:removeDownload', id),
    localImport: (paths: string[]) => invoke<DownloadTask[]>('catalog:localImport', paths),
    checkUpdates: () => invoke('catalog:checkUpdates'),
  },

  search: {
    query: (query: SearchQuery, force = false) => invoke<SearchResult>('search:query', query, force),
    sources: () => invoke<SearchSource[]>('search:sources'),
    testSource: (source: SearchSource) => invoke<SourceTestResult>('search:testSource', source),
    clearCache: () => invoke('search:clearCache'),
    cacheMeta: () => invoke<{ capturedAt: string; count: number }>('search:cacheMeta'),
    enqueueDownload: (resource: CatalogResource) => invoke<DownloadTask>('search:enqueueDownload', resource),
  },

  library: {
    list: () => invoke<LibraryItem[]>('library:list'),
    add: (payload: { resourceId: string; title: string; kind: LibraryItem['kind']; gameName: string }) =>
      invoke<LibraryItem[]>('library:add', payload),
    remove: (resourceId: string) => invoke('library:remove', resourceId),
  },

  logs: {
    list: (limit = 100) => invoke<LogEntry[]>('logs:list', limit),
    clear: () => invoke('logs:clear'),
  },

  onLog: (cb: (entry: LogEntry) => void) => {
    const listener = (_event: unknown, entry: LogEntry) => cb(entry)
    ipcRenderer.on('log:append', listener)
    return () => ipcRenderer.off('log:append', listener)
  },
  onDownloadProgress: (cb: (task: DownloadTask) => void) => {
    const listener = (_event: unknown, task: DownloadTask) => cb(task)
    ipcRenderer.on('download:progress', listener)
    return () => ipcRenderer.off('download:progress', listener)
  },
}

contextBridge.exposeInMainWorld('api', api)
