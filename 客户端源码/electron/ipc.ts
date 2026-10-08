import path from 'node:path'
import fs from 'node:fs'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { store } from './store.js'
import { appendLog, setLogSink } from './log.js'
import { setProgressSink } from './catalog.js'
import { buildManualGame, launchGame, scanSteam } from './games.js'
import { ensureGameIcon, ensureIcons } from './gameArt.js'
import { searchSteamStore, steamStoreUrl } from './steamStore.js'
import {
  createBackup,
  exportBackup,
  importArchive,
  inspectBackup,
  listBackups,
  removeBackup,
  restoreBackup,
  setPinned,
} from './saves.js'
import {
  applyProfile,
  deleteProfile,
  importMods,
  installMod,
  listConflicts,
  listProfiles,
  planMod,
  removeMod,
  saveProfile,
  setModEnabled,
  uninstallMod,
  updateMod,
} from './mods.js'
import {
  checkUpdates,
  enqueueDownload,
  enqueueDownloadFromResource,
  listDownloads,
  loadCatalog,
  localImport,
  removeDownload,
} from './catalog.js'
import { formatBytes, nowText, uid } from './util.js'
import { diffSnapshot, probeSavePaths, recordSnapshot, type SnapshotState } from './savePathFinder.js'
import { libraryInfo } from './savePathLibrary.js'
import { searchTrainers, trainersForGame, trainersInfo } from './trainerLibrary.js'
import { blankSource, clearSearchCache, searchCacheMeta, searchOnline, testSource } from './onlineSearch.js'
import type { AppConfig, CatalogResource, Game, LibraryItem, LogEntry, ModEntry, ResourceKind, SearchQuery, SearchSource } from './types.js'

function toolsDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'tools') : path.join(app.getAppPath(), 'resources', 'tools')
}

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

type Handler = (...args: never[]) => unknown

const SOURCE_KINDS: SearchSource['kind'][] = ['json', 'rss', 'gamebanana', 'github']

/** 归一化来自渲染层的检索数据源，防止脏字段落盘。 */
function sanitizeSource(raw: Partial<SearchSource>): SearchSource {
  const base = blankSource()
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : base.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : base.name,
    kind: SOURCE_KINDS.includes(raw.kind as SearchSource['kind']) ? (raw.kind as SearchSource['kind']) : 'json',
    url: typeof raw.url === 'string' ? raw.url.trim() : '',
    enabled: raw.enabled !== false,
    sourceLabel: typeof raw.sourceLabel === 'string' ? raw.sourceLabel.trim().slice(0, 60) : '',
    priority: typeof raw.priority === 'number' && Number.isFinite(raw.priority) ? Math.min(999, Math.max(1, Math.floor(raw.priority))) : base.priority,
    headers: typeof raw.headers === 'string' ? raw.headers.slice(0, 2000) : '',
    lastTestedAt: typeof raw.lastTestedAt === 'string' ? raw.lastTestedAt : '',
    lastState: raw.lastState === '正常' || raw.lastState === '失败' || raw.lastState === '未启用' ? raw.lastState : '未测试',
    lastMessage: typeof raw.lastMessage === 'string' ? raw.lastMessage.slice(0, 300) : '',
    // 预置源标记与说明由应用提供，透传即可，不参与用户编辑。
    preset: raw.preset === true,
    presetNote: typeof raw.presetNote === 'string' ? raw.presetNote.slice(0, 500) : '',
  }
}

function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await (fn as (...a: unknown[]) => unknown)(...args) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
    }
  })
}

export function registerIpc(): void {
  setLogSink((entry) => broadcast('log:append', entry))
  setProgressSink((task) => broadcast('download:progress', task))

  handle('app:info', () => ({
    dataDir: store.root,
    version: app.getVersion(),
    packaged: app.isPackaged,
    toolsDir: toolsDir(),
    toolsAvailable: Boolean(
      fs.existsSync(path.join(toolsDir(), '7za.exe')) || fs.existsSync(path.join(toolsDir(), '7z.exe')),
    ),
  }))

  handle('app:openPath', (target: string) => shell.openPath(target))
  handle('app:openDataDir', () => shell.openPath(store.root))
  /** 用系统默认浏览器打开 http/https 链接（仅放行这两种协议，避免被当成任意命令入口）。 */
  handle('app:openExternal', (url: string) => {
    const target = typeof url === 'string' ? url.trim() : ''
    if (!/^https?:\/\//i.test(target)) throw new Error('只允许打开 http/https 链接。')
    return shell.openExternal(target)
  })
  handle('app:revealFile', (target: string) => {
    shell.showItemInFolder(target)
    return true
  })

  handle('config:get', () => store.config())
  handle('config:update', (patch: Partial<AppConfig>) => {
    const safe: Partial<AppConfig> = {}
    if (typeof patch.backupKeep === 'number' && Number.isFinite(patch.backupKeep)) {
      safe.backupKeep = Math.min(50, Math.max(1, Math.floor(patch.backupKeep)))
    }
    if (typeof patch.archiveTool === 'string') safe.archiveTool = patch.archiveTool.trim()
    if (typeof patch.catalogBaseUrl === 'string') safe.catalogBaseUrl = patch.catalogBaseUrl.trim()
    if (typeof patch.catalogAutoRefresh === 'boolean') safe.catalogAutoRefresh = patch.catalogAutoRefresh
    if (typeof patch.searchCacheTtlMinutes === 'number' && Number.isFinite(patch.searchCacheTtlMinutes)) {
      safe.searchCacheTtlMinutes = Math.min(1440, Math.max(1, Math.floor(patch.searchCacheTtlMinutes)))
    }
    if (typeof patch.searchTimeoutMs === 'number' && Number.isFinite(patch.searchTimeoutMs)) {
      safe.searchTimeoutMs = Math.min(60000, Math.max(1000, Math.floor(patch.searchTimeoutMs)))
    }
    if (Array.isArray(patch.searchSources)) {
      safe.searchSources = patch.searchSources.map((raw) => sanitizeSource(raw as Partial<SearchSource>))
    }
    const next = store.saveConfig(safe)
    appendLog('更新设置', Object.keys(safe).join('、') || '无变化')
    return next
  })

  handle('dialog:pickDirectory', async () => {
    const win = focusedWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? '' : result.filePaths[0] ?? ''
  })

  handle('dialog:pickFiles', async (filters: Array<{ name: string; extensions: string[] }> = []) => {
    const win = focusedWindow()
    const options = { properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>, filters }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })

  handle('games:list', () => store.games())
  handle('games:scanSteam', async () => {
    const result = await scanSteam()
    const existing = store.games()
    const merged = [...existing]
    let added = 0
    for (const detected of result.detected) {
      const index = merged.findIndex((item) => item.id === detected.id)
      if (index === -1) {
        merged.push(detected)
        added += 1
      } else {
        // 保留用户已配置的存档路径与别名，只刷新安装目录与库位置
        merged[index] = { ...merged[index], dir: detected.dir || merged[index].dir, steamLibrary: detected.steamLibrary }
      }
    }
    store.saveGames(merged)
    appendLog('扫描 Steam 库', `识别 ${result.detected.length} 个游戏，新增 ${added} 个`)
    return { ...result, added }
  })
  handle('games:add', (payload: { name: string; dir: string; savePaths?: string[]; aliases?: string[] }) => {
    const dir = typeof payload?.dir === 'string' ? payload.dir.trim() : ''
    if (!dir) throw new Error('未选择游戏目录。')
    const game = buildManualGame(payload?.name ?? '', dir)
    game.savePaths = Array.isArray(payload?.savePaths) ? payload.savePaths : []
    game.aliases = Array.isArray(payload?.aliases) ? payload.aliases : []
    const list = store.games()
    list.push(game)
    store.saveGames(list)
    appendLog('添加游戏', `${game.name}（${game.dir}）`)
    return game
  })
  handle('games:update', (id: string, patch: Partial<Game>) => {
    const list = store.games()
    const game = list.find((item) => item.id === id)
    if (!game) throw new Error('未找到该游戏。')
    Object.assign(game, patch, { id: game.id, source: game.source })
    store.saveGames(list)
    appendLog('更新游戏', game.name)
    return game
  })
  handle('games:remove', (id: string) => {
    const list = store.games()
    const game = list.find((item) => item.id === id)
    if (game) appendLog('移除游戏', game.name)
    store.saveGames(list.filter((item) => item.id !== id))
    return true
  })
  handle('games:launch', async (id: string) => {
    const game = store.games().find((item) => item.id === id)
    if (!game) throw new Error('未找到该游戏。')
    const message = await launchGame(game)
    appendLog('启动游戏', `${game.name}（${message}）`)
    return message
  })
  handle('games:openDir', async (id: string) => {
    const game = store.games().find((item) => item.id === id)
    if (!game || !game.dir) throw new Error('该游戏未关联目录。')
    return shell.openPath(game.dir)
  })

  /** 批量取游戏图标（命中缓存则不重算）。返回 { gameId: dataURL }。 */
  handle('games:icons', () => ensureIcons(store.games()))

  /** 强制重算某个游戏的图标（设置/配置弹窗里的「刷新图标」）。 */
  handle('games:refreshIcon', async (id: string) => {
    const list = store.games()
    const index = list.findIndex((item) => item.id === id)
    if (index === -1) throw new Error('未找到该游戏。')
    const result = await ensureGameIcon(list[index], { force: true })
    list[index] = { ...list[index], iconSource: result.source, iconUpdatedAt: nowText() }
    store.saveGames(list)
    appendLog('更新游戏图标', `${list[index].name}：${result.source || '未取到图标'}`)
    return result
  })

  /** 按名称检索 Steam 商店，返回候选资料页列表。只读。 */
  handle('games:steamSearch', async (term: string) => {
    const keyword = typeof term === 'string' ? term.trim() : ''
    if (!keyword) return []
    // Steam 商店首次握手较慢（实测冷启动可达 12 s 以上），这里给一个不低于 12 s 的下限，
    // 避免用户把「单源请求超时」调小后连累商店匹配。
    const timeout = Math.max(store.config().searchTimeoutMs || 8000, 12000)
    const items = await searchSteamStore(keyword, timeout)
    appendLog('匹配 Steam 资料', `${keyword}：${items.length} 个候选`)
    return items
  })

  /** 把选中的 Steam 资料写入游戏，并用官方封面刷新图标。 */
  handle(
    'games:applySteamMatch',
    async (id: string, payload: { appid: string; storeUrl?: string; coverUrl?: string }) => {
      const list = store.games()
      const index = list.findIndex((item) => item.id === id)
      if (index === -1) throw new Error('未找到该游戏。')
      const appid = String(payload?.appid ?? '').trim()
      if (!appid) throw new Error('缺少 Steam appid。')
      list[index] = {
        ...list[index],
        steamAppId: appid,
        storeUrl: (payload?.storeUrl || steamStoreUrl(appid)).trim(),
        storeCoverUrl: typeof payload?.coverUrl === 'string' ? payload.coverUrl.trim() : list[index].storeCoverUrl,
      }
      store.saveGames(list)
      const icon = await ensureGameIcon(list[index], { force: true })
      const next = store.games()
      const at = next.findIndex((item) => item.id === id)
      next[at] = { ...next[at], iconSource: icon.source, iconUpdatedAt: nowText() }
      store.saveGames(next)
      appendLog('匹配 Steam 资料', `${next[at].name} → appid ${appid}（图标：${icon.source || '未取到'}）`)
      return { game: next[at], icon }
    },
  )

  /** 一键探测：扫描本机常见存档位置，返回按置信度排序的候选列表。只读。 */
  handle('saves:probePaths', (id: string) => {
    const game = store.games().find((item) => item.id === id)
    if (!game) throw new Error('未找到该游戏。')
    const result = probeSavePaths(game)
    appendLog('探测存档路径', `${game.name}：候选 ${result.candidates.length} 个`)
    return result
  })

  /** 存档路径知识库元信息：数据来源、收录规模，供设置页展示。 */
  handle('saves:libraryInfo', () => libraryInfo())

  /**
   * 建立存档路径快照基线。传入 dirs 为空时，自动用探测结果里存在且得分较高的目录。
   * 只读扫描，不写入任何用户目录。
   */  handle('saves:snapshotTake', (id: string, dirs?: string[]) => {
    const game = store.games().find((item) => item.id === id)
    if (!game) throw new Error('未找到该游戏。')
    let targets = (dirs ?? []).filter(Boolean)
    if (targets.length === 0) {
      targets = probeSavePaths(game)
        .candidates.filter((item) => item.exists)
        .slice(0, 12)
        .map((item) => item.path)
    }
    const snapshot = recordSnapshot(id, targets)
    store.saveSnapshotFor(id, snapshot)
    appendLog('建立存档快照基线', `${game.name}：监控 ${snapshot.entries.length} 个目录`)
    return { capturedAt: snapshot.capturedAt, monitored: snapshot.entries.length }
  })

  /** 差分对比：启动游戏后调用，找出真正发生变动的目录。 */
  handle('saves:snapshotDiff', (id: string, dirs?: string[]) => {
    const game = store.games().find((item) => item.id === id)
    if (!game) throw new Error('未找到该游戏。')
    const before = store.snapshotFor<SnapshotState>(id)
    if (!before) throw new Error('尚未建立快照基线，请先点击「建立基线」。')
    const result = diffSnapshot(before, (dirs ?? []).filter(Boolean))
    appendLog('对比存档快照', `${game.name}：识别到 ${result.length} 个变动目录`)
    return { capturedAt: before.capturedAt, items: result }
  })

  handle('saves:list', (gameId?: string) => listBackups(gameId))
  handle('saves:backup', (gameId: string, note: string) => {
    const entry = createBackup(gameId, note ?? '')
    appendLog('创建存档备份', `${entry.name}（${formatBytes(entry.sizeBytes)} / ${entry.fileCount} 个文件）`)
    return entry
  })
  handle('saves:restore', (gameId: string, backupId: string) => {
    const result = restoreBackup(gameId, backupId)
    appendLog('恢复存档', `已恢复至 ${result.restored.length} 个目录，恢复前自动备份 ${result.autoBackupId}`)
    return result
  })
  handle('saves:remove', (gameId: string, backupId: string) => {
    removeBackup(gameId, backupId)
    appendLog('删除备份', backupId)
    return true
  })
  handle('saves:pin', (gameId: string, backupId: string, pinned: boolean) => {
    setPinned(gameId, backupId, pinned)
    appendLog(pinned ? '固定备份' : '取消固定', backupId)
    return true
  })
  handle('saves:inspect', (gameId: string, backupId: string) => inspectBackup(gameId, backupId))
  handle('saves:export', async (gameId: string, backupId: string) => {
    const out = await exportBackup(gameId, backupId, toolsDir())
    appendLog('导出备份归档', out)
    return out
  })
  handle('saves:import', async (file: string) => {
    const added = await importArchive(file, toolsDir())
    appendLog('导入备份归档', `${file} → 新增 ${added.length} 条备份`)
    return added
  })

  handle('mods:list', (gameId?: string) => {
    const list = store.mods()
    return gameId ? list.filter((item) => item.gameId === gameId) : list
  })
  handle('mods:import', async (paths: string[], gameId: string) => {
    const result = await importMods(paths, gameId, toolsDir())
    appendLog(
      '导入 MOD',
      `成功 ${result.imported.length} 个${result.failed.length ? `，失败 ${result.failed.length} 个` : ''}`,
      result.failed.length ? '失败' : '成功',
      result.failed.join('；'),
    )
    return result
  })
  handle('mods:plan', (modId: string) => planMod(modId))
  handle('mods:install', (modId: string) => {
    const mod = installMod(modId)
    appendLog('安装 MOD', `${mod.name}（部署 ${mod.deployed.length} 个文件）`)
    return mod
  })
  handle('mods:uninstall', (modId: string) => {
    const mod = uninstallMod(modId)
    appendLog('卸载 MOD', mod.name)
    return mod
  })
  handle('mods:setEnabled', (modId: string, enabled: boolean) => {
    const mod = setModEnabled(modId, enabled)
    appendLog(enabled ? '启用 MOD' : '停用 MOD', mod.name)
    return mod
  })
  handle('mods:remove', (modId: string) => {
    removeMod(modId)
    appendLog('删除 MOD', modId)
    return true
  })
  handle('mods:update', (modId: string, patch: Partial<ModEntry>) => updateMod(modId, patch))
  handle('mods:conflicts', (gameId: string) => listConflicts(gameId))
  handle('mods:profiles:list', (gameId?: string) => listProfiles(gameId))
  handle('mods:profiles:save', (gameId: string, name: string) => {
    const profile = saveProfile(gameId, name)
    appendLog('保存配置档案', profile.name)
    return profile
  })
  handle('mods:profiles:apply', (profileId: string) => {
    applyProfile(profileId)
    appendLog('切换配置档案', profileId)
    return true
  })
  handle('mods:profiles:delete', (profileId: string) => {
    deleteProfile(profileId)
    return true
  })

  handle('catalog:load', (force = false) => loadCatalog(force))
  handle('catalog:download', (resourceId: string) => enqueueDownload(resourceId))
  handle('catalog:downloads', () => listDownloads())
  handle('catalog:removeDownload', (id: string) => {
    removeDownload(id)
    return true
  })
  handle('catalog:localImport', (paths: string[]) => {
    const added = localImport(paths)
    appendLog('本地导入资源', `新增 ${added.length} 个`)
    return added
  })
  handle('catalog:checkUpdates', () => checkUpdates())

  /**
   * 修改器 / MOD 元数据知识库：内置离线快照（机地社区帖）。
   * 只返回元数据，不含下载直链；homepage 指向来源帖，由用户自行查看。
   */
  handle('trainers:info', () => trainersInfo())
  handle('trainers:forGame', (gameName: string, aliases: string[] = []) =>
    trainersForGame(gameName, aliases),
  )
  handle('trainers:search', (keyword: string, kinds: ResourceKind[] = [], limit = 200) =>
    searchTrainers(keyword, kinds, limit),
  )

  /** 在线聚合检索。force = true 时忽略缓存强制联网。只读，不写任何用户目录。 */
  handle('search:query', async (query: SearchQuery, force = false) => {
    const result = await searchOnline(query ?? {}, { force: Boolean(force) })
    const failed = result.statuses.filter((item) => !item.ok).length
    const detail = `${result.total} 条命中 · ${result.origin}${failed ? ` · ${failed} 源失败` : ''}`
    // 高频检索不逐次写日志，只在联网刷新或存在失败源时记录，避免日志被刷屏。
    if (force || failed > 0) appendLog('在线检索资源', detail)
    return result
  })

  handle('search:sources', () => store.config().searchSources)

  handle('search:testSource', async (source: SearchSource) => {
    const safe = sanitizeSource(source)
    const result = await testSource(safe)
    // 回写测试结果，便于设置页展示「上次测试」时间与状态。
    const next = store.config().searchSources.map((item) =>
      item.id === safe.id
        ? { ...item, lastTestedAt: nowText(), lastState: (result.ok ? '正常' : '失败') as SearchSource['lastState'], lastMessage: result.message }
        : item,
    )
    if (next.some((item) => item.id === safe.id)) store.saveConfig({ searchSources: next })
    appendLog('测试数据源连通性', `${safe.name}：${result.ok ? `成功 ${result.count} 条` : result.message}`)
    return result
  })

  handle('search:clearCache', () => {
    clearSearchCache()
    appendLog('清除检索缓存', '已清空在线检索聚合缓存')
    return true
  })

  handle('search:cacheMeta', () => searchCacheMeta())

  /**
   * 把检索结果直接投递到下载队列。
   * 检索结果来自多源合并，不一定存在于本地 catalog 缓存里，因此这里显式接收资源快照。
   */
  handle('search:enqueueDownload', async (resource: CatalogResource) => {
    const task = await enqueueDownloadFromResource(resource)
    appendLog('下载检索资源', resource.title)
    return task
  })

  handle('library:list', () => store.library())
  handle('library:add', (payload: { resourceId: string; title: string; kind: LibraryItem['kind']; gameName: string }) => {
    const list = store.library()
    if (list.some((item) => item.resourceId === payload.resourceId)) return list
    list.push({ id: uid('lib'), addedAt: nowText(), ...payload })
    store.saveLibrary(list)
    appendLog('加入我的资源', payload.title)
    return list
  })
  handle('library:remove', (resourceId: string) => {
    store.saveLibrary(store.library().filter((item) => item.resourceId !== resourceId))
    return true
  })

  handle('logs:list', (limit = 100): LogEntry[] => store.logs().slice(0, limit))
  handle('logs:clear', () => {
    store.saveLogs([])
    return true
  })
}
