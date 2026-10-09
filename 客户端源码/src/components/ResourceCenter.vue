<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api, call, formatBytes } from '../api'
import type { TrainerLibraryInfo, UpdateItem } from '../api'
import { state, refreshCatalog, refreshDownloads, refreshLibrary, runSearch } from '../state'
import type { OnlineResource, ResourceKind, ResourceRisk, ResourceStatus } from '../types'

const tab = ref<'search' | 'queue' | 'library'>('search')

// —— 检索条件 ——
const keyword = ref('')
const kind = ref<'全部' | ResourceKind>('全部')
const gameFilter = ref('全部')
const sourceFilter = ref('全部')
const statusFilter = ref<'全部' | ResourceStatus>('全部')
const riskFilter = ref<'全部' | ResourceRisk>('全部')
const onlyLibrary = ref(false)
const sort = ref<'relevance' | 'updated' | 'title' | 'source'>('relevance')
const page = ref(1)
const pageSize = ref(24)

const busy = ref(false)
const detailVisible = ref(false)
const detail = ref<OnlineResource | null>(null)
const updates = ref<UpdateItem[]>([])
const showFilters = ref(true)

const kindOptions = ['全部', '修改器', '存档', 'MOD', '补丁'] as const
const sortOptions = [
  { label: '相关性', value: 'relevance' },
  { label: '最近更新', value: 'updated' },
  { label: '按标题', value: 'title' },
  { label: '按来源', value: 'source' },
] as const

const result = computed(() => state.search)
const facets = computed(() => state.search.facets)

/**
 * 内置知识库的覆盖范围。
 *
 * 走主进程 `trainers:info` 拿真实统计，**不在界面里写死类型清单** ——
 * 数据集重新生成后（比如之后真的补了「存档」数据），界面自动跟上，
 * 不会留下一句过期的「暂不支持」。
 */
const libraryInfo = ref<TrainerLibraryInfo | null>(null)
const coveredKinds = computed(() => new Set(Object.keys(libraryInfo.value?.byKind ?? {})))

/**
 * 当前所选类型不在知识库覆盖范围内时的提示文案。
 *
 * 「存档」「补丁」在内置知识库里本来就没有数据（来源只带来了 MOD 与修改器）。
 * 选定这类却搜不到时必须说清是「知识库不覆盖」而不是「工具坏了」——
 * 这两种情况下界面都是空列表，不解释的话用户无从区分。
 */
const kindUncovered = computed(() => {
  const current = kind.value
  if (current === '全部') return ''
  if (coveredKinds.value.has(current)) return ''
  return `内置知识库目前只覆盖 ${[...coveredKinds.value].join(' / ')}，没有「${current}」数据；该分类只能命中已配置的在线源。`
})

const emptyDescription = computed(() => {
  if (kindUncovered.value) return kindUncovered.value
  return keyword.value
    ? `没有匹配「${keyword.value}」的资源，换个关键词或点「联网刷新」`
    : '暂无资源，请先到「设置」配置在线数据源'
})

const gameOptions = computed(() => ['全部', ...facets.value.games])
const sourceOptions = computed(() => ['全部', ...facets.value.sources])
const statusOptions = computed(() => ['全部', ...(facets.value.statuses.length ? facets.value.statuses : (['可用', '待核实', '不适配'] as ResourceStatus[]))])
const riskOptions = computed(() => ['全部', ...(facets.value.risks.length ? facets.value.risks : (['低', '中'] as ResourceRisk[]))])

const originLabel = computed(() => {
  const map = {
    online: '实时联网',
    cache: '本地缓存',
    knowledge: '内置知识库',
    empty: '离线兜底',
  } as const
  return map[result.value.origin] ?? '离线兜底'
})

const originType = computed(() => {
  const map = {
    online: 'success',
    cache: 'warning',
    knowledge: 'primary',
    empty: 'info',
  } as const
  return map[result.value.origin] ?? 'info'
})

const failedSources = computed(() => result.value.statuses.filter((item) => !item.ok))
const okSourceCount = computed(() => result.value.statuses.filter((item) => item.ok && !item.keywordRequired).length)
/** 需要关键词才会检索的源（如 GameBanana / GitHub），关键词为空时给用户提示。 */
const keywordSources = computed(() => result.value.statuses.filter((item) => item.keywordRequired))

const hasSourceConfigured = computed(() => state.config.searchSources.some((item) => item.enabled && item.url.trim()))

const inLibrary = computed(() => new Set(state.library.map((item) => item.resourceId)))
const downloaded = computed(() => new Set(state.downloads.filter((item) => item.status === '已完成').map((item) => item.resourceId)))

function buildQuery(overrides: Record<string, unknown> = {}) {
  return {
    keyword: keyword.value.trim(),
    kind: kind.value,
    game: gameFilter.value,
    source: sourceFilter.value,
    status: statusFilter.value,
    risk: riskFilter.value,
    onlyLibrary: onlyLibrary.value,
    sort: sort.value,
    page: page.value,
    pageSize: pageSize.value,
    ...overrides,
  }
}

async function guard(task: () => Promise<void>): Promise<void> {
  busy.value = true
  try {
    await task()
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    busy.value = false
  }
}

function statusType(status: ResourceStatus): 'success' | 'warning' | 'danger' {
  return status === '可用' ? 'success' : status === '待核实' ? 'warning' : 'danger'
}

function kindType(value: ResourceKind): 'primary' | 'success' | 'warning' | 'info' {
  return value === '修改器' ? 'primary' : value === 'MOD' ? 'success' : value === '存档' ? 'warning' : 'info'
}

/** 检索：回到第 1 页；force = true 时忽略缓存强制联网。 */
function search(force = false): void {
  void guard(async () => {
    await runSearch(buildQuery({ page: force ? 1 : page.value }), force)
    if (force) page.value = 1
  })
}

function resetFilters(): void {
  keyword.value = ''
  kind.value = '全部'
  gameFilter.value = '全部'
  sourceFilter.value = '全部'
  statusFilter.value = '全部'
  riskFilter.value = '全部'
  onlyLibrary.value = false
  sort.value = 'relevance'
  page.value = 1
  search()
}

function onPageChange(next: number): void {
  page.value = next
  search()
}

function onPageSizeChange(size: number): void {
  pageSize.value = size
  page.value = 1
  search()
}

function refresh(): void {
  void guard(async () => {
    await search(true)
    ElMessage.success(`检索已刷新（${originLabel.value}）`)
  })
}

function copyLink(url: string): void {
  if (!url) {
    ElMessage.warning('该资源未提供链接')
    return
  }
  void guard(async () => {
    await navigator.clipboard.writeText(url)
    ElMessage.success('链接已复制到剪贴板')
  })
}

function openHomepage(url: string): void {
  if (!url) {
    ElMessage.warning('该资源未提供主页')
    return
  }
  void call(api.openPath(url)).catch(() => ElMessage.warning('无法用系统打开该链接，请手动复制。'))
}

function download(resource: OnlineResource): void {
  void guard(async () => {
    const task = await call(api.search.enqueueDownload(resource))
    await refreshDownloads()
    ElMessage.success(`已加入下载队列：${task.fileName}`)
  })
}

function addToLibrary(resource: OnlineResource): void {
  void guard(async () => {
    await call(api.library.add({
      resourceId: resource.id,
      title: resource.title,
      kind: resource.kind,
      gameName: resource.gameName,
    }))
    await refreshLibrary()
    ElMessage.success('已加入我的资源')
  })
}

function removeFromLibrary(resourceId: string): void {
  void guard(async () => {
    await call(api.library.remove(resourceId))
    await refreshLibrary()
  })
}

function localImport(): void {
  void guard(async () => {
    const files = await call(api.dialog.pickFiles([
      { name: '压缩包', extensions: ['zip', '7z', 'rar'] },
      { name: '可执行文件', extensions: ['exe'] },
    ]))
    if (files.length === 0) return
    const added = await call(api.catalog.localImport(files))
    await refreshDownloads()
    ElMessage.success(`已本地导入 ${added.length} 个文件`)
  })
}

function checkUpdates(): void {
  void guard(async () => {
    updates.value = await call(api.catalog.checkUpdates())
    if (updates.value.length === 0) ElMessage.info('所有已下载资源均为最新版本')
  })
}

function removeDownload(id: string): void {
  void guard(async () => {
    await call(api.catalog.removeDownload(id))
    await refreshDownloads()
  })
}

function openDownload(taskId: string): void {
  const task = state.downloads.find((item) => item.id === taskId)
  if (task) void call(api.openPath(task.dir)).catch((error: Error) => ElMessage.error(error.message))
}

function percent(received: number, total: number): number {
  if (!total) return 0
  return Math.min(100, Math.round((received / total) * 100))
}

function openDetail(resource: OnlineResource): void {
  detail.value = resource
  detailVisible.value = true
}

onMounted(async () => {
  // 拉一次知识库覆盖范围，用于「选中未覆盖类型」时的说明文案。
  // 失败不影响检索本身，静默忽略即可（kindUncovered 为空，退化为原提示）。
  void call(api.trainers.info())
    .then((info) => {
      libraryInfo.value = info
    })
    .catch(() => undefined)

  // 首屏已由 bootstrap 触发过一次检索；这里只在结果为空时补一次，避免重复请求。
  if (state.search.items.length === 0 && state.search.total === 0 && !state.searching) {
    search()
  }
})
</script>

<template>
  <section class="page-section">
    <div class="section-heading">
      <div>
        <p class="eyebrow">多源聚合 · 实时检索</p>
        <h2>资源中心</h2>
        <p class="desc">
          结果来源：<el-tag size="small" :type="originType">{{ originLabel }}</el-tag>
          <span class="muted">
            {{ result.total }} 条命中 · {{ result.tookMs }} ms
            <template v-if="okSourceCount > 0"> · {{ okSourceCount }} 源正常</template>
            <template v-if="result.cachedAt"> · 数据时间 {{ result.cachedAt }}</template>
          </span>
        </p>
      </div>
      <div class="heading-actions">
        <el-button :loading="busy" @click="localImport">本地导入</el-button>
        <el-button :loading="busy" @click="checkUpdates">检查更新</el-button>
        <el-button type="primary" :loading="busy" @click="refresh">联网刷新</el-button>
      </div>
    </div>

    <el-alert
      v-if="!hasSourceConfigured"
      class="stack-gap"
      type="info"
      :closable="false"
      show-icon
      title="尚未配置在线数据源"
      description="当前使用内置离线数据。请到「设置 → 在线检索数据源」添加 JSON 接口或 RSS 订阅地址后即可联网检索。"
    />

    <el-alert
      v-for="item in failedSources"
      :key="item.id"
      class="stack-gap"
      type="warning"
      :closable="false"
      show-icon
      :title="`数据源「${item.name}」拉取失败：${item.message}`"
      :description="`其余数据源结果不受影响。可到「设置 → 在线检索数据源」点「测试连通性」定位问题。`"
    />

    <el-alert
      v-if="keywordSources.length > 0"
      class="stack-gap"
      type="info"
      :closable="false"
      show-icon
      :title="`${keywordSources.map((item) => item.name).join('、')} 需要关键词才会检索`"
      description="在上方搜索框输入游戏名或资源名后回车即可联网检索这些源；留空时不会向其发起请求。"
    />

    <el-alert
      v-for="item in updates"
      :key="item.taskId"
      class="stack-gap"
      type="warning"
      :closable="false"
      show-icon
      :title="`${item.title} 有新版本：本地 ${item.localVersion || '未标注'} → 目录 ${item.remoteVersion}`"
    />

    <el-tabs v-model="tab" class="plain-tabs">
      <el-tab-pane label="资源检索" name="search">
        <div class="search-bar">
          <el-input
            v-model="keyword"
            size="large"
            placeholder="输入游戏名 / 英文名 / 别名 / 资源关键词，回车检索"
            clearable
            @keyup.enter="search"
            @clear="search"
          />
          <el-button type="primary" size="large" :loading="busy" @click="search">检索</el-button>
          <el-button size="large" @click="showFilters = !showFilters">
            {{ showFilters ? '收起筛选' : '展开筛选' }}
          </el-button>
        </div>

        <div v-if="showFilters" class="filter-bar">
          <el-select v-model="gameFilter" style="width: 170px" @change="search">
            <el-option v-for="name in gameOptions" :key="name" :label="name === '全部' ? '全部游戏' : name" :value="name" />
          </el-select>
          <el-select v-model="sourceFilter" style="width: 160px" @change="search">
            <el-option v-for="name in sourceOptions" :key="name" :label="name === '全部' ? '全部来源' : name" :value="name" />
          </el-select>
          <el-select v-model="statusFilter" style="width: 130px" @change="search">
            <el-option v-for="name in statusOptions" :key="name" :label="name === '全部' ? '全部状态' : name" :value="name" />
          </el-select>
          <el-select v-model="riskFilter" style="width: 120px" @change="search">
            <el-option v-for="name in riskOptions" :key="name" :label="name === '全部' ? '全部风险' : name" :value="name" />
          </el-select>
          <el-select v-model="sort" style="width: 130px" @change="search">
            <el-option v-for="item in sortOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-checkbox v-model="onlyLibrary" @change="search">只看已入库游戏</el-checkbox>
          <el-button link type="primary" @click="resetFilters">重置</el-button>
        </div>

        <div class="filter-bar">
          <el-segmented v-model="kind" :options="kindOptions as unknown as string[]" @change="search" />
        </div>

        <el-alert
          v-if="kindUncovered"
          type="info"
          :closable="false"
          show-icon
          class="coverage-alert"
          :title="kindUncovered"
        />

        <div v-loading="state.searching" class="resource-grid">
          <article v-for="resource in result.items" :key="resource.id" class="resource-card">
            <div class="resource-card-top">
              <el-tag :type="kindType(resource.kind)" effect="light" size="small">{{ resource.kind }}</el-tag>
              <el-tag :type="statusType(resource.status)" effect="plain" size="small">{{ resource.status }}</el-tag>
              <el-tag v-if="resource.multiSource" type="primary" effect="plain" size="small">多源命中</el-tag>
              <el-tag v-if="downloaded.has(resource.id)" type="success" size="small">已下载</el-tag>
            </div>
            <h3 @click="openDetail(resource)">{{ resource.title }}</h3>
            <p>{{ resource.gameName || '未标注游戏' }} · 适配 {{ resource.compatibleVersion || resource.gameVersion || '未标注' }}</p>
            <div class="resource-meta">
              <span>{{ resource.source }}</span>
              <span>{{ resource.version || '未标注版本' }}</span>
            </div>
            <div class="tag-row">
              <el-tag v-for="tag in resource.tags" :key="tag" size="small" effect="plain">{{ tag }}</el-tag>
            </div>
            <div class="card-actions">
              <el-button size="small" @click="openDetail(resource)">详情</el-button>
              <el-button size="small" :disabled="inLibrary.has(resource.id)" @click="addToLibrary(resource)">
                {{ inLibrary.has(resource.id) ? '已收录' : '加入我的资源' }}
              </el-button>
              <el-button size="small" type="primary" :disabled="!resource.downloadUrl" @click="download(resource)">
                下载
              </el-button>
              <el-button size="small" :disabled="!resource.homepage" @click="copyLink(resource.homepage)">复制链接</el-button>
            </div>
          </article>
        </div>

        <el-empty
          v-if="!state.searching && result.items.length === 0"
          :description="emptyDescription"
        />

        <div v-if="result.total > 0" class="pager">
          <el-pagination
            layout="total, sizes, prev, pager, next"
            :total="result.total"
            :current-page="result.page"
            :page-size="result.pageSize"
            :page-sizes="[12, 24, 48, 96]"
            @current-change="onPageChange"
            @size-change="onPageSizeChange"
          />
        </div>
      </el-tab-pane>

      <el-tab-pane :label="`下载队列（${state.downloads.length}）`" name="queue">
        <el-table :data="state.downloads" class="flat-table" stripe>
          <el-table-column label="资源" min-width="220">
            <template #default="scope">
              <strong>{{ scope.row.title }}</strong>
              <p class="table-subtitle">{{ scope.row.fileName }}</p>
            </template>
          </el-table-column>
          <el-table-column label="进度" min-width="200">
            <template #default="scope">
              <el-progress
                v-if="scope.row.status === '下载中'"
                :percentage="percent(scope.row.receivedBytes, scope.row.totalBytes)"
                :stroke-width="14"
              />
              <span v-else class="muted">
                {{ scope.row.status === '已完成' ? formatBytes(scope.row.receivedBytes) : scope.row.error || '等待中' }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="scope">
              <el-tag :type="scope.row.status === '已完成' ? 'success' : scope.row.status === '失败' ? 'danger' : 'info'" size="small">
                {{ scope.row.status }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="createdAt" label="创建时间" width="180" />
          <el-table-column label="操作" width="170" fixed="right">
            <template #default="scope">
              <el-button link type="primary" @click="openDownload(scope.row.id)">打开目录</el-button>
              <el-button link type="danger" @click="removeDownload(scope.row.id)">移除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="state.downloads.length === 0" description="下载队列为空" />
      </el-tab-pane>

      <el-tab-pane :label="`我的资源（${state.library.length}）`" name="library">
        <el-table :data="state.library" class="flat-table" stripe>
          <el-table-column label="资源" min-width="240">
            <template #default="scope"><strong>{{ scope.row.title }}</strong></template>
          </el-table-column>
          <el-table-column label="类型" width="110">
            <template #default="scope"><el-tag :type="kindType(scope.row.kind)" size="small">{{ scope.row.kind }}</el-tag></template>
          </el-table-column>
          <el-table-column prop="gameName" label="游戏" min-width="160" />
          <el-table-column prop="addedAt" label="加入时间" width="180" />
          <el-table-column label="操作" width="100" fixed="right">
            <template #default="scope">
              <el-button link type="danger" @click="removeFromLibrary(scope.row.resourceId)">移除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="state.library.length === 0" description="我的资源为空，去资源检索里收录一些吧" />
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="detailVisible" title="资源详情" width="640px">
      <template v-if="detail">
        <div class="resource-card-top">
          <el-tag :type="kindType(detail.kind)">{{ detail.kind }}</el-tag>
          <el-tag :type="statusType(detail.status)" effect="plain">{{ detail.status }}</el-tag>
          <el-tag :type="detail.risk === '低' ? 'success' : 'warning'" effect="plain">风险 {{ detail.risk }}</el-tag>
          <el-tag v-if="detail.multiSource" type="primary" effect="plain">多源命中</el-tag>
        </div>
        <h2>{{ detail.title }}</h2>
        <el-descriptions :column="1" border>
          <el-descriptions-item label="游戏">{{ detail.gameName || '-' }}</el-descriptions-item>
          <el-descriptions-item label="别名">{{ detail.gameAliases.join('、') || '-' }}</el-descriptions-item>
          <el-descriptions-item label="资源版本">{{ detail.version || '-' }}</el-descriptions-item>
          <el-descriptions-item label="适配版本">{{ detail.compatibleVersion || '-' }}</el-descriptions-item>
          <el-descriptions-item label="游戏版本">{{ detail.gameVersion || '-' }}</el-descriptions-item>
          <el-descriptions-item label="来源">{{ detail.source || '-' }}</el-descriptions-item>
          <el-descriptions-item label="命中数据源">{{ detail.sourceNames.join('、') || '-' }}</el-descriptions-item>
          <el-descriptions-item label="更新时间">{{ detail.updatedAt || '-' }}</el-descriptions-item>
          <el-descriptions-item label="下载地址">{{ detail.downloadUrl || '未提供' }}</el-descriptions-item>
          <el-descriptions-item label="主页">{{ detail.homepage || '未提供' }}</el-descriptions-item>
        </el-descriptions>
        <h3>说明</h3>
        <p>{{ detail.description || '无' }}</p>
        <el-alert
          v-if="detail.status !== '可用'"
          type="warning"
          :closable="false"
          show-icon
          title="该资源未通过完整验证，建议先核对游戏版本与来源状态。"
        />
        <div class="detail-actions">
          <el-button :disabled="!detail.homepage" @click="copyLink(detail.homepage)">复制来源链接</el-button>
          <el-button :disabled="!detail.homepage" @click="openHomepage(detail.homepage)">打开主页</el-button>
          <el-button type="primary" :disabled="!detail.downloadUrl" @click="download(detail)">加入下载队列</el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.card-actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.search-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.search-bar .el-input {
  flex: 1;
}
.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
.detail-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
  justify-content: flex-end;
}
</style>
