/**
 * 在线聚合检索。
 *
 * 设计原则：
 * 1. 不绑死单一后端：数据源是一份可增删改的配置列表（json / rss 两类），换源只改配置。
 * 2. 单源失败绝不影响整体：并发拉取，每源独立超时与错误隔离，失败只降级为该源 0 条 + 状态提示。
 * 3. 永远有结果：真实联网 → 本地缓存 → 内置离线目录，三级降级，界面不会空白。
 * 4. 只读检索：本模块不写任何用户目录，只维护自身数据目录下的缓存文件。
 *
 * 数据源契约：
 * - kind = 'json'：GET `url` → `{ version?, updatedAt?, resources: CatalogResource[] }`；
 *   也兼容裸数组 `CatalogResource[]`。字段宽松缺省，缺 id/title 的条目丢弃。
 * - kind = 'rss' ：GET `url` → RSS 2.0 或 Atom；条目映射为「待核实」资源，不提供下载地址。
 * - kind = 'gamebanana'：GET `url` → `{ _aMetadata, _aRecords: [...] }`（GameBanana apiv11 信封）。
 * - kind = 'github'：GET `url` → 仓库搜索 `{ total_count, items: [...] }` 或 Release 数组。
 *
 * 「kind 误标」容错：当 kind = json 但响应里出现 `_aRecords` / GitHub 信封时，
 * 会先做一次结构嗅探并改用对应适配器，避免可用数据被「契约不符」挡掉。
 * GameBanana 侧还会按 `_sModelName` 过滤掉文章/讨论/问答等非资源分区。
 *
 * `url` 可含 `{keyword}` 占位符：检索时替换为当前关键词（URL 编码）。
 * 含占位符的源在关键词为空时跳过，其结果不写入聚合缓存（结果随关键词变化）。
 *
 * 合规红线：本模块只做「检索与呈现」，不实现任何反作弊规避、DRM 绕过或破解分发能力；
 * 对状态非「可用」或风险非「低」的条目，界面侧必须给出显式提示。
 */
import { store } from './store.js'
import { offlineCatalog } from './offlineCatalog.js'
import {
  allTrainers,
  searchTrainers,
  trainersAvailable,
  trainersForGame,
} from './trainerLibrary.js'
import type { TrainerRecord } from './trainerLibrary.js'
import { nowText, uid, normKey, expandAlias } from './util.js'
import type {
  CatalogResource,
  OnlineResource,
  ResourceKind,
  ResourceRisk,
  ResourceStatus,
  SearchFacets,
  SearchQuery,
  SearchResult,
  SearchSource,
  SourceStatus,
  SourceTestResult,
} from './types.js'

interface CacheFile {
  capturedAt: string
  items: OnlineResource[]
}

const KIND_SET = new Set<ResourceKind>(['修改器', '存档', 'MOD', '补丁'])
const STATUS_SET = new Set<ResourceStatus>(['可用', '待核实', '不适配'])
const RISK_SET = new Set<ResourceRisk>(['低', '中'])

const DEFAULT_PAGE_SIZE = 24
const MAX_PAGE_SIZE = 120

/** 关键词占位符：地址中出现即表示该源需要关键词才发起请求。 */
const KEYWORD_TOKEN = '{keyword}'

/** 测试连通性时用于替换 {keyword} 的探测词，仅验证可达性与解析，不代表真实检索结果。 */
const PROBE_KEYWORD = 'game'

/**
 * 归一化文本，用于去重与关键词匹配。
 *
 * 不在此处自行实现：统一走 util.ts 的 normKey（主进程唯一真源）。
 * 原实现只剥 9 个标点，与存档路径库、游戏名比对的清洗口径不一致，
 * 会导致「同一资源在两个模块里算出两个键」——参考项目已踩过这个坑。
 */
const norm = normKey

function str(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback
  return String(value)
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => str(item)).filter(Boolean)
}

/** 把任意来源的原始条目归一成 CatalogResource，缺关键字段返回 null。 */
function coerceResource(raw: unknown, fallbackSource: string, fallbackKind?: ResourceKind): CatalogResource | null {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object') return null
  const title = str(r.title ?? r.name ?? r.displayName).trim()
  if (!title) return null
  const kindRaw = str(r.kind ?? r.type ?? fallbackKind ?? 'MOD') as ResourceKind
  const statusRaw = str(r.status ?? '待核实') as ResourceStatus
  const riskRaw = str(r.risk ?? r.riskLevel ?? '低') as ResourceRisk
  return {
    id: str(r.id ?? r.resourceId).trim() || `auto-${norm(title).slice(0, 24)}`,
    title,
    kind: KIND_SET.has(kindRaw) ? kindRaw : (fallbackKind ?? 'MOD'),
    gameName: str(r.gameName ?? r.game ?? '').trim(),
    gameAliases: strArray(r.gameAliases ?? r.aliases),
    version: str(r.version),
    compatibleVersion: str(r.compatibleVersion),
    gameVersion: str(r.gameVersion),
    source: str(r.source ?? r.author ?? fallbackSource).trim() || fallbackSource,
    status: STATUS_SET.has(statusRaw) ? statusRaw : '待核实',
    updatedAt: str(r.updatedAt ?? r.updated ?? r.pubDate ?? r.date),
    description: str(r.description ?? r.summary ?? r.desc).trim(),
    tags: strArray(r.tags ?? r.categories),
    risk: RISK_SET.has(riskRaw) ? riskRaw : '低',
    downloadUrl: str(r.downloadUrl ?? r.download ?? r.url ?? '').trim(),
    fileName: str(r.fileName),
    homepage: str(r.homepage ?? r.link ?? '').trim(),
  }
}

/** 解析 `Key: Value` 多行请求头。 */
function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of (text ?? '').split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key && value) out[key] = value
  }
  return out
}

/** 带超时的 fetch。使用 AbortController 保证单源卡死不会拖垮整轮检索。 */
async function fetchWithTimeout(url: string, timeoutMs: number, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      headers: { accept: 'application/json, application/rss+xml, application/atom+xml, */*', ...headers },
      signal: controller.signal,
      redirect: 'follow',
    })
  } finally {
    clearTimeout(timer)
  }
}

/** 极简 XML 取值：取出所有 <tag>...</tag> 的内容（兼容 CDATA）。 */
function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[1])
  return out
}

function xmlText(fragment: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
  const m = re.exec(fragment)
  if (!m) return ''
  return stripTags(m[1]).trim()
}

/** 取 <link href="..."/> 或 <link>...</link>。 */
function xmlLink(fragment: string): string {
  const attr = /<link[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i.exec(fragment)
  if (attr) return attr[1].trim()
  return xmlText(fragment, 'link')
}

function stripTags(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** 从 RSS/Atom 条目里猜资源类型，猜不出就归 MOD。 */
function guessKind(text: string): ResourceKind {
  const t = text.toLowerCase()
  if (/存档|save\s?file|savedata|补丁|patch|汉化|localization|translation/.test(t)) {
    if (/补丁|patch|汉化|localization|translation/.test(t)) return '补丁'
    return '存档'
  }
  if (/修改器|trainer|cheat|editor|修改工具/.test(t)) return '修改器'
  return 'MOD'
}

function parseRss(xml: string, sourceName: string): CatalogResource[] {
  const isAtom = /<feed[\s>]/i.test(xml.slice(0, 800))
  const blocks = isAtom ? xmlBlocks(xml, 'entry') : xmlBlocks(xml, 'item')
  const out: CatalogResource[] = []
  for (const block of blocks) {
    const title = stripTags(xmlText(block, 'title')).trim()
    if (!title) continue
    const link = xmlLink(block)
    const summary = stripTags(xmlText(block, 'description') || xmlText(block, 'summary') || xmlText(block, 'content')).trim()
    const updated = xmlText(block, 'pubDate') || xmlText(block, 'updated') || xmlText(block, 'published')
    const categories = xmlBlocks(block, 'category').map((c) => stripTags(c).trim()).filter(Boolean)
    out.push({
      id: `rss-${norm(title).slice(0, 32)}`,
      title: title.slice(0, 160),
      kind: guessKind(`${title} ${summary} ${categories.join(' ')}`),
      gameName: '',
      gameAliases: [],
      version: '',
      compatibleVersion: '',
      gameVersion: '',
      source: sourceName,
      status: '待核实',
      updatedAt: updated,
      description: summary.slice(0, 500),
      tags: categories.slice(0, 6),
      risk: '低',
      downloadUrl: '',
      fileName: '',
      homepage: link,
    })
  }
  return out
}

/**
 * 内容嗅探：按真实响应结构判断适配器。
 *
 * 存在的意义：`kind` 是配置项，用户完全可能在设置页把 GameBanana 源的类型点成「JSON 接口」，
 * 或自定义源直接返回第三方信封。此时若死抠 kind，就会出现
 * 「返回结构与契约不符：未找到 resources / items / data 数组」而把本来可用的数据挡在门外。
 * 这里做一次结构嗅探，把误标的源接回正确的适配器。
 */
function sniffPayload(payload: unknown): 'gamebanana' | 'github' | null {
  if (Array.isArray(payload)) {
    const first = payload[0] as Record<string, unknown> | undefined
    if (first && typeof first === 'object' && (first.tag_name !== undefined || Array.isArray(first.assets))) {
      return 'github'
    }
    return null
  }
  const p = payload as Record<string, unknown> | null
  if (!p || typeof p !== 'object') return null
  if (Array.isArray((p as Record<string, unknown>)._aRecords)) return 'gamebanana'
  const items = (p as Record<string, unknown>).items
  if (Array.isArray(items) && (p as Record<string, unknown>).total_count !== undefined) {
    const first = items[0] as Record<string, unknown> | undefined
    if (first && typeof first.full_name === 'string') return 'github'
  }
  return null
}

function parseJson(payload: unknown, sourceName: string): CatalogResource[] {
  const rawList: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as Record<string, unknown>)?.resources)
      ? ((payload as Record<string, unknown>).resources as unknown[])
      : Array.isArray((payload as Record<string, unknown>)?.items)
        ? ((payload as Record<string, unknown>).items as unknown[])
        : Array.isArray((payload as Record<string, unknown>)?.data)
          ? ((payload as Record<string, unknown>).data as unknown[])
          : []
  if (rawList.length === 0) {
    const preview = JSON.stringify(payload ?? null).slice(0, 120)
    throw new Error(`返回结构与契约不符：未找到 resources / items / data 数组（实际：${preview}）`)
  }
  return rawList.map((item) => coerceResource(item, sourceName)).filter((item): item is CatalogResource => item !== null)
}

/** GameBanana 的时间字段是 Unix 秒，统一转成 YYYY-MM-DD。 */
function fromUnixSeconds(value: unknown): string {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 取 ISO 8601 时间的前 10 位（GitHub 的 published_at / pushed_at）。 */
function isoDate(value: unknown): string {
  const text = str(value)
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : ''
}

/**
 * GameBanana 中不属于「可下载资源」的分区。
 * 实测 `_aMetadata._aSectionMatchCounts` 给出的 26 个分区里，这些是文章/讨论/问答/概念稿一类，
 * 混进结果会让「资源中心」出现大量不可下载的噪音，因此直接过滤。
 */
const GB_NON_RESOURCE = new Set([
  'Article',
  'Bug',
  'Blog',
  'Club',
  'Concept',
  'Game',
  'Idea',
  'Jam',
  'Member',
  'News',
  'Poll',
  'Project',
  'Question',
  'Review',
  'Request',
  'Studio',
  'Thread',
  'Tutorial',
  'Wip',
])

/** GameBanana 的 `_sModelName` → 统一资源类型。 */
function gameBananaKind(modelName: string, text: string): ResourceKind {
  const model = modelName.toLowerCase()
  if (model === 'tool' || model === 'executable' || model === 'application') return '修改器'
  if (['mod', 'sound', 'spray', 'model', 'skin', 'gui', 'map', 'material', 'particle'].includes(model)) return 'MOD'
  return guessKind(text)
}

/**
 * GameBanana apiv11 记录 → CatalogResource。
 * 字段名以下划线前缀为准（实测响应结构，见 presetSources.ts 顶部说明）。
 * 检索接口不返回文件直链，因此 downloadUrl 留空，引导用户回源站下载。
 */
function parseGameBanana(payload: unknown, sourceName: string): CatalogResource[] {
  const envelope = payload as Record<string, any> | null
  const records = envelope?._aRecords

  if (!Array.isArray(records)) {
    // 兜底一：万一是别的信封（自定义 JSON），交给通用解析器再试一次。
    const fallback = envelope?.resources ?? envelope?.items ?? envelope?.data
    if (Array.isArray(fallback)) {
      return fallback.map((item) => coerceResource(item, sourceName)).filter((item): item is CatalogResource => item !== null)
    }
    // 兜底二：给出可操作的准确报错，而不是含糊的「契约不符」。
    if (Array.isArray(envelope?._aMetadata?._aSectionMatchCounts)) {
      throw new Error('GameBanana 返回的是「分区汇总」而不是条目列表，请在地址里补 `_sModelName=Mod` 指定分区后重试。')
    }
    throw new Error('返回结构与 GameBanana 契约不符：未找到 _aRecords 数组。')
  }

  const out: CatalogResource[] = []
  for (const raw of records) {
    const record = raw as Record<string, any>
    const model = str(record._sModelName).trim()
    if (GB_NON_RESOURCE.has(model)) continue
    const title = str(record._sName).trim()
    if (!title) continue

    const rootCategory = str(record._aRootCategory?._sName).trim()
    const subCategory = str(record._aSubCategory?._sName).trim()
    const rawTags = Array.isArray(record._aTags) ? record._aTags.map((tag: unknown) => str(tag).trim()) : []
    const tags = [...new Set([rootCategory, subCategory, ...rawTags].filter(Boolean))].slice(0, 6)

    const obsolete = record._bIsObsolete === true
    const hasFiles = record._bHasFiles === true
    const notes: string[] = []
    if (tags.length > 0) notes.push(`GameBanana 分类：${[rootCategory, subCategory].filter(Boolean).join(' / ')}`)
    if (!hasFiles) notes.push('源站标记该条目没有附件文件')
    if (obsolete) notes.push('源站标记为已停更')

    out.push({
      id: `gb-${str(record._idRow) || norm(title).slice(0, 24)}`,
      title: title.slice(0, 160),
      kind: gameBananaKind(model, `${title} ${tags.join(' ')}`),
      gameName: str(record._aGame?._sName).trim(),
      gameAliases: [],
      version: str(record._sVersion).trim(),
      compatibleVersion: '',
      gameVersion: '',
      source: str(record._aSubmitter?._sName).trim() || sourceName,
      status: obsolete ? '不适配' : '待核实',
      updatedAt: fromUnixSeconds(record._tsDateUpdated ?? record._tsDateModified ?? record._tsDateAdded),
      description: notes.join('；'),
      tags,
      risk: record._bHasContentRatings === true ? '中' : '低',
      downloadUrl: '',
      fileName: '',
      homepage: str(record._sProfileUrl).trim(),
    })
  }
  return out
}

/**
 * GitHub 公开 API 响应 → CatalogResource。
 * 兼容两种形态：仓库搜索 `{ total_count, items: [...] }` 与 Release 列表 `[...]`。
 * 仓库搜索只给项目主页（无直链）；Release 形态取第一个资产的直链作为下载地址。
 */
function parseGitHub(payload: unknown, sourceName: string): CatalogResource[] {
  if (Array.isArray(payload)) {
    return (payload as Array<Record<string, any>>).map((release) => {
      const htmlUrl = str(release.html_url).trim()
      const assets = Array.isArray(release.assets) ? release.assets : []
      const first = assets.find((asset: Record<string, any>) => str(asset?.browser_download_url).trim())
      const tag = str(release.tag_name).trim()
      return {
        id: `gh-rel-${str(release.id) || norm(htmlUrl).slice(0, 24)}`,
        title: (str(release.name).trim() || (tag ? `${repoFromUrl(htmlUrl)} ${tag}` : htmlUrl)).slice(0, 160),
        kind: guessKind(`${release.name ?? ''} ${release.body ?? ''} ${tag}`),
        gameName: '',
        gameAliases: [],
        version: tag,
        compatibleVersion: '',
        gameVersion: '',
        source: str(release.author?.login).trim() || sourceName,
        status: '待核实',
        updatedAt: isoDate(release.published_at),
        description: stripTags(str(release.body)).replace(/\s+/g, ' ').slice(0, 400),
        tags: first ? [str(first.name).trim()].filter(Boolean) : [],
        risk: release.prerelease === true ? '中' : '低',
        downloadUrl: first ? str(first.browser_download_url).trim() : '',
        fileName: first ? str(first.name).trim() : '',
        homepage: htmlUrl,
      } satisfies CatalogResource
    })
  }

  const items = (payload as Record<string, unknown> | null)?.items
  if (Array.isArray(items)) {
    return (items as Array<Record<string, any>>)
      .map((repo): CatalogResource | null => {
        const fullName = str(repo.full_name).trim()
        if (!fullName) return null
        const license = str(repo.license?.spdx_id).trim()
        const tags = Array.isArray(repo.topics) ? strArray(repo.topics).slice(0, 6) : []
        return {
          id: `gh-repo-${str(repo.id) || norm(fullName).slice(0, 24)}`,
          title: fullName.slice(0, 160),
          kind: guessKind(`${fullName} ${repo.description ?? ''} ${tags.join(' ')}`),
          gameName: '',
          gameAliases: [],
          version: '',
          compatibleVersion: '',
          gameVersion: '',
          source: str(repo.owner?.login).trim() || sourceName,
          status: '待核实',
          updatedAt: isoDate(repo.pushed_at ?? repo.updated_at),
          description: `${str(repo.description).trim()}${license ? ` · 许可 ${license}` : ''} · ★ ${Number(repo.stargazers_count) || 0}`.slice(0, 400),
          tags,
          risk: '低',
          downloadUrl: '',
          fileName: '',
          homepage: str(repo.html_url).trim(),
        } satisfies CatalogResource
      })
      .filter((item): item is CatalogResource => item !== null)
  }

  throw new Error('返回结构与 GitHub 契约不符：既不是仓库搜索的 items 数组，也不是 Release 数组。')
}

/** 从 `https://github.com/owner/repo/releases/tag/v1` 里取出 `owner/repo`。 */
function repoFromUrl(url: string): string {
  const match = /^https?:\/\/github\.com\/([^/]+\/[^/]+)/.exec(url)
  return match ? match[1] : 'Release'
}

/** 把地址模板里的 `{keyword}` 换成 URL 编码后的关键词。 */
function resolveUrl(template: string, keyword: string): string {
  return template.split(KEYWORD_TOKEN).join(encodeURIComponent(keyword))
}

/** 按数据源类型选择解析策略，统一产出 CatalogResource[]。 */
function parseByKind(source: SearchSource, text: string): CatalogResource[] {
  const label = source.sourceLabel || source.name
  switch (source.kind) {
    case 'rss':
      return parseRss(text, label)
    case 'gamebanana':
      return parseGameBanana(safeJson(text), label)
    case 'github':
      return parseGitHub(safeJson(text), label)
    default: {
      const payload = safeJson(text)
      // 先嗅探真实结构，兼容「kind 被误标成 JSON 接口」的第三方源。
      const sniffed = sniffPayload(payload)
      if (sniffed === 'gamebanana') return parseGameBanana(payload, label)
      if (sniffed === 'github') return parseGitHub(payload, label)
      return parseJson(payload, label)
    }
  }
}

/** 拉取单个数据源。返回条目与耗时；异常向上抛，由调用方隔离。 */
async function fetchSource(source: SearchSource, timeoutMs: number, keyword: string): Promise<{ items: CatalogResource[]; elapsedMs: number }> {
  const started = Date.now()
  const headers = parseHeaders(source.headers)
  const res = await fetchWithTimeout(resolveUrl(source.url, keyword), timeoutMs, headers)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim())
  const text = await res.text()
  if (!text.trim()) throw new Error('响应内容为空。')
  return { items: parseByKind(source, text), elapsedMs: Date.now() - started }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`响应不是合法 JSON：${(error as Error).message}`)
  }
}

/** 跨源去重合并：同一资源多源命中时合并 sourceIds / sourceNames。 */
function mergeResources(entries: Array<{ resource: CatalogResource; sourceId: string; sourceName: string; priority: number }>): OnlineResource[] {
  const map = new Map<string, { item: OnlineResource; priority: number; order: number }>()
  let order = 0
  for (const entry of entries) {
    const { resource, sourceId, sourceName, priority } = entry
    const key = resource.id || norm(`${resource.title}|${resource.gameName}`)
    const existing = map.get(key)
    if (!existing) {
      map.set(key, {
        item: {
          ...resource,
          sourceIds: [sourceId],
          sourceNames: [sourceName],
          multiSource: false,
        },
        priority,
        order: order++,
      })
      continue
    }
    if (!existing.item.sourceIds.includes(sourceId)) {
      existing.item.sourceIds.push(sourceId)
      existing.item.sourceNames.push(sourceName)
      existing.item.multiSource = existing.item.sourceIds.length > 1
    }
    // 高优先级源补齐缺失字段（低优先级不覆盖已有非空值）。
    if (priority < existing.priority) {
      const cur = existing.item
      const patch: Partial<OnlineResource> = {}
      if (!cur.downloadUrl && resource.downloadUrl) patch.downloadUrl = resource.downloadUrl
      if (!cur.fileName && resource.fileName) patch.fileName = resource.fileName
      if (!cur.homepage && resource.homepage) patch.homepage = resource.homepage
      if (!cur.description && resource.description) patch.description = resource.description
      if (!cur.version && resource.version) patch.version = resource.version
      if (!cur.compatibleVersion && resource.compatibleVersion) patch.compatibleVersion = resource.compatibleVersion
      if (!cur.gameName && resource.gameName) patch.gameName = resource.gameName
      if (!cur.updatedAt && resource.updatedAt) patch.updatedAt = resource.updatedAt
      if (resource.status === '可用' && cur.status !== '可用') patch.status = '可用'
      if (cur.tags.length === 0 && resource.tags.length > 0) patch.tags = resource.tags
      if (cur.gameAliases.length === 0 && resource.gameAliases.length > 0) patch.gameAliases = resource.gameAliases
      Object.assign(cur, patch)
      existing.priority = priority
    }
  }
  return [...map.values()].sort((a, b) => a.order - b.order).map((entry) => entry.item)
}

/**
 * 合并多批已归并结果（例如「静态源缓存」+「关键词源实时结果」）。
 * 同 id（或标题+游戏名）只保留先出现的主体，补齐空字段并累积溯源信息。
 */
function mergeOnline(lists: OnlineResource[][]): OnlineResource[] {
  const map = new Map<string, OnlineResource>()
  for (const list of lists) {
    for (const item of list) {
      const key = item.id || norm(`${item.title}|${item.gameName}`)
      const current = map.get(key)
      if (!current) {
        map.set(key, item)
        continue
      }
      item.sourceIds.forEach((sourceId, index) => {
        if (!current.sourceIds.includes(sourceId)) {
          current.sourceIds.push(sourceId)
          current.sourceNames.push(item.sourceNames[index] ?? sourceId)
        }
      })
      current.multiSource = current.sourceIds.length > 1
      if (!current.downloadUrl && item.downloadUrl) current.downloadUrl = item.downloadUrl
      if (!current.fileName && item.fileName) current.fileName = item.fileName
      if (!current.homepage && item.homepage) current.homepage = item.homepage
      if (!current.description && item.description) current.description = item.description
      if (!current.gameName && item.gameName) current.gameName = item.gameName
      if (!current.version && item.version) current.version = item.version
      if (!current.updatedAt && item.updatedAt) current.updatedAt = item.updatedAt
      if (current.tags.length === 0 && item.tags.length > 0) current.tags = item.tags
      if (item.status === '可用' && current.status !== '可用') current.status = '可用'
    }
  }
  return [...map.values()]
}

function readSearchCache(): CacheFile | null {
  return store.read<CacheFile | null>(store.files.searchCache, null)
}

function writeSearchCache(items: OnlineResource[], capturedAt: string): void {
  store.write(store.files.searchCache, { capturedAt, items } satisfies CacheFile)
}

function cacheFresh(cache: CacheFile | null, ttlMinutes: number): boolean {
  if (!cache?.capturedAt) return false
  const ts = Date.parse(cache.capturedAt.replace(' ', 'T'))
  if (Number.isNaN(ts)) return false
  return Date.now() - ts <= ttlMinutes * 60_000
}

/** 把内置离线目录转成带溯源信息的 OnlineResource，作为最终兜底。 */
function offlineAsOnline(): OnlineResource[] {
  return offlineCatalog.resources.map((resource) => ({
    ...resource,
    sourceIds: ['offline'],
    sourceNames: ['内置离线数据'],
    multiSource: false,
  }))
}

/**
 * 内置修改器 / MOD 元数据知识库 → OnlineResource。
 *
 * 与 offlineCatalog 的区别：offlineCatalog 是 5 条演示数据，
 * 这是 8943 条真实元数据（机地社区帖离线快照）。
 * 只走元数据：downloadUrl 恒空，homepage 指向来源帖。
 *
 * ★ 截断顺序很关键。
 *
 * `searchTrainers` 是按**数据集文件顺序**扫到 limit 条就 break 的，
 * 先截断再交给 relevance 排序 —— 这样一旦某个游戏有几百条条目
 * （实测「星露谷物语」348 条、「赛博朋克2077」719 条，
 * 散落在文件各处），排在文件后面的高相关条目（例如标题就叫
 * 「星露谷物语 中文版」的那种）可能在截断时就丢了，根本没机会参与打分。
 *
 * 这里改成：
 *   1. 先用别名表把输入展开成候选名（「Stardew Valley」→「星露谷物语」）；
 *   2. 按候选名走 nameIndex 把整款游戏的条目整体捞出（O(1)，不截断）；
 *   3. 再用关键词补扫全库（上限放宽到 SCAN_LIMIT）；
 *   4. 合并去重后才交给 relevance 打分。
 *
 * 于是截断截的是「低相关」的尾部，而不是「文件顺序靠后」的条目。
 */

/**
 * 模糊补扫上限。
 * 实测单游戏最大条目数 719（赛博朋克2077），取 1500 有充分余量；
 * 再大没有意义 —— 全网 8943 条，一个关键词能命中的量级就是这个数。
 */
const SCAN_LIMIT = 1500

/**
 * 单次检索最多带回的知识库条目数。
 *
 * 这是**硬上限**，防的是病态输入（比如关键词是「a」这种单字，
 * 补扫可能命中数千条）把整包数据一次性塞进渲染层。
 * 正常情况下「整款游戏的条目」远小于此值：
 *   精确命中走 nameIndex 拿到的是该游戏全部条目（最大 719），
 *   加补扫后实测最大约 780（赛博朋克2077），都在限内。
 */
const LIBRARY_LIMIT = 1200

function libraryAsOnline(keyword: string, limit = LIBRARY_LIMIT): OnlineResource[] {
  if (!trainersAvailable()) return []

  const kw = (keyword ?? '').trim()
  if (!kw) {
    // 无关键词：取前 N 条，「刚进页面先给点东西看」。不查库避免铺 8943 条。
    return allTrainers()
      .slice(0, Math.min(limit, 400))
      .map(toLibraryResource)
  }

  // 0) 别名展开：输入可能是俗称 / 英文名，知识库里只收中文正式名。
  //    例：「Stardew Valley」/「大表哥2」/「泰拉」/「MC」。
  const candidates = expandAlias(kw)

  // 1) 候选名精确命中：整款游戏的条目一次性拿到（不截断）。
  const matched: TrainerRecord[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    for (const record of trainersForGame(candidate)) {
      if (seen.has(record.id)) continue
      seen.add(record.id)
      matched.push(record)
    }
  }

  // 2) 关键词补扫：原文与展开名都扫，覆盖「描述/标签里提到但对不上游戏名」的情况。
  //    精确命中已占额度时不再补扫，避免病态关键词把上限吃满。
  for (const candidate of candidates) {
    if (matched.length >= limit) break
    for (const record of searchTrainers(candidate, [], SCAN_LIMIT)) {
      if (matched.length >= limit) break
      if (seen.has(record.id)) continue
      seen.add(record.id)
      matched.push(record)
    }
  }

  return matched.map(toLibraryResource)
}

/** TrainerRecord → OnlineResource（补溯源信息）。 */
function toLibraryResource(record: TrainerRecord): OnlineResource {
  return {
    ...record,
    sourceIds: ['trainer-lib'],
    sourceNames: ['修改器知识库'],
    multiSource: false,
  }
}

/**
 * 离线兜底：关键词优先命中知识库，无关键词给前 N 条，最后才退演示目录。
 * 目的是「界面永远不空白」。
 */
function fallbackOffline(keyword: string): OnlineResource[] {
  const bulk = libraryAsOnline(keyword)
  if (bulk.length > 0) return bulk
  return offlineAsOnline()
}

/** 并发拉取给定数据源，返回合并结果与逐源状态。 */
async function pullAll(sources: SearchSource[], timeoutMs: number, keyword: string): Promise<{ items: OnlineResource[]; statuses: SourceStatus[] }> {
  const enabled = sources.filter((source) => source.enabled && source.url.trim())
  if (enabled.length === 0) return { items: [], statuses: [] }

  const settled = await Promise.allSettled(
    enabled.map(async (source) => ({ source, ...(await fetchSource(source, timeoutMs, keyword)) })),
  )

  const flat: Array<{ resource: CatalogResource; sourceId: string; sourceName: string; priority: number }> = []
  const statuses: SourceStatus[] = []

  settled.forEach((result, index) => {
    const source = enabled[index]
    if (result.status === 'fulfilled') {
      const { items, elapsedMs } = result.value
      for (const resource of items) {
        flat.push({ resource, sourceId: source.id, sourceName: source.sourceLabel || source.name, priority: source.priority })
      }
      statuses.push({
        id: source.id,
        name: source.name,
        kind: source.kind,
        enabled: true,
        ok: true,
        count: items.length,
        elapsedMs,
        message: items.length === 0 ? '请求成功但未解析到条目，请核对字段契约。' : '',
      })
    } else {
      const reason = result.reason as Error
      statuses.push({
        id: source.id,
        name: source.name,
        kind: source.kind,
        enabled: true,
        ok: false,
        count: 0,
        elapsedMs: 0,
        message: reason?.name === 'AbortError' ? `请求超时（>${timeoutMs} ms）` : (reason?.message ?? '未知错误'),
      })
    }
  })

  return { items: mergeResources(flat), statuses }
}

function buildFacets(items: OnlineResource[]): SearchFacets {
  const kinds = new Set<ResourceKind>()
  const games = new Set<string>()
  const sources = new Set<string>()
  const statuses = new Set<ResourceStatus>()
  const risks = new Set<ResourceRisk>()
  const tags = new Set<string>()
  for (const item of items) {
    kinds.add(item.kind)
    if (item.gameName) games.add(item.gameName)
    if (item.source) sources.add(item.source)
    statuses.add(item.status)
    risks.add(item.risk)
    for (const tag of item.tags) if (tag) tags.add(tag)
  }
  return {
    kinds: [...kinds],
    games: [...games].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    sources: [...sources].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    statuses: [...statuses],
    risks: [...risks],
    tags: [...tags].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')).slice(0, 40),
  }
}

/**
 * 相关性打分。
 *
 * 权重设计的关键：**「游戏名精确命中」必须压过「标题里恰好含这个词」**。
 *
 * 反例（实测）：搜「星露谷物语」时，GitHub 上「星露谷物语复刻版」「MOD 安装器」
 * 这类项目的**仓库名/描述里含「星露谷物语」**，按旧的标题权重（60~120）会排到
 * 知识库里 348 条真正的星露谷 MOD（游戏名命中仅 40 分）前面 —— 用户想找的是
 * 星露谷的资源，不是关于星露谷的项目。
 *
 * 新权重：
 *   游戏名完全相等         200  ← 最强信号：这条资源就是这款游戏的
 *   别名完全相等           180
 *   游戏名以关键词开头      120
 *   游戏名包含关键词        100
 *   标题完全相等            90
 *   标题以关键词开头        70
 *   标题包含关键词          50
 *
 * ★ 别名展开：关键词可能是俗称/英文名（「Stardew Valley」「大表哥2」），
 *   而资源的 gameName 用的是中文正式名。此时直接比 normKey 全是 0 分，
 *   必须先把关键词展开成候选名集合再比对，否则英文名搜索必然排不准。
 *   展开后的正式名视为「同一款游戏」，给 200 分（与精确命中同级）。
 */
function relevance(item: OnlineResource, keyword: string): number {
  const kw = norm(keyword)
  if (!kw) return 0
  let score = 0

  // 关键词 + 别名展开后的全部候选（都经过归一化）
  const keys = expandAlias(keyword).map(norm).filter(Boolean)
  const anyKey = (test: (key: string) => boolean): boolean => keys.some(test)

  // 游戏名 / 别名：精确 > 前缀 > 包含
  const name = norm(item.gameName)
  if (name && anyKey((key) => name === key)) score += 200
  else if (name && anyKey((key) => name.startsWith(key))) score += 120
  else if (name && anyKey((key) => name.includes(key))) score += 100

  const aliases = item.gameAliases.map(norm).filter(Boolean)
  if (aliases.some((alias) => keys.includes(alias))) score += 180
  else if (aliases.some((alias) => anyKey((key) => alias.startsWith(key)))) score += 110
  else if (aliases.some((alias) => anyKey((key) => alias.includes(key)))) score += 90

  // 标题：作为补充信号，权重低于游戏名精确命中
  const title = norm(item.title)
  if (title === kw) score += 90
  else if (title.startsWith(kw)) score += 70
  else if (title.includes(kw)) score += 50

  if (item.tags.some((tag) => norm(tag).includes(kw))) score += 20
  if (norm(item.source).includes(kw)) score += 12
  if (norm(item.description).includes(kw)) score += 10
  if (item.status === '可用') score += 6
  if (item.risk === '低') score += 3
  if (item.downloadUrl) score += 4
  return score
}

function matches(item: OnlineResource, query: SearchQuery, libraryGameNames: Set<string>): boolean {
  const kw = norm(query.keyword ?? '')
  if (kw) {
    // ★ 别名展开后再做 haystack 判定。
    //   搜「Stardew Valley」时知识库条目的游戏名是「星露谷物语」，
    //   只比对原文会全被过滤掉 —— 展开成候选名后才有命中机会。
    const keys = expandAlias(query.keyword ?? '')
      .map(norm)
      .filter((key) => key.length >= 1)
    const haystack = [
      item.title,
      item.gameName,
      ...item.gameAliases,
      item.source,
      item.version,
      item.compatibleVersion,
      item.gameVersion,
      item.description,
      ...item.tags,
      ...item.sourceNames,
    ]
      .map(norm)
      .join(' ')
    if (!keys.some((key) => haystack.includes(key))) return false
  }
  if (query.kind && query.kind !== '全部' && item.kind !== query.kind) return false
  if (query.game && query.game !== '全部' && item.gameName !== query.game) return false
  if (query.source && query.source !== '全部' && item.source !== query.source) return false
  if (query.status && query.status !== '全部' && item.status !== query.status) return false
  if (query.risk && query.risk !== '全部' && item.risk !== query.risk) return false
  if (query.tag && query.tag !== '全部' && !item.tags.includes(query.tag)) return false
  if (query.onlyLibrary) {
    const names = [norm(item.gameName), ...item.gameAliases.map(norm)].filter(Boolean)
    if (!names.some((name) => libraryGameNames.has(name))) return false
  }
  return true
}

function sortItems(items: OnlineResource[], sort: SearchQuery['sort'], keyword: string): OnlineResource[] {
  const list = [...items]
  switch (sort) {
    case 'updated':
      return list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    case 'title':
      return list.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
    case 'source':
      return list.sort((a, b) => a.source.localeCompare(b.source, 'zh-Hans-CN'))
    default:
      return list.sort((a, b) => relevance(b, keyword) - relevance(a, keyword) || a.title.localeCompare(b.title, 'zh-Hans-CN'))
  }
}

export interface SearchOptions {
  /** 忽略缓存，强制真实联网。 */
  force?: boolean
}

/**
 * 执行在线聚合检索。
 *
 * 降级与缓存策略：
 * - 不含 `{keyword}` 的「静态源」：真实联网 → 本地聚合缓存（TTL 内不发请求）→ 内置离线目录。
 * - 含 `{keyword}` 的「关键词源」：每次检索按当前关键词实时拉取，**不写入缓存**（结果随关键词变化）。
 * - 两类结果合并去重后统一筛选、排序、分页。
 */
export async function searchOnline(query: SearchQuery, options: SearchOptions = {}): Promise<SearchResult> {
  const config = store.config()
  const sources = config.searchSources ?? []
  const timeoutMs = config.searchTimeoutMs || 8000
  const ttl = config.searchCacheTtlMinutes || 30
  const keyword = (query.keyword ?? '').trim()
  const started = Date.now()

  const enabled = sources.filter((source) => source.enabled && source.url.trim())
  const cache = readSearchCache()

  let pool: OnlineResource[] = []
  let statuses: SourceStatus[] = []
  let live = false
  let cachedAt = ''

  if (enabled.length === 0) {
    // 未配置任何数据源：用旧式单目录接口 + 内置知识库兜底，保证界面可用。
    const single = await loadSingleCatalogAsOnline()
    pool = single.items.length > 0 ? single.items : fallbackOffline(keyword)
    statuses = single.statuses
    live = single.items.length > 0
    // 仅在真的拿到在线目录时才记「采集时间」，否则应按离线兜底呈现。
    cachedAt = live ? nowText() : ''
  } else {
    const querySources = enabled.filter((source) => source.url.includes(KEYWORD_TOKEN))
    const staticSources = enabled.filter((source) => !source.url.includes(KEYWORD_TOKEN))

    if (staticSources.length > 0) {
      if (!options.force && cacheFresh(cache, ttl) && cache && cache.items.length > 0) {
        pool = cache.items
        cachedAt = cache.capturedAt
      } else {
        const pulled = await pullAll(staticSources, timeoutMs, '')
        statuses.push(...pulled.statuses)
        // 无论成功还是失败都回写逐源状态，让设置页能看到「失败 + 原因」。
        persistSourceState(sources, pulled.statuses)
        if (pulled.items.length > 0) {
          pool = pulled.items
          cachedAt = nowText()
          live = true
          writeSearchCache(pool, cachedAt)
        } else if (cache && cache.items.length > 0) {
          pool = cache.items
          cachedAt = cache.capturedAt
        }
      }
    }

    if (querySources.length > 0) {
      if (keyword) {
        const pulled = await pullAll(querySources, timeoutMs, keyword)
        statuses.push(...pulled.statuses)
        if (pulled.items.length > 0) {
          pool = mergeOnline([pool, pulled.items])
          live = true
          persistSourceState(sources, pulled.statuses)
        }
      } else {
        // 关键词为空：这些源按设计不发起请求，给出明确提示而不是静默 0 条。
        statuses.push(
          ...querySources.map((source) => ({
            id: source.id,
            name: source.name,
            kind: source.kind,
            enabled: true,
            ok: true,
            count: 0,
            elapsedMs: 0,
            message: '输入关键词后检索该源。',
            keywordRequired: true,
          })),
        )
      }
    }
  }

  // ★ 内置知识库作为一等数据源并入，而不是等在线源全空才兜底。
  //
  // 之前的写法只在 pool.length === 0 时才会用到知识库，导致配了预置源
  // （GameBanana / GitHub）后，搜「星露谷物语」只会在线源那堆
  // 「复刻版 / MOD 安装器 / 类似星露谷的游戏」里过滤 —— 知识库里
  // 348 条真正的星露谷 MOD 反而永远检索不到（实测 0 条结果）。
  //
  // 现在：有关键词就查库并合并（知识库条目 id 前缀 jidi-，与在线源不会撞键），
  // 无关键词则不查库（避免首次进页面就把 8943 条全铺出来）。
  const libItems = keyword ? libraryAsOnline(keyword) : []
  if (libItems.length > 0) {
    pool = pool.length > 0 ? mergeOnline([pool, libItems]) : libItems
    statuses.push({
      id: 'trainer-lib',
      name: '修改器知识库',
      kind: 'json',
      enabled: true,
      ok: true,
      count: libItems.length,
      elapsedMs: 0,
      message: `内置离线知识库命中 ${libItems.length} 条（不联网）。`,
      keywordRequired: false,
    })
  }

  // 知识库条目并入后，若在线源一条都没成功、而池子里确实有知识库条目，
  // 说明这次是「离线知识库供给」而不是「演示数据兜底」——
  // 界面要能区分这两种，否则搜到 357 条真实资源却标「离线兜底」很误导。
  const libCount = pool.filter((item) => item.sourceIds.includes('trainer-lib')).length

  if (pool.length === 0) pool = fallbackOffline(keyword)
  const origin: SearchResult['origin'] = live
    ? 'online'
    : cachedAt
      ? 'cache'
      : libCount > 0
        ? 'knowledge'
        : 'empty'

  const libraryGameNames = new Set<string>()
  for (const game of store.games()) {
    libraryGameNames.add(norm(game.name))
    for (const alias of game.aliases) libraryGameNames.add(norm(alias))
  }

  const filtered = sortItems(
    pool.filter((item) => matches(item, query, libraryGameNames)),
    query.sort,
    query.keyword ?? '',
  )

  const pageSize = Math.min(Math.max(Number(query.pageSize) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const page = Math.min(Math.max(Number(query.page) || 1, 1), totalPages)
  const items = filtered.slice((page - 1) * pageSize, page * pageSize)

  return {
    items,
    total: filtered.length,
    page,
    pageSize,
    origin,
    cachedAt,
    tookMs: Date.now() - started,
    statuses,
    facets: buildFacets(pool),
  }
}

/** 未配置数据源时，退回旧的单一目录接口，包装为 OnlineResource。 */
async function loadSingleCatalogAsOnline(): Promise<{ items: OnlineResource[]; statuses: SourceStatus[] }> {
  const base = store.config().catalogBaseUrl.trim()
  if (!base) return { items: [], statuses: [] }
  const url = /\.json$/i.test(base) ? base : `${base.replace(/\/+$/, '')}/catalog.json`
  const started = Date.now()
  try {
    const res = await fetchWithTimeout(url, store.config().searchTimeoutMs || 8000, {})
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const items = parseJson(safeJson(await res.text()), '在线目录')
    return {
      items: mergeResources(items.map((resource) => ({ resource, sourceId: 'legacy-catalog', sourceName: '在线目录', priority: 10 }))),
      statuses: [
        {
          id: 'legacy-catalog',
          name: '在线目录（单源模式）',
          kind: 'json',
          enabled: true,
          ok: true,
          count: items.length,
          elapsedMs: Date.now() - started,
          message: '未配置多源检索，正在回退使用「设置 → 在线资源目录地址」。',
        },
      ],
    }
  } catch (error) {
    return {
      items: [],
      statuses: [
        {
          id: 'legacy-catalog',
          name: '在线目录（单源模式）',
          kind: 'json',
          enabled: true,
          ok: false,
          count: 0,
          elapsedMs: Date.now() - started,
          message: (error as Error).message,
        },
      ],
    }
  }
}

/** 把逐源状态回写到配置，便于设置页展示「上次测试」结果。 */
function persistSourceState(sources: SearchSource[], statuses: SourceStatus[]): void {
  if (statuses.length === 0) return
  const time = nowText()
  const next = sources.map((source) => {
    const status = statuses.find((item) => item.id === source.id)
    if (!status) return source
    return {
      ...source,
      lastTestedAt: time,
      lastState: (status.ok ? '正常' : '失败') as SearchSource['lastState'],
      lastMessage: status.message,
    }
  })
  store.saveConfig({ searchSources: next })
}

/** 新建一个空数据源（供设置页「新增」用）。 */
export function blankSource(): SearchSource {
  return {
    id: uid('src'),
    name: '新数据源',
    kind: 'json',
    url: '',
    enabled: true,
    sourceLabel: '',
    priority: 50,
    headers: '',
    lastTestedAt: '',
    lastState: '未测试',
    lastMessage: '',
  }
}

/** 单独测试一个数据源的连通性，不入缓存、不改全局状态。 */
export async function testSource(source: SearchSource): Promise<SourceTestResult> {
  if (!source.url.trim()) return { ok: false, count: 0, elapsedMs: 0, message: '请先填写数据源地址。', sampleTitles: [] }
  const timeoutMs = store.config().searchTimeoutMs || 8000
  const needsKeyword = source.url.includes(KEYWORD_TOKEN)
  try {
    const { items, elapsedMs } = await fetchSource(source, timeoutMs, PROBE_KEYWORD)
    return {
      ok: true,
      count: items.length,
      elapsedMs,
      message:
        items.length === 0
          ? '请求成功，但未解析到条目。请核对返回结构与所选类型是否匹配。'
          : `解析成功，共 ${items.length} 条${needsKeyword ? `（已用占位关键词「${PROBE_KEYWORD}」探测，仅验证可达性）` : ''}。`,
      sampleTitles: items.slice(0, 5).map((item) => item.title),
    }
  } catch (error) {
    const reason = error as Error
    return {
      ok: false,
      count: 0,
      elapsedMs: 0,
      message: reason?.name === 'AbortError' ? `请求超时（>${timeoutMs} ms）` : (reason?.message ?? '未知错误'),
      sampleTitles: [],
    }
  }
}

/** 清空检索缓存（设置页「清除缓存」用）。 */
export function clearSearchCache(): void {
  store.write(store.files.searchCache, { capturedAt: '', items: [] } satisfies CacheFile)
}

export function searchCacheMeta(): { capturedAt: string; count: number } {
  const cache = readSearchCache()
  return { capturedAt: cache?.capturedAt ?? '', count: cache?.items.length ?? 0 }
}
