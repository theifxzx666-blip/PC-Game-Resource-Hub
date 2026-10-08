import { reactive } from 'vue'
import { api, call } from './api'
import type {
  AppConfig,
  BackupEntry,
  CatalogState,
  ConflictItem,
  DownloadTask,
  Game,
  LibraryItem,
  LogEntry,
  ModEntry,
  ModProfile,
  SearchResult,
  SearchSource,
} from './types'

const EMPTY_SEARCH: SearchResult = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 24,
  origin: 'empty',
  cachedAt: '',
  tookMs: 0,
  statuses: [],
  facets: { kinds: [], games: [], sources: [], statuses: [], risks: [], tags: [] },
}

export const state = reactive({
  ready: false,
  info: { dataDir: '', version: '', packaged: false, toolsDir: '', toolsAvailable: false },
  config: {
    backupKeep: 5,
    archiveTool: '',
    catalogBaseUrl: '',
    catalogAutoRefresh: true,
    searchSources: [] as SearchSource[],
    searchCacheTtlMinutes: 30,
    searchTimeoutMs: 8000,
  } as AppConfig,
  games: [] as Game[],
  /** 游戏图标 dataURL 映射：{ [gameId]: 'data:image/png;base64,...' } */
  icons: {} as Record<string, string>,
  selectedGameId: '',
  backups: [] as BackupEntry[],
  mods: [] as ModEntry[],
  conflicts: [] as ConflictItem[],
  profiles: [] as ModProfile[],
  catalog: {
    source: 'offline',
    file: { version: '', updatedAt: '', resources: [] },
    error: '',
  } as CatalogState,
  search: { ...EMPTY_SEARCH } as SearchResult,
  searching: false,
  downloads: [] as DownloadTask[],
  library: [] as LibraryItem[],
  logs: [] as LogEntry[],
})

export function selectedGame(): Game | null {
  return state.games.find((item) => item.id === state.selectedGameId) ?? null
}

export function gameName(gameId: string): string {
  return state.games.find((item) => item.id === gameId)?.name ?? '未关联游戏'
}

export async function refreshGames(): Promise<void> {
  state.games = await call(api.games.list())
  if (!state.games.some((item) => item.id === state.selectedGameId)) {
    state.selectedGameId = state.games[0]?.id ?? ''
  }
}

/**
 * 拉取游戏图标（dataURL 映射）。命中磁盘缓存，只补齐缺失项。
 * 失败不抛错：图标属于装饰信息，不应阻断游戏库主流程。
 */
export async function refreshIcons(): Promise<void> {
  try {
    const icons = await call(api.games.icons())
    state.icons = { ...state.icons, ...icons }
  } catch {
    /* 图标缺失时界面退回首字母占位 */
  }
}

export async function refreshGameScoped(): Promise<void> {
  if (!state.selectedGameId) {
    state.backups = []
    state.mods = []
    state.conflicts = []
    state.profiles = []
    return
  }
  const gameId = state.selectedGameId
  const [backups, mods, conflicts, profiles] = await Promise.all([
    call(api.saves.list(gameId)),
    call(api.mods.list(gameId)),
    call(api.mods.conflicts(gameId)),
    call(api.mods.profiles.list(gameId)),
  ])
  state.backups = backups
  state.mods = mods
  state.conflicts = conflicts
  state.profiles = profiles
}

export async function refreshCatalog(force = false): Promise<void> {
  state.catalog = await call(api.catalog.load(force))
}

/** 执行一次在线聚合检索，结果写入 state.search。 */
export async function runSearch(query: Parameters<typeof api.search.query>[0], force = false): Promise<SearchResult> {
  state.searching = true
  try {
    const result = await call(api.search.query(query, force))
    state.search = result
    return result
  } finally {
    state.searching = false
  }
}

export async function refreshSearchSources(): Promise<SearchSource[]> {
  const sources = await call(api.search.sources())
  state.config.searchSources = sources
  return sources
}

export async function refreshDownloads(): Promise<void> {
  state.downloads = await call(api.catalog.downloads())
}

export async function refreshLibrary(): Promise<void> {
  state.library = await call(api.library.list())
}

export async function refreshLogs(): Promise<void> {
  state.logs = await call(api.logs.list(200))
}

export async function bootstrap(): Promise<void> {
  state.info = await call(api.info())
  state.config = await call(api.config.get())
  await refreshGames()
  void refreshIcons()
  await Promise.all([refreshLibrary(), refreshLogs(), refreshDownloads(), refreshCatalog(false)])
  await refreshGameScoped()
  if (state.config.catalogAutoRefresh) void refreshCatalog(true)
  void runSearch({ sort: 'relevance', page: 1 }).catch(() => undefined)
  state.ready = true
}

export function pushLog(entry: LogEntry): void {
  state.logs.unshift(entry)
  if (state.logs.length > 300) state.logs.length = 300
}

export function patchDownload(task: DownloadTask): void {
  const index = state.downloads.findIndex((item) => item.id === task.id)
  if (index === -1) state.downloads.unshift(task)
  else state.downloads[index] = task
}
