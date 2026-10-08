// 主进程领域类型。渲染进程有一份镜像定义在 src/types.ts，两边字段必须保持一致。

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
  /** Steam 应用 id。Steam 扫描得到的游戏在此存 appid；手动添加的游戏留空。 */
  appid: string
  steamLibrary: string
  version: string
  createdAt: string
  /** 通过「匹配 Steam 资料」得到的商店 appid（手动添加的游戏用）。 */
  steamAppId: string
  /** 匹配到的 Steam 商店页地址。 */
  storeUrl: string
  /** 商店搜索返回的封面小图地址，作为图标兜底来源。 */
  storeCoverUrl: string
  /** 当前图标来源：steam-cover / steam-cdn / exe / cache / ''。 */
  iconSource: string
  /** 图标最后生成时间。 */
  iconUpdatedAt: string
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
 * - `json` / `rss`：用户自建接口，字段契约见 onlineSearch.ts 顶部注释。
 * - `gamebanana`：GameBanana 公开 API（apiv11），免鉴权，返回 `{ _aMetadata, _aRecords }` 信封。
 * - `github`：GitHub 公开 API，仓库搜索返回 `{ total_count, items }`，Release 列表返回数组。
 */
export type SearchSourceKind = 'json' | 'rss' | 'gamebanana' | 'github'

export type SearchSourceState = '正常' | '失败' | '未启用' | '未测试'

/**
 * 在线检索数据源配置。
 * - `json` 源：GET `url` 返回 `{ resources: [...] }`，字段与 CatalogResource 对齐（可宽松缺省）。
 * - `rss` 源：GET `url` 返回 RSS/Atom，条目映射为「待核实」资源，不含下载地址。
 * - `gamebanana` / `github` 源：由内置适配器把第三方返回结构映射到 CatalogResource。
 *
 * `url` 可含 `{keyword}` 占位符：检索时替换为当前关键词（URL 编码）。
 * 含占位符的源在关键词为空时会被跳过，且其结果不写入聚合缓存（因为结果随关键词变化）。
 */
export interface SearchSource {
  id: string
  name: string
  kind: SearchSourceKind
  url: string
  enabled: boolean
  /** 该源结果的默认来源标注，留空则用源名称。 */
  sourceLabel: string
  /** 优先级，数字越小越优先参与去重保留。 */
  priority: number
  /** 请求头，按行 `Key: Value` 维护。 */
  headers: string
  lastTestedAt: string
  lastState: SearchSourceState
  lastMessage: string
  /** 是否内置预置源：随应用提供，用户可停用或删除。 */
  preset?: boolean
  /** 预置源说明：数据来源、许可与限流提示，展示在设置页。 */
  presetNote?: string
}

/** 在线检索合并后的资源条目：CatalogResource 全字段 + 溯源信息。 */
export interface OnlineResource extends CatalogResource {
  /** 命中的源 id 列表（去重合并后可能多源命中）。 */
  sourceIds: string[]
  /** 展示用的来源名列表。 */
  sourceNames: string[]
  /** 是否为多源共同命中。 */
  multiSource: boolean
}

/** 检索结果分面：用于前端下拉筛选。 */
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
  /** 该源需先输入关键词才会发起请求（URL 含 {keyword}），本次因关键词为空被跳过。 */
  keywordRequired?: boolean
}

export interface SearchResult {
  items: OnlineResource[]
  /** 全量命中数（分页前）。 */
  total: number
  /** 当前页命中数。 */
  page: number
  pageSize: number
  /** 结果数据来源：online = 本次真实联网；cache = 命中本地缓存。 */
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
  /** 仅返回已入库游戏相关资源。 */
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
  /** 在线检索数据源列表。 */
  searchSources: SearchSource[]
  /** 在线检索缓存有效期（分钟）。 */
  searchCacheTtlMinutes: number
  /** 单个数据源请求超时（毫秒）。 */
  searchTimeoutMs: number
  /**
   * 是否已注入过内置预置源。
   * 缺失视为 false：首次读取配置时注入预置源并置为 true，之后即使用户删光也不再加回。
   */
  searchSourcesSeeded?: boolean
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }
