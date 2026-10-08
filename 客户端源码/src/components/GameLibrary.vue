<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, call, formatBytes } from '../api'
import type { SaveDiffItem, SavePathCandidate, SavePathOrigin, SaveProbeResult } from '../api'
import { state, refreshGames, refreshGameScoped, refreshIcons, selectedGame } from '../state'
import type { Game, SteamStoreCandidate } from '../types'

const busy = ref(false)
const keyword = ref('')
const editing = ref<Game | null>(null)
const form = ref({ name: '', aliases: '', dir: '', savePaths: '' })

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return state.games
  return state.games.filter((game) =>
    [game.name, game.dir, ...game.aliases].join(' ').toLowerCase().includes(kw),
  )
})

/** 游戏图标 dataURL；没有则返回空串，由界面画首字母占位。 */
function iconOf(game: Game): string {
  return state.icons[game.id] ?? ''
}

function initialOf(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase()
}

function iconSourceLabel(source: string): string {
  const map: Record<string, string> = {
    'steam-cover': 'Steam 本地封面',
    'steam-cdn': 'Steam 官方封面',
    exe: '主程序图标',
    cache: '本地缓存',
  }
  return map[source] ?? ''
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

/**
 * 添加游戏目录。
 *
 * 取名称必须用 Element Plus 的输入弹窗：Electron 渲染层**不实现** `window.prompt`，
 * 旧实现的 `window.prompt(...)` 会直接失败，导致整个添加流程报错。
 * 名称在三处做了兜底（弹窗输入 → 目录名 → 后端「未命名游戏」），取消弹窗则安全退出。
 */
function pick(): void {
  void guard(async () => {
    const dir = await call(api.dialog.pickDirectory())
    if (!dir) return
    const fallbackName = dir.split(/[\\/]/).filter(Boolean).pop() ?? ''

    let name = fallbackName
    try {
      const input = await ElMessageBox.prompt('请输入游戏名称（用于展示与检索匹配）', '添加游戏目录', {
        confirmButtonText: '添加',
        cancelButtonText: '取消',
        inputValue: fallbackName,
        inputPlaceholder: '例如 Stardew Valley',
        inputValidator: () => true,
      })
      name = String(input.value ?? '').trim() || fallbackName
    } catch {
      // 用户取消：不添加，也不算错误
      return
    }

    const game = await call(api.games.add({ name, dir }))
    await refreshGames()
    void refreshIcons()
    state.selectedGameId = game.id
    await refreshGameScoped()
    ElMessage.success(`已添加：${game.name}`)
  })
}

/** 编辑弹窗内选择安装目录（写成具名函数，避免模板内生 async 箭头函数触发类型推断冲突）。 */
async function pickEditDir(): Promise<void> {
  try {
    const dir = await call(api.dialog.pickDirectory())
    if (dir) form.value.dir = dir
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

function scan(): void {
  void guard(async () => {
    const result = await call(api.games.scanSteam())
    await refreshGames()
    void refreshIcons()
    ElMessage.success(`扫描完成：识别 ${result.detected.length} 个，新增 ${result.added} 个`)
  })
}

function use(game: Game): void {
  state.selectedGameId = game.id
  void refreshGameScoped().catch((error: Error) => ElMessage.error(error.message))
}

function launch(game: Game): void {
  void guard(async () => {
    const message = await call(api.games.launch(game.id))
    ElMessage.success(message || '已请求启动游戏')
  })
}

function openDir(game: Game): void {
  void guard(async () => {
    if (!game.dir) throw new Error('该游戏未关联安装目录。')
    await call(api.games.openDir(game.id))
  })
}

function openStore(game: Game): void {
  if (!game.storeUrl) return
  void call(api.openExternal(game.storeUrl)).catch((error: Error) => ElMessage.error(error.message))
}

/** 在匹配弹窗里预览候选的商店页。 */
function previewStore(candidate: SteamStoreCandidate): void {
  void call(api.openExternal(candidate.storeUrl)).catch((error: Error) => ElMessage.error(error.message))
}

function openEditor(game: Game): void {
  editing.value = game
  form.value = {
    name: game.name,
    aliases: game.aliases.join('、'),
    dir: game.dir,
    savePaths: game.savePaths.join('\n'),
  }
}

function saveEditor(): void {
  const game = editing.value
  if (!game) return
  void guard(async () => {
    await call(
      api.games.update(game.id, {
        name: form.value.name.trim() || game.name,
        aliases: form.value.aliases.split(/[、,，\s]+/).filter(Boolean),
        dir: form.value.dir.trim(),
        savePaths: form.value.savePaths.split('\n').map((line) => line.trim()).filter(Boolean),
      }),
    )
    editing.value = null
    await refreshGames()
    await refreshGameScoped()
    ElMessage.success('已保存')
  })
}

// ---------------------------------------------------------------------------
// 图标与 Steam 资料匹配
// ---------------------------------------------------------------------------

/** 强制重算图标（例如误标了封面、或换了安装目录之后）。 */
function refreshIcon(game: Game): void {
  void guard(async () => {
    const result = await call(api.games.refreshIcon(game.id))
    if (result.dataUrl) state.icons[game.id] = result.dataUrl
    await refreshGames()
    ElMessage[result.dataUrl ? 'success' : 'warning'](
      result.dataUrl ? `图标已更新（来源：${iconSourceLabel(result.source) || result.source}）` : '未能取到图标，请检查安装目录或匹配 Steam 资料。',
    )
  })
}

const matchVisible = ref(false)
const matching = ref(false)
const applying = ref(false)
const matchTarget = ref<Game | null>(null)
const matchTerm = ref('')
const matchResults = ref<SteamStoreCandidate[]>([])

function openMatch(game: Game): void {
  matchTarget.value = game
  matchTerm.value = game.name
  matchResults.value = []
  matchVisible.value = true
  runMatch()
}

function runMatch(): void {
  const term = matchTerm.value.trim()
  if (!term) {
    ElMessage.warning('请输入要检索的游戏名称。')
    return
  }
  matching.value = true
  void call(api.games.steamSearch(term))
    .then((items) => {
      matchResults.value = items
      if (items.length === 0) ElMessage.warning('未检索到匹配的 Steam 条目，可换个关键词再试。')
    })
    .catch((error: Error) => ElMessage.error(error.message))
    .finally(() => {
      matching.value = false
    })
}

function applyMatch(candidate: SteamStoreCandidate): void {
  const game = matchTarget.value
  if (!game) return
  applying.value = true
  void call(
    api.games.applySteamMatch(game.id, {
      appid: candidate.appid,
      storeUrl: candidate.storeUrl,
      coverUrl: candidate.image,
    }),
  )
    .then(async (result) => {
      if (result.icon?.dataUrl) state.icons[game.id] = result.icon.dataUrl
      await refreshGames()
      matchVisible.value = false
      ElMessage.success(
        `已匹配「${candidate.name}」（appid ${candidate.appid}）` +
          (result.icon?.dataUrl ? `，图标来源：${iconSourceLabel(result.icon.source) || result.icon.source}` : ''),
      )
    })
    .catch((error: Error) => ElMessage.error(error.message))
    .finally(() => {
      applying.value = false
    })
}

async function remove(game: Game): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认从游戏库移除「${game.name}」？不会删除任何本地文件。`, '移除确认', {
      type: 'warning',
      confirmButtonText: '移除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await guard(async () => {
    await call(api.games.remove(game.id))
    await refreshGames()
    await refreshGameScoped()
    ElMessage.success('已移除')
  })
}

const current = computed(() => selectedGame())

// ---------------------------------------------------------------------------
// 存档路径自动定位
// ---------------------------------------------------------------------------

const probeVisible = ref(false)
const probing = ref(false)
const probeResult = ref<SaveProbeResult | null>(null)
const selectedPaths = ref<string[]>([])
const snapshotInfo = ref<{ capturedAt: string } | null>(null)
const diffItems = ref<SaveDiffItem[]>([])
const diffing = ref(false)

const ORIGIN_LABEL: Record<SavePathOrigin, string> = {
  library: '存档知识库',
  'known-rule': '内置规则',
  'game-name-dir': '目录名匹配',
  appdata: 'AppData',
  documents: '我的文档',
  'saved-games': '保存的游戏',
  'install-dir': '安装目录内',
  snapshot: '启动差分',
}

function originLabel(origin: SavePathOrigin): string {
  return ORIGIN_LABEL[origin] ?? origin
}

function scoreType(score: number): 'success' | 'warning' | 'info' {
  if (score >= 85) return 'success'
  if (score >= 65) return 'warning'
  return 'info'
}

function fmtTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 打开「自动定位」弹窗并执行一键探测。 */
function openProbe(): void {
  const game = editing.value
  if (!game) return
  probeVisible.value = true
  probeResult.value = null
  selectedPaths.value = []
  snapshotInfo.value = null
  diffItems.value = []
  void runProbe()
}

function runProbe(): void {
  const game = editing.value
  if (!game) return
  probing.value = true
  void call(api.saves.probePaths(game.id))
    .then((result) => {
      probeResult.value = result
      // 默认勾选：存在的、得分最高的前 1 条，避免用户还要手动挑
      const first = result.candidates.find((item) => item.exists)
      selectedPaths.value = first ? [first.path] : []
    })
    .catch((error: Error) => ElMessage.error(error.message))
    .finally(() => {
      probing.value = false
    })
}

/** 建立快照基线，之后可启动游戏做差分定位。 */
function takeSnapshot(): void {
  const game = editing.value
  if (!game) return
  void guard(async () => {
    const dirs = probeResult.value?.candidates.filter((item) => item.exists).map((item) => item.path) ?? []
    const result = await call(api.saves.snapshotTake(game.id, dirs))
    snapshotInfo.value = { capturedAt: result.capturedAt }
    diffItems.value = []
    ElMessage.success(`已建立基线，监控 ${result.monitored} 个目录。请启动游戏并产生存档后回来点「对比变动」。`)
  })
}

/** 启动游戏前后差分，实测锁定真正发生变动的目录。 */
function runDiff(): void {
  const game = editing.value
  if (!game) return
  diffing.value = true
  void call(api.saves.snapshotDiff(game.id))
    .then((result) => {
      diffItems.value = result.items
      if (result.items.length === 0) {
        ElMessage.warning('未检测到变动。请确认已启动游戏并实际保存过进度。')
        return
      }
      // 差分命中即勾选
      selectedPaths.value = [...new Set([...selectedPaths.value, ...result.items.map((i) => i.path)])]
      ElMessage.success(`识别到 ${result.items.length} 个变动目录，已自动勾选。`)
    })
    .catch((error: Error) => ElMessage.error(error.message))
    .finally(() => {
      diffing.value = false
    })
}

/** 表格多选变化：抽成具名函数，避免模板内联箭头函数触发类型推断问题。 */
function onSelectionChange(rows: SavePathCandidate[]): void {
  selectedPaths.value = rows.map((row) => row.path)
}

/** 把勾选的候选路径写入存档路径输入框。 */
function applySelected(): void {
  const picked = selectedPaths.value
  if (picked.length === 0) {
    ElMessage.warning('请先勾选至少一条候选路径。')
    return
  }
  const existing = form.value.savePaths
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const merged = [...new Set([...existing, ...picked])]
  form.value.savePaths = merged.join('\n')
  probeVisible.value = false
  ElMessage.success(`已填入 ${picked.length} 条存档路径，别忘了点「保存」。`)
}
</script>

<template>
  <section class="page-section">
    <div class="section-heading">
      <div>
        <p class="eyebrow">目录关联 · 真实识别</p>
        <h2>游戏库</h2>
        <p class="desc">通过 Steam 库扫描或手动选择目录建立游戏库，并配置存档路径（支持 %APPDATA% 等占位符）。</p>
      </div>
      <div class="heading-actions">
        <el-input v-model="keyword" placeholder="筛选游戏" clearable style="width: 180px" />
        <el-button :loading="busy" @click="scan">扫描 Steam 库</el-button>
        <el-button type="primary" :loading="busy" @click="pick">添加游戏目录</el-button>
      </div>
    </div>

    <el-alert
      v-if="!state.info.toolsAvailable"
      class="stack-gap"
      type="warning"
      :closable="false"
      show-icon
      title="未检测到解压工具（resources/tools/7za.exe）。zip / 7z 导入与归档导出将不可用，请在「设置」中指定路径。"
    />

    <el-table :data="filtered" class="flat-table" stripe>
      <el-table-column label="当前" width="70">
        <template #default="scope">
          <el-tag v-if="scope.row.id === state.selectedGameId" type="success" size="small">使用中</el-tag>
          <el-button v-else link type="primary" @click="use(scope.row)">切换</el-button>
        </template>
      </el-table-column>
      <el-table-column label="图标" width="66">
        <template #default="scope">
          <div class="game-icon" :title="iconSourceLabel(scope.row.iconSource)">
            <img v-if="iconOf(scope.row)" :src="iconOf(scope.row)" :alt="scope.row.name" />
            <span v-else class="game-icon-fallback">{{ initialOf(scope.row.name) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="游戏" min-width="200">
        <template #default="scope">
          <strong>{{ scope.row.name }}</strong>
          <p class="table-subtitle">{{ scope.row.aliases.join('、') || '无别名' }}</p>
        </template>
      </el-table-column>
      <el-table-column label="来源" width="90">
        <template #default="scope">
          <el-tag size="small" effect="plain">{{ scope.row.source === 'steam' ? 'Steam' : '手动' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="Steam 资料" width="140">
        <template #default="scope">
          <div v-if="scope.row.storeUrl" class="steam-cell">
            <el-button link type="primary" @click="openStore(scope.row)">资料页</el-button>
            <span class="muted">{{ scope.row.steamAppId }}</span>
          </div>
          <el-button v-else link type="primary" @click="openMatch(scope.row)">按名称匹配</el-button>
        </template>
      </el-table-column>
      <el-table-column label="安装目录" min-width="220">
        <template #default="scope">
          <span class="path-value" :title="scope.row.dir">{{ scope.row.dir || '未关联' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="存档路径" width="100">
        <template #default="scope">
          <el-tag :type="scope.row.savePaths.length ? 'success' : 'info'" size="small">
            {{ scope.row.savePaths.length }} 条
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="250" fixed="right">
        <template #default="scope">
          <el-button link type="primary" @click="openEditor(scope.row)">配置</el-button>
          <el-button link type="primary" :disabled="!scope.row.dir && !scope.row.appid" @click="launch(scope.row)">启动</el-button>
          <el-button link type="primary" :disabled="!scope.row.dir" @click="openDir(scope.row)">打开目录</el-button>
          <el-button link type="danger" @click="remove(scope.row)">移除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="filtered.length === 0" description="游戏库为空，先扫描 Steam 库或手动添加游戏目录" />

    <div v-if="current" class="flat-panel stack-gap">
      <div class="current-head">
        <div class="game-icon game-icon-lg" :title="iconSourceLabel(current.iconSource)">
          <img v-if="iconOf(current)" :src="iconOf(current)" :alt="current.name" />
          <span v-else class="game-icon-fallback">{{ initialOf(current.name) }}</span>
        </div>
        <h3>当前游戏：{{ current.name }}</h3>
      </div>
      <p class="table-subtitle">
        备份、MOD、补丁等操作都会针对「当前游戏」执行。存档路径可自行填写，支持
        <code>%APPDATA%</code>、<code>%USERPROFILE%</code>、<code>%DOCUMENTS%</code>、<code>%LOCALAPPDATA%</code> 占位符。
      </p>
      <div class="tag-row">
        <el-tag v-if="current.storeUrl" size="small" type="primary" effect="plain">
          Steam appid {{ current.steamAppId }}
        </el-tag>
        <el-tag v-for="path in current.savePaths" :key="path" size="small" effect="plain">{{ path }}</el-tag>
        <span v-if="current.savePaths.length === 0" class="muted">尚未配置存档路径，无法创建备份。</span>
      </div>
    </div>

    <el-dialog v-model="editing" title="配置游戏" width="640px">
      <el-form v-if="editing" label-position="top">
        <el-form-item label="游戏名称"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="别名（用、或逗号分隔，用于检索匹配）"><el-input v-model="form.aliases" /></el-form-item>
        <el-form-item label="安装目录">
          <el-input v-model="form.dir" placeholder="D:\\Games\\XXX">
            <template #append>
              <el-button @click="pickEditDir">选择</el-button>
            </template>
          </el-input>
        </el-form-item>
        <el-form-item label="图标与 Steam 资料">
          <div class="meta-row">
            <div class="game-icon" :title="iconSourceLabel(editing.iconSource)">
              <img v-if="iconOf(editing)" :src="iconOf(editing)" :alt="editing.name" />
              <span v-else class="game-icon-fallback">{{ initialOf(editing.name) }}</span>
            </div>
            <div class="meta-info">
              <span class="muted">
                图标来源：{{ iconSourceLabel(editing.iconSource) || '尚未生成' }}
                <template v-if="editing.iconUpdatedAt">· {{ editing.iconUpdatedAt }}</template>
              </span>
              <span class="muted">
                Steam 资料：
                <template v-if="editing.storeUrl">appid {{ editing.steamAppId }}</template>
                <template v-else>未匹配</template>
              </span>
            </div>
            <div class="meta-actions">
              <el-button size="small" @click="refreshIcon(editing)">重新生成图标</el-button>
              <el-button size="small" @click="openMatch(editing)">
                {{ editing.storeUrl ? '重新匹配' : '按名称匹配' }}
              </el-button>
              <el-button v-if="editing.storeUrl" size="small" link type="primary" @click="openStore(editing)">
                打开商店页
              </el-button>
            </div>
          </div>
          <p class="table-subtitle meta-tip">
            图标按「Steam 本地封面 → 主程序 exe 图标 → Steam 官方封面」顺序自动获取，
            缓存于数据目录 <code>icons/</code> 下；匹配 Steam 后会改用官方封面。
          </p>
        </el-form-item>
        <el-form-item label="存档路径（每行一条，支持占位符）">
          <div style="width: 100%">
            <div class="savepath-actions">
              <el-button size="small" type="primary" plain @click="openProbe">自动定位存档路径</el-button>
              <span class="muted">扫描本机常见存档位置，按置信度给出候选；也可启动游戏前后对比文件变动来实测锁定。</span>
            </div>
            <el-input v-model="form.savePaths" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" />
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editing = null">取消</el-button>
        <el-button type="primary" :loading="busy" @click="saveEditor">保存</el-button>
      </template>
    </el-dialog>

    <!-- 按名称匹配 Steam 资料页 -->
    <el-dialog v-model="matchVisible" title="按名称匹配 Steam 资料页" width="760px">
      <div class="match-head">
        <el-input v-model="matchTerm" placeholder="输入游戏名称，例如 Stardew Valley" @keyup.enter="runMatch">
          <template #append>
            <el-button :loading="matching" @click="runMatch">搜索</el-button>
          </template>
        </el-input>
      </div>
      <p class="table-subtitle" style="margin: 8px 0 12px">
        来自 Steam 商店公开检索接口，免登录、免 Key。选中后会写入资料页地址，并用官方封面刷新游戏图标；
        <strong>不会读取或修改你的 Steam 账号与库</strong>。
      </p>
      <el-table v-loading="matching" :data="matchResults" size="small" class="flat-table" empty-text="暂无候选，换个关键词再试">
        <el-table-column label="封面" width="140">
          <template #default="scope">
            <div class="match-cover">
              <img v-if="scope.row.image" :src="scope.row.image" :alt="scope.row.name" />
              <span v-else class="muted">无图</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="名称 / appid" min-width="220">
          <template #default="scope">
            <strong>{{ scope.row.name }}</strong>
            <p class="table-subtitle">appid {{ scope.row.appid }} · {{ scope.row.platforms || '—' }}</p>
          </template>
        </el-table-column>
        <el-table-column label="价格" width="100">
          <template #default="scope">
            <span>{{ scope.row.price || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="媒体评分" width="90">
          <template #default="scope">
            <span>{{ scope.row.metascore || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130">
          <template #default="scope">
            <el-button link type="primary" :loading="applying" @click="applyMatch(scope.row)">选用</el-button>
            <el-button link type="primary" @click="previewStore(scope.row)">预览</el-button>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="matchVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 存档路径自动定位 -->
    <el-dialog v-model="probeVisible" title="自动定位存档路径" width="860px">
      <div class="probe-head">
        <el-button size="small" :loading="probing" @click="runProbe">重新扫描</el-button>
        <el-button size="small" :disabled="probing" @click="takeSnapshot">① 建立基线</el-button>
        <el-button size="small" :loading="diffing" :disabled="!snapshotInfo" @click="runDiff">② 对比变动</el-button>
        <span v-if="snapshotInfo" class="muted">基线建立于 {{ fmtTime(snapshotInfo.capturedAt) }}</span>
      </div>
      <p class="probe-tip">
        「建立基线 → 启动游戏并保存进度 → 对比变动」可实测锁定真正的存档目录；
        <strong>建立基线只做只读扫描，不会修改任何用户文件。</strong>
      </p>

      <el-alert
        v-if="probeResult && probeResult.skipped.length"
        type="info"
        :closable="false"
        show-icon
        :title="probeResult.skipped.join('；')"
      />

      <div v-if="diffItems.length" class="diff-block">
        <h4>差分结果（按变动幅度排序）</h4>
        <el-table :data="diffItems" size="small" class="flat-table">
          <el-table-column label="路径" min-width="320">
            <template #default="scope">
              <span class="path-value" :title="scope.row.path">{{ scope.row.path }}</span>
            </template>
          </el-table-column>
          <el-table-column label="文件变化" width="100">
            <template #default="scope">
              <span :class="scope.row.fileCountDelta > 0 ? 'delta-up' : 'muted'">
                {{ scope.row.fileCountDelta > 0 ? '+' : '' }}{{ scope.row.fileCountDelta }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="体积变化" width="120">
            <template #default="scope">
              <span :class="scope.row.sizeBytesDelta > 0 ? 'delta-up' : 'muted'">
                {{ scope.row.sizeBytesDelta > 0 ? '+' : '' }}{{ formatBytes(Math.abs(scope.row.sizeBytesDelta)) }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="置信度" width="90">
            <template #default="scope">
              <el-tag size="small" :type="scoreType(scope.row.score)">{{ scope.row.score }}</el-tag>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <h4 style="margin: 16px 0 8px">扫描候选（勾选后填入）</h4>
      <el-table
        v-loading="probing"
        :data="probeResult?.candidates ?? []"
        size="small"
        class="flat-table"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="46" />
        <el-table-column label="路径" min-width="300">
          <template #default="scope">
            <span class="path-value" :title="scope.row.path">{{ scope.row.path }}</span>
            <p class="table-subtitle">{{ scope.row.reason }}</p>
          </template>
        </el-table-column>
        <el-table-column label="来源" width="100">
          <template #default="scope">
            <el-tag size="small" effect="plain">{{ originLabel(scope.row.origin) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="scope">
            <el-tag size="small" :type="scope.row.exists ? 'success' : 'info'">
              {{ scope.row.exists ? '存在' : '不存在' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="文件" width="80">
          <template #default="scope">
            <span v-if="scope.row.exists">{{ scope.row.fileCount }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="90">
          <template #default="scope">
            <span v-if="scope.row.exists">{{ formatBytes(scope.row.sizeBytes) }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="最近修改" width="140">
          <template #default="scope">
            <span v-if="scope.row.lastModified">{{ fmtTime(scope.row.lastModified) }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="置信度" width="90">
          <template #default="scope">
            <el-tag size="small" :type="scoreType(scope.row.score)">{{ scope.row.score }}</el-tag>
          </template>
        </el-table-column>
      </el-table>

      <el-empty
        v-if="!probing && probeResult && probeResult.candidates.length === 0"
        description="未找到候选。该游戏可能不在内置规则表中，且目录名无法匹配。可改用「建立基线 → 对比变动」的方式实测定位。"
      />

      <template #footer>
        <span class="muted" style="float: left; line-height: 32px">已选 {{ selectedPaths.length }} 条</span>
        <el-button @click="probeVisible = false">关闭</el-button>
        <el-button type="primary" :disabled="selectedPaths.length === 0" @click="applySelected">
          填入存档路径
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.game-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  overflow: hidden;
  border: 1px solid #e7ebf1;
  border-radius: 8px;
  background: #f1f4f9;
}

.game-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.game-icon-lg {
  width: 56px;
  height: 56px;
  border-radius: 10px;
}

.game-icon-fallback {
  font-size: 18px;
  font-weight: 600;
  color: #7b869c;
  user-select: none;
}

.current-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 6px;
}

.current-head h3 {
  margin: 0;
}

.steam-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.meta-row {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  flex-wrap: wrap;
}

.meta-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 220px;
  font-size: 12px;
}

.meta-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex-wrap: wrap;
}

.meta-tip {
  margin: 8px 0 0;
}

.match-head {
  margin-top: 4px;
}

.match-cover {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 132px;
  height: 50px;
  overflow: hidden;
  border: 1px solid #e7ebf1;
  border-radius: 6px;
  background: #f1f4f9;
}

.match-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
