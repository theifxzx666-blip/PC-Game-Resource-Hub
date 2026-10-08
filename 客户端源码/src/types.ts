// 渲染进程类型。字段与 electron/types.ts 一一对应，两边修改必须同步。

export type ResourceKind = '修改器' | '存档' | 'MOD' | '补丁'
export type ResourceStatus = '可用' | '待核实' | '不适配'
export type ResourceRisk = '低' | '中'

export interface Game {
  id: string
  name: string
  aliases: string[]
  dir: string
  savePaths: string[]
  source: 'steam' | 'manual'
  /** Steam 扫描得到的 appid；手动添加的游戏为空。 */
  appid: string
  steamLibrary: string
  version: string
  createdAt: string
  /** 「匹配 Steam 资料」得到的商店 appid。 */
  steamAppId: string
  /** 匹配到的 Steam 商店页地址。 */
  storeUrl: string
  /** 商店搜索返回的封面小图，作为图标兜底来源。 */
  storeCoverUrl: string
  /** 当前图标来源：steam-cover / steam-cdn / exe / cache / ''。 */
  iconSource: string
  /** 图标最后生成时间。 */
  iconUpdatedAt: string
}

/** Steam 商店搜索候选（games:steamSearch 返回）。 */
export interface SteamStoreCandidate {
  appid: string
  name: string
  image: string
  price: string
  metascore: string
  platforms: string
  storeUrl: string
}

/** 图标生成结果（games:refreshIcon / games:applySteamMatch 返回）。 */
export interface GameIconResult {
  dataUrl: string
  source: string
  generated: boolean
}

export interface BackupEntry {
  id: string
  gameId: string
  name: string
  note: string
  createdAt: string
  sizeBytes: number
  fileCount: number
  pinned: boolean
  relativePath: string
}

export interface DeployRecord {
  source: string
  target: string
  created: boolean
}

export interface ModEntry {
  id: string
  gameId: string
  name: string
  version: string
  type: string
  tags: string[]
  enabled: boolean
  importedAt: string
  installedAt: string
  sourceDir: string
  entryCount: number
  deployed: DeployRecord[]
}

export interface ModProfile {
  id: string
  gameId: string
  name: string
  enabled: string[]
  order: string[]
  createdAt: string
}

export interface CatalogResource {
  id: string
  title: string
  kind: ResourceKind
  gameName: string
  gameAliases: string[]
  version: string
  compatibleVersion: string
  gameVersion: string
  source: string
  status: ResourceStatus
  updatedAt: string
  description: string
  tags: string[]
  risk: ResourceRisk
  downloadUrl: string
  fileName: string
  homepage: string
}

export interface CatalogFile {
  version: string
  updatedAt: string
  resources: CatalogResource[]
}

export interface CatalogState {
  source: 'online' | 'cache' | 'offline'
  file: CatalogFile
  error: string
}

export interface LibraryItem {
  id: string
  resourceId: string
  title: string
  kind: ResourceKind
  gameName: string
  addedAt: string
}

/**
 * 在线检索数据源种类。
 * - `json` / `rss`：用户自建接口。
 * - `gamebanana`：GameBanana 公开 API（apiv11）。
 * - `github`：GitHub 公开 API（仓库搜索 / Release 列表）。
 */
export type SearchSourceKind = 'json' | 'rss' | 'gamebanana' | 'github'

export type SearchSourceState = '正常' | '失败' | '未启用' | '未测试'

/**
 * 在线检索数据源配置。
 * `url` 可含 `{keyword}` 占位符：检索时替换为当前关键词；关键词为空时该源被跳过。
 */
export interface SearchSource {
  id: string
  name: string
  kind: SearchSourceKind
  url: string
  enabled: boolean
  sourceLabel: string
  priority: number
  headers: string
  lastTestedAt: string
  lastState: SearchSourceState
  lastMessage: string
  /** 是否内置预置源。 */
  preset?: boolean
  /** 预置源说明：数据来源、许可与限流提示。 */
  presetNote?: string
}

export interface OnlineResource extends CatalogResource {
  sourceIds: string[]
  sourceNames: string[]
  multiSource: boolean
}

export interface SearchFacets {
  kinds: ResourceKind[]
  games: string[]
  sources: string[]
  statuses: ResourceStatus[]
  risks: ResourceRisk[]
  tags: string[]
}

export interface SourceStatus {
  id: string
  name: string
  kind: SearchSourceKind
  enabled: boolean
  ok: boolean
  count: number
  elapsedMs: number
  message: string
  /** 该源需先输入关键词才会发起请求，本次因关键词为空被跳过。 */
  keywordRequired?: boolean
}

export interface SearchResult {
  items: OnlineResource[]
  total: number
  page: number
  pageSize: number
  origin: 'online' | 'cache' | 'empty'
  cachedAt: string
  tookMs: number
  statuses: SourceStatus[]
  facets: SearchFacets
}

export interface SearchQuery {
  keyword?: string
  kind?: ResourceKind | '全部'
  game?: string
  source?: string
  status?: ResourceStatus | '全部'
  risk?: ResourceRisk | '全部'
  tag?: string
  onlyLibrary?: boolean
  sort?: 'relevance' | 'updated' | 'title' | 'source'
  page?: number
  pageSize?: number
}

export interface SourceTestResult {
  ok: boolean
  count: number
  elapsedMs: number
  message: string
  sampleTitles: string[]
}

export type DownloadStatus = '排队中' | '下载中' | '已完成' | '失败'

export interface DownloadTask {
  id: string
  resourceId: string
  title: string
  version: string
  url: string
  fileName: string
  dir: string
  status: DownloadStatus
  receivedBytes: number
  totalBytes: number
  error: string
  createdAt: string
  finishedAt: string
}

export interface LogEntry {
  id: string
  action: string
  target: string
  time: string
  status: '成功' | '失败'
  detail: string
}

export interface AppConfig {
  backupKeep: number
  archiveTool: string
  catalogBaseUrl: string
  catalogAutoRefresh: boolean
  searchSources: SearchSource[]
  searchCacheTtlMinutes: number
  searchTimeoutMs: number
  /** 是否已注入过内置预置源（缺失视为 false）。 */
  searchSourcesSeeded?: boolean
}

export interface ConflictItem {
  target: string
  modIds: string[]
  modNames: string[]
}

export interface PlanItem {
  source: string
  target: string
  overwrite: boolean
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }
