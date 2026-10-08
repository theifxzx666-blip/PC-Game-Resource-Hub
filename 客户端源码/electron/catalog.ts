import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { store } from './store.js'
import { offlineCatalog } from './offlineCatalog.js'
import { ensureDir, nowText, uid } from './util.js'
import type { CatalogFile, CatalogResource, DownloadTask } from './types.js'

type ProgressSink = (task: DownloadTask) => void

let sink: ProgressSink | null = null

export function setProgressSink(fn: ProgressSink | null): void {
  sink = fn
}

function catalogUrl(): string {
  const base = store.config().catalogBaseUrl.trim()
  if (!base) return ''
  return /\.json$/i.test(base) ? base : `${base.replace(/\/+$/, '')}/catalog.json`
}

/**
 * 在线资源目录契约（自定义，需与运营后台对齐，当前状态：待确认）：
 * GET {catalogBaseUrl}/catalog.json → { version, updatedAt, resources: CatalogResource[] }
 * 字段与 electron/types.ts 的 CatalogResource 一一对应。
 */
function normalize(raw: unknown): CatalogFile {
  const data = raw as Partial<CatalogFile> | null
  if (!data || !Array.isArray(data.resources)) throw new Error('资源目录返回格式不正确：缺少 resources 数组。')
  const resources = data.resources
    .map((item) => {
      const r = item as Partial<CatalogResource>
      return {
        id: String(r.id ?? ''),
        title: String(r.title ?? ''),
        kind: (r.kind ?? 'MOD') as CatalogResource['kind'],
        gameName: String(r.gameName ?? ''),
        gameAliases: Array.isArray(r.gameAliases) ? r.gameAliases.map(String) : [],
        version: String(r.version ?? ''),
        compatibleVersion: String(r.compatibleVersion ?? ''),
        gameVersion: String(r.gameVersion ?? ''),
        source: String(r.source ?? ''),
        status: (r.status ?? '待核实') as CatalogResource['status'],
        updatedAt: String(r.updatedAt ?? ''),
        description: String(r.description ?? ''),
        tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
        risk: (r.risk ?? '低') as CatalogResource['risk'],
        downloadUrl: String(r.downloadUrl ?? ''),
        fileName: String(r.fileName ?? ''),
        homepage: String(r.homepage ?? ''),
      } satisfies CatalogResource
    })
    .filter((item) => item.id && item.title)
  return { version: String(data.version ?? ''), updatedAt: String(data.updatedAt ?? ''), resources }
}

export interface CatalogState {
  source: 'online' | 'cache' | 'offline'
  file: CatalogFile
  error: string
}

export function readCache(): CatalogFile | null {
  return store.read<CatalogFile | null>(store.files.catalogCache, null)
}

export async function loadCatalog(force = false): Promise<CatalogState> {
  const url = catalogUrl()
  const cache = readCache()
  if (!url) return { source: cache ? 'cache' : 'offline', file: cache ?? offlineCatalog, error: '未配置在线资源目录地址，已使用本地数据。' }
  if (!force && cache) return { source: 'cache', file: cache, error: '' }
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const file = normalize(await res.json())
    store.write(store.files.catalogCache, file)
    return { source: 'online', file, error: '' }
  } catch (error) {
    return {
      source: cache ? 'cache' : 'offline',
      file: cache ?? offlineCatalog,
      error: `在线目录拉取失败：${(error as Error).message}`,
    }
  }
}

export function listDownloads(): DownloadTask[] {
  return store.downloads().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

const queue: string[] = []
let running = false

export async function enqueueDownload(resourceId: string): Promise<DownloadTask> {
  const state = await loadCatalog(false)
  const resource = state.file.resources.find((item) => item.id === resourceId)
  if (!resource) throw new Error('资源目录中不存在该资源。')
  return enqueueDownloadFromResource(resource)
}

/**
 * 用一份资源快照直接投递下载任务。
 * 在线检索结果来自多源合并，不一定落进本地 catalog 缓存，因此需要这条独立入口。
 */
export async function enqueueDownloadFromResource(resource: CatalogResource): Promise<DownloadTask> {
  const existing = store
    .downloads()
    .find((item) => item.resourceId === resource.id && item.status === '已完成' && fs.existsSync(path.join(item.dir, item.fileName)))
  if (existing) throw new Error(`已下载过该资源：${existing.fileName}`)
  if (!resource.downloadUrl) throw new Error('该资源未提供下载地址（downloadUrl 为空），无法下载。')

  const safeName = resource.title.replace(/[\\/:*?"<>|]/g, '_')
  const dir = path.join(store.dirs.downloads, safeName)
  const task: DownloadTask = {
    id: uid('dl'),
    resourceId: resource.id,
    title: resource.title,
    version: resource.version,
    url: resource.downloadUrl,
    fileName: resource.fileName || path.basename(new URL(resource.downloadUrl).pathname) || `${resource.id}.bin`,
    dir,
    status: '排队中',
    receivedBytes: 0,
    totalBytes: 0,
    error: '',
    createdAt: nowText(),
    finishedAt: '',
  }
  const list = store.downloads()
  list.push(task)
  store.saveDownloads(list)
  sink?.(task)
  queue.push(task.id)
  void processQueue()
  return task
}

async function processQueue(): Promise<void> {
  if (running) return
  running = true
  try {
    while (queue.length > 0) {
      const id = queue.shift()
      if (id) await runOne(id)
    }
  } finally {
    running = false
  }
}

function patchTask(id: string, patch: Partial<DownloadTask>): DownloadTask | null {
  const list = store.downloads()
  const task = list.find((item) => item.id === id)
  if (!task) return null
  Object.assign(task, patch)
  store.saveDownloads(list)
  sink?.(task)
  return task
}

async function runOne(id: string): Promise<void> {
  const task = store.downloads().find((item) => item.id === id)
  if (!task) return
  patchTask(id, { status: '下载中' })
  try {
    ensureDir(task.dir)
    const res = await fetch(task.url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (!res.body) throw new Error('响应没有内容。')
    const total = Number(res.headers.get('content-length') ?? 0)
    patchTask(id, { totalBytes: total })
    let received = 0
    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      patchTask(id, { receivedBytes: received })
    })
    const dest = path.join(task.dir, task.fileName)
    await pipeline(source, fs.createWriteStream(dest))
    patchTask(id, { status: '已完成', receivedBytes: received, finishedAt: nowText() })
  } catch (error) {
    patchTask(id, { status: '失败', error: (error as Error).message, finishedAt: nowText() })
  }
}

export function removeDownload(id: string): void {
  const list = store.downloads()
  const task = list.find((item) => item.id === id)
  if (task) fs.rmSync(task.dir, { recursive: true, force: true })
  store.saveDownloads(list.filter((item) => item.id !== id))
}

export function localImport(paths: string[]): DownloadTask[] {
  const added: DownloadTask[] = []
  const list = store.downloads()
  for (const file of paths) {
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) continue
    const name = path.basename(file)
    const dir = path.join(store.dirs.downloads, '本地导入', name.replace(/[\\/:*?"<>|]/g, '_'))
    ensureDir(dir)
    fs.copyFileSync(file, path.join(dir, name))
    const task: DownloadTask = {
      id: uid('dl'),
      resourceId: 'local',
      title: name,
      version: '',
      url: '',
      fileName: name,
      dir,
      status: '已完成',
      receivedBytes: fs.statSync(file).size,
      totalBytes: fs.statSync(file).size,
      error: '',
      createdAt: nowText(),
      finishedAt: nowText(),
    }
    list.push(task)
    added.push(task)
  }
  store.saveDownloads(list)
  return added
}

export interface UpdateItem {
  taskId: string
  title: string
  localVersion: string
  remoteVersion: string
}

export async function checkUpdates(): Promise<UpdateItem[]> {
  const state = await loadCatalog(true)
  const result: UpdateItem[] = []
  for (const task of store.downloads()) {
    if (task.status !== '已完成' || task.resourceId === 'local') continue
    const remote = state.file.resources.find((item) => item.id === task.resourceId)
    if (!remote) continue
    if (remote.version && remote.version !== task.version) {
      result.push({ taskId: task.id, title: task.title, localVersion: task.version, remoteVersion: remote.version })
    }
  }
  return result
}
