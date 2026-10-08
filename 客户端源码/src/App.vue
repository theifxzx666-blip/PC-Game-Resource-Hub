<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Box, Collection, FolderOpened, House, Monitor, Operation, Setting } from '@element-plus/icons-vue'
import { api, call } from './api'
import { bootstrap, patchDownload, pushLog, refreshGameScoped, refreshLogs, state } from './state'
import GameLibrary from './components/GameLibrary.vue'
import SaveManager from './components/SaveManager.vue'
import ModManager from './components/ModManager.vue'
import ResourceCenter from './components/ResourceCenter.vue'
import SearchSourceCard from './components/SearchSourceCard.vue'

type ViewKey = 'overview' | 'games' | 'saves' | 'mods' | 'resources' | 'logs' | 'settings'

const activeView = ref<ViewKey>('overview')
const savingSettings = ref(false)
const settingsForm = ref({
  ...state.config,
  searchSources: state.config.searchSources.map((item) => ({ ...item })),
})

const navigation = [
  { key: 'overview' as const, label: '概览', icon: House },
  { key: 'games' as const, label: '游戏库', icon: Monitor },
  { key: 'saves' as const, label: '存档管理', icon: FolderOpened },
  { key: 'mods' as const, label: 'MOD 管理', icon: Box },
  { key: 'resources' as const, label: '资源中心', icon: Collection },
  { key: 'logs' as const, label: '操作记录', icon: Operation },
  { key: 'settings' as const, label: '设置', icon: Setting },
]

const currentTitle = computed(() => navigation.find((item) => item.key === activeView.value)?.label ?? '概览')
const deployedMods = computed(() => state.mods.filter((item) => item.deployed.length > 0).length)

let disposers: Array<() => void> = []

onMounted(async () => {
  try {
    await bootstrap()
    settingsForm.value = { ...state.config, searchSources: state.config.searchSources.map((item) => ({ ...item })) }
  } catch (error) {
    ElMessage.error(`初始化失败：${(error as Error).message}`)
  }
  disposers = [
    api.onLog((entry) => pushLog(entry)),
    api.onDownloadProgress((task) => patchDownload(task)),
  ]
  try {
    cacheMeta.value = await call(api.search.cacheMeta())
  } catch {
    /* 缓存元信息读取失败不影响主流程 */
  }
})

onUnmounted(() => {
  for (const dispose of disposers) dispose()
  disposers = []
})

watch(
  () => state.selectedGameId,
  () => {
    void refreshGameScoped().catch((error: Error) => ElMessage.error(error.message))
  },
)

function go(view: ViewKey): void {
  activeView.value = view
  if (view === 'settings') settingsForm.value = { ...state.config, searchSources: state.config.searchSources.map((item) => ({ ...item })) }
}

async function saveSettings(): Promise<void> {
  savingSettings.value = true
  try {
    state.config = await call(api.config.update(settingsForm.value))
    settingsForm.value = { ...state.config, searchSources: state.config.searchSources.map((item) => ({ ...item })) }
    await refreshGameScoped()
    ElMessage.success('设置已保存')
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    savingSettings.value = false
  }
}

function pickArchiveTool(): void {
  void call(api.dialog.pickFiles([{ name: '解压工具', extensions: ['exe'] }]))
    .then((files) => {
      if (files[0]) settingsForm.value.archiveTool = files[0]
    })
    .catch((error: Error) => ElMessage.error(error.message))
}

// —— 在线检索数据源管理 ——
const testingSourceId = ref('')
const cacheMeta = ref({ capturedAt: '', count: 0 })

function addSource(): void {
  settingsForm.value.searchSources = [
    ...settingsForm.value.searchSources,
    {
      id: `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
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
    },
  ]
}

function removeSource(id: string): void {
  settingsForm.value.searchSources = settingsForm.value.searchSources.filter((item) => item.id !== id)
}

function testSource(id: string): void {
  const source = settingsForm.value.searchSources.find((item) => item.id === id)
  if (!source) return
  testingSourceId.value = id
  call(api.search.testSource(source))
    .then((result) => {
      source.lastState = result.ok ? '正常' : '失败'
      source.lastMessage = result.message
      source.lastTestedAt = new Date().toLocaleString('zh-CN')
      if (result.ok) {
        ElMessage.success(`${source.name}：${result.message}${result.sampleTitles.length ? ` 例：${result.sampleTitles[0]}` : ''}`)
      } else {
        ElMessage.error(`${source.name}：${result.message}`)
      }
    })
    .catch((error: Error) => ElMessage.error(error.message))
    .finally(() => {
      testingSourceId.value = ''
    })
}

function clearSearchCache(): void {
  void call(api.search.clearCache())
    .then(async () => {
      cacheMeta.value = await call(api.search.cacheMeta())
      ElMessage.success('检索缓存已清空，下次检索将重新联网')
    })
    .catch((error: Error) => ElMessage.error(error.message))
}

function openDataDir(): void {
  void call(api.openDataDir()).catch((error: Error) => ElMessage.error(error.message))
}

async function clearLogs(): Promise<void> {
  try {
    await ElMessageBox.confirm('清空全部操作记录？该操作不可撤销。', '清空确认', { type: 'warning' })
  } catch {
    return
  }
  await call(api.logs.clear())
  await refreshLogs()
  ElMessage.success('操作记录已清空')
}
</script>

<template>
  <el-container class="app-shell">
    <el-aside width="228px" class="side-panel">
      <div class="brand">
        <div class="brand-mark">G</div>
        <div>
          <strong>Game Hub</strong>
          <span>PC 游戏资源服务工具</span>
        </div>
      </div>
      <nav class="navigation" aria-label="主导航">
        <button
          v-for="item in navigation"
          :key="item.key"
          class="nav-item"
          :class="{ active: activeView === item.key }"
          type="button"
          @click="go(item.key)"
        >
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </button>
      </nav>
      <div class="side-footer">
        <el-tag effect="plain" type="success">真实文件操作</el-tag>
        <p>数据目录：<br /><span class="path-value">{{ state.info.dataDir || '初始化中…' }}</span></p>
        <el-button link type="primary" size="small" @click="openDataDir">打开数据目录</el-button>
      </div>
    </el-aside>

    <el-container>
      <el-header class="top-bar">
        <div>
          <p class="eyebrow">PC 游戏资源服务工具 · v{{ state.info.version }}</p>
          <h1>{{ currentTitle }}</h1>
        </div>
        <div class="top-actions">
          <el-select
            v-model="state.selectedGameId"
            placeholder="选择当前游戏"
            style="width: 240px"
            :disabled="state.games.length === 0"
          >
            <el-option v-for="game in state.games" :key="game.id" :label="game.name" :value="game.id" />
          </el-select>
          <el-button @click="go('resources')">资源中心</el-button>
        </div>
      </el-header>

      <el-main class="main-content">
        <section v-if="activeView === 'overview'" class="page-section">
          <div class="hero-block">
            <div>
              <p class="eyebrow">检索 · 备份 · 部署，全部落盘</p>
              <h2>把游戏资源真正管起来</h2>
              <p>
                真实读取 Steam 库与本地目录，真实备份与恢复存档，真实安装与卸载 MOD，
                并按在线资源目录聚合修改器、存档、MOD 与补丁。所有写操作都会留下记录与还原点。
              </p>
              <div class="hero-actions">
                <el-button type="primary" size="large" @click="go('games')">先建立游戏库</el-button>
                <el-button size="large" @click="go('mods')">管理 MOD</el-button>
              </div>
            </div>
            <div class="hero-summary">
              <div><span>游戏库</span><strong>{{ state.games.length }}</strong></div>
              <div><span>备份记录</span><strong>{{ state.backups.length }}</strong></div>
              <div><span>已部署 MOD</span><strong>{{ deployedMods }}</strong></div>
            </div>
          </div>

          <div class="stat-row">
            <div class="flat-panel"><h3>我的资源</h3><strong class="large-value">{{ state.library.length }}</strong><p>已收录的资源条目</p></div>
            <div class="flat-panel"><h3>下载队列</h3><strong class="large-value">{{ state.downloads.length }}</strong><p>含已完成与进行中</p></div>
            <div class="flat-panel">
              <h3>资源目录</h3>
              <strong class="large-value">{{ state.catalog.file.resources.length }}</strong>
              <p>来源：{{ state.catalog.source === 'online' ? '在线' : state.catalog.source === 'cache' ? '本地缓存' : '内置离线' }}</p>
            </div>
          </div>

          <el-alert
            v-if="!state.info.toolsAvailable"
            class="stack-gap"
            type="warning"
            :closable="false"
            show-icon
            title="未检测到随包解压工具 7za.exe，压缩包导入/导出不可用。可在「设置」中指定解压工具路径。"
          />

          <div class="section-heading">
            <div><p class="eyebrow">最近操作</p><h2>操作记录</h2></div>
            <el-button text type="primary" @click="go('logs')">查看全部</el-button>
          </div>
          <el-table :data="state.logs.slice(0, 6)" class="flat-table">
            <el-table-column prop="action" label="操作" width="160" />
            <el-table-column prop="target" label="目标" min-width="260" />
            <el-table-column prop="time" label="时间" width="180" />
            <el-table-column label="结果" width="90">
              <template #default="scope">
                <el-tag :type="scope.row.status === '成功' ? 'success' : 'danger'" size="small">{{ scope.row.status }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </section>

        <GameLibrary v-else-if="activeView === 'games'" />
        <SaveManager v-else-if="activeView === 'saves'" />
        <ModManager v-else-if="activeView === 'mods'" />
        <ResourceCenter v-else-if="activeView === 'resources'" />

        <section v-else-if="activeView === 'logs'" class="page-section">
          <div class="section-heading">
            <div><p class="eyebrow">可追溯</p><h2>操作记录</h2><p class="desc">每次真实写入都会落盘记录，最多保留 500 条。</p></div>
            <el-button :disabled="state.logs.length === 0" @click="clearLogs">清空记录</el-button>
          </div>
          <el-table :data="state.logs" class="flat-table" stripe height="560">
            <el-table-column prop="action" label="操作" width="160" />
            <el-table-column prop="target" label="目标" min-width="280" />
            <el-table-column prop="detail" label="备注" min-width="200" />
            <el-table-column prop="time" label="时间" width="180" />
            <el-table-column label="结果" width="90">
              <template #default="scope">
                <el-tag :type="scope.row.status === '成功' ? 'success' : 'danger'" size="small">{{ scope.row.status }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </section>

        <section v-else-if="activeView === 'settings'" class="page-section">
          <div class="section-heading">
            <div><p class="eyebrow">本地配置</p><h2>设置</h2><p class="desc">配置保存在 {{ state.info.dataDir }}\config.json。</p></div>
          </div>
          <el-form label-position="top" class="settings-form">
            <el-form-item label="滚动备份保留份数（不含固定备份）">
              <el-input-number v-model="settingsForm.backupKeep" :min="1" :max="50" />
            </el-form-item>
            <el-form-item label="解压工具路径（留空则使用随包 7za.exe）">
              <el-input v-model="settingsForm.archiveTool" placeholder="例如 C:\Program Files\7-Zip\7z.exe">
                <template #append><el-button @click="pickArchiveTool">选择</el-button></template>
              </el-input>
            </el-form-item>
            <el-form-item label="在线资源目录地址（单源兼容模式，留空使用内置离线数据）">
              <el-input v-model="settingsForm.catalogBaseUrl" placeholder="例如 https://example.com/api/catalog.json" />
            </el-form-item>
            <el-form-item label="启动时自动刷新在线目录">
              <el-switch v-model="settingsForm.catalogAutoRefresh" />
            </el-form-item>

            <el-divider content-position="left">在线检索数据源</el-divider>
            <el-alert
              type="info"
              :closable="false"
              show-icon
              class="stack-gap"
              title="数据源契约"
              description="内置预置源：GameBanana 与 GitHub 开源源，开箱即用、免鉴权，可在卡片上停用或删除。自定义 JSON 源：GET 地址返回 { resources: [...] }，字段与资源目录一致（id / title / kind / gameName / version / downloadUrl 等，宽松缺省）。RSS 源：GET 订阅地址返回 RSS 2.0 或 Atom，条目会映射为「待核实」资源且不含下载地址。GameBanana / GitHub 源由内置适配器把第三方结构映射到统一资源字段；即使类型被误选成「JSON 接口」，也会按响应结构自动识别该用哪个适配器。GameBanana 结果会按分区过滤掉文章、讨论、问答等非资源条目，并把源站标记的「已停更」标为「不适配」。地址里可写 {keyword} 占位符，检索时替换为当前关键词（关键词为空则跳过该源）。多源结果跨源去重合并，同一资源被多源命中时标注「多源命中」。"
            />

            <SearchSourceCard
              v-for="(item, index) in settingsForm.searchSources"
              :key="item.id"
              :source="item"
              :index="index"
              :testing="testingSourceId === item.id"
              @test="testSource"
              @remove="removeSource"
            />

            <div class="source-add">
              <el-button @click="addSource">新增数据源</el-button>
              <span v-if="cacheMeta.capturedAt" class="muted">
                检索缓存：{{ cacheMeta.count }} 条 · 采集于 {{ cacheMeta.capturedAt }}
              </span>
              <el-button link type="primary" @click="clearSearchCache">清除检索缓存</el-button>
            </div>

            <el-divider />
            <el-form-item label="检索缓存有效期（分钟）">
              <el-input-number v-model="settingsForm.searchCacheTtlMinutes" :min="1" :max="1440" />
            </el-form-item>
            <el-form-item label="单源请求超时（毫秒）">
              <el-input-number v-model="settingsForm.searchTimeoutMs" :min="1000" :max="60000" :step="1000" />
            </el-form-item>

            <el-form-item label="数据目录">
              <el-input :model-value="state.info.dataDir" readonly>
                <template #append><el-button @click="openDataDir">打开</el-button></template>
              </el-input>
            </el-form-item>
            <el-alert
              type="info"
              :closable="false"
              show-icon
              class="stack-gap"
              title="合规边界"
              description="本工具不提供联网游戏辅助、反作弊规避、DRM 绕过、账号体系规避与破解分发能力；仅面向单机、本地文件与可追溯资源场景。"
            />
            <el-button type="primary" :loading="savingSettings" @click="saveSettings">保存设置</el-button>
          </el-form>
        </section>
      </el-main>
    </el-container>
  </el-container>
</template>
