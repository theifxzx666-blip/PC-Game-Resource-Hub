<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, call } from '../api'
import { baseName } from '../utils/modPath'
import { state, refreshGameScoped, selectedGame } from '../state'
import type { ModEntry, PlanItem } from '../types'

const busy = ref(false)
const selected = ref<ModEntry[]>([])
const planVisible = ref(false)
const planName = ref('')
const planItems = ref<PlanItem[]>([])
const planOverwrite = ref(0)
const deployVisible = ref(false)
const deployName = ref('')
const deployFiles = ref<{ target: string; created: boolean }[]>([])
const editing = ref<ModEntry | null>(null)
const editForm = ref({ name: '', version: '', tags: '' })
const profileName = ref('')

const game = computed(() => selectedGame())
const gameId = computed(() => state.selectedGameId)
const enabledCount = computed(() => state.mods.filter((item) => item.deployed.length > 0).length)

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

function requireGame(): string {
  if (!gameId.value) throw new Error('请先在顶部选择「当前游戏」。')
  return gameId.value
}

function importArchives(): void {
  void guard(async () => {
    const id = requireGame()
    const files = await call(api.dialog.pickFiles([{ name: 'MOD 压缩包', extensions: ['zip', '7z', 'rar'] }]))
    if (files.length === 0) return
    const result = await call(api.mods.import(files, id))
    await refreshGameScoped()
    if (result.imported.length > 0) ElMessage.success(`已导入 ${result.imported.length} 个 MOD`)
    for (const item of result.failed) ElMessage.error(item)
  })
}

function importFolder(): void {
  void guard(async () => {
    const id = requireGame()
    const dir = await call(api.dialog.pickDirectory())
    if (!dir) return
    const result = await call(api.mods.import([dir], id))
    await refreshGameScoped()
    if (result.imported.length > 0) ElMessage.success(`已导入：${result.imported[0].name}`)
    for (const item of result.failed) ElMessage.error(item)
  })
}

async function toggle(mod: ModEntry): Promise<void> {
  const willEnable = mod.deployed.length === 0
  if (willEnable) {
    const plan = await call(api.mods.plan(mod.id)).catch(() => null)
    if (plan && plan.overwriteCount > 0) {
      try {
        await ElMessageBox.confirm(
          `「${mod.name}」将覆盖游戏中已存在的 ${plan.overwriteCount} 个文件。安装前会自动为这些文件建立还原点，是否继续？`,
          '覆盖确认',
          { type: 'warning', confirmButtonText: '建立还原点并安装', cancelButtonText: '取消' },
        )
      } catch {
        return
      }
    }
  } else {
    try {
      await ElMessageBox.confirm(`停用「${mod.name}」会按部署记录移除它写入的所有文件，是否继续？`, '停用确认', {
        type: 'warning',
        confirmButtonText: '停用并移除文件',
        cancelButtonText: '取消',
      })
    } catch {
      return
    }
  }
  await guard(async () => {
    await call(api.mods.setEnabled(mod.id, willEnable))
    await refreshGameScoped()
    ElMessage.success(willEnable ? 'MOD 已启用' : 'MOD 已停用')
  })
}

function showPlan(mod: ModEntry): void {
  void guard(async () => {
    const plan = await call(api.mods.plan(mod.id))
    planName.value = mod.name
    planItems.value = plan.items.slice(0, 300)
    planOverwrite.value = plan.overwriteCount
    planVisible.value = true
  })
}

function showDeploy(mod: ModEntry): void {
  deployName.value = mod.name
  deployFiles.value = mod.deployed.map((item) => ({ target: item.target, created: item.created }))
  deployVisible.value = true
}

function openEditor(mod: ModEntry): void {
  editing.value = mod
  editForm.value = { name: mod.name, version: mod.version, tags: mod.tags.join('、') }
}

function saveEditor(): void {
  const mod = editing.value
  if (!mod) return
  void guard(async () => {
    await call(api.mods.update(mod.id, {
      name: editForm.value.name.trim() || mod.name,
      version: editForm.value.version.trim(),
      tags: editForm.value.tags.split(/[、,，\s]+/).filter(Boolean),
    }))
    editing.value = null
    await refreshGameScoped()
  })
}

async function remove(mod: ModEntry): Promise<void> {
  if (mod.deployed.length > 0) {
    ElMessage.warning('请先停用该 MOD 再删除。')
    return
  }
  try {
    await ElMessageBox.confirm(`删除已导入的「${mod.name}」？工具内的源文件会被移除。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await guard(async () => {
    await call(api.mods.remove(mod.id))
    await refreshGameScoped()
  })
}

function batch(mode: 'enable' | 'disable' | 'remove'): void {
  const mods = [...selected.value]
  if (mods.length === 0) {
    ElMessage.warning('请先勾选 MOD。')
    return
  }
  void guard(async () => {
    for (const mod of mods) {
      try {
        if (mode === 'enable' && mod.deployed.length === 0) await call(api.mods.setEnabled(mod.id, true))
        if (mode === 'disable' && mod.deployed.length > 0) await call(api.mods.setEnabled(mod.id, false))
        if (mode === 'remove' && mod.deployed.length === 0) await call(api.mods.remove(mod.id))
      } catch (error) {
        ElMessage.warning(`${mod.name}：${(error as Error).message}`)
      }
    }
    selected.value = []
    await refreshGameScoped()
    ElMessage.success('批量操作完成')
  })
}

function saveProfile(): void {
  void guard(async () => {
    const id = requireGame()
    await call(api.mods.profiles.save(id, profileName.value.trim()))
    profileName.value = ''
    await refreshGameScoped()
    ElMessage.success('已保存当前配置档案')
  })
}

function applyProfile(profileId: string): void {
  void guard(async () => {
    await call(api.mods.profiles.apply(profileId))
    await refreshGameScoped()
    ElMessage.success('已切换配置档案')
  })
}

function removeProfile(profileId: string): void {
  void guard(async () => {
    await call(api.mods.profiles.remove(profileId))
    await refreshGameScoped()
  })
}
</script>

<template>
  <section class="page-section">
    <div class="section-heading">
      <div>
        <p class="eyebrow">真实部署 · 可完整卸载</p>
        <h2>MOD 管理</h2>
        <p class="desc">
          导入 zip / 7z / rar 或文件夹，安装时记录部署文件与覆盖还原点；停用即按部署记录移除，冲突会明确提示。
        </p>
      </div>
      <div class="heading-actions">
        <el-button :loading="busy" @click="importFolder">导入文件夹</el-button>
        <el-button type="primary" :loading="busy" @click="importArchives">导入压缩包</el-button>
      </div>
    </div>

    <el-alert
      v-if="game && !game.dir"
      class="stack-gap"
      type="warning"
      :closable="false"
      show-icon
      :title="`「${game.name}」未关联安装目录，无法安装 MOD。请到「游戏库 → 配置」中填写。`"
    />

    <div class="stat-row">
      <div class="flat-panel"><h3>已导入</h3><strong class="large-value">{{ state.mods.length }}</strong><p>当前游戏</p></div>
      <div class="flat-panel"><h3>已部署</h3><strong class="large-value">{{ enabledCount }}</strong><p>正在写入游戏目录</p></div>
      <div class="flat-panel">
        <h3>冲突</h3>
        <strong class="large-value">{{ state.conflicts.length }}</strong>
        <p>多个已部署 MOD 写入同一路径</p>
      </div>
    </div>

    <el-alert
      v-for="conflict in state.conflicts"
      :key="conflict.target"
      class="stack-gap"
      type="warning"
      :closable="false"
      show-icon
      :title="`冲突：${conflict.modNames.join(' 与 ')} 同时写入同一文件`"
      :description="conflict.target"
    />

    <div class="flat-panel stack-gap">
      <h3>配置档案</h3>
      <p class="table-subtitle">保存当前 MOD 启用组合，之后可一键切换。</p>
      <div class="heading-actions">
        <el-input v-model="profileName" placeholder="档案名称" style="width: 200px" />
        <el-button :loading="busy" :disabled="!gameId" @click="saveProfile">保存当前为档案</el-button>
      </div>
      <div class="tag-row">
        <el-tag v-for="profile in state.profiles" :key="profile.id" size="large" effect="plain">
          {{ profile.name }}（{{ profile.enabled.length }} 启用）
          <el-button link type="primary" size="small" @click="applyProfile(profile.id)">切换</el-button>
          <el-button link type="danger" size="small" @click="removeProfile(profile.id)">删除</el-button>
        </el-tag>
        <span v-if="state.profiles.length === 0" class="muted">暂无配置档案</span>
      </div>
    </div>

    <div class="section-heading compact">
      <div><p class="eyebrow">批量操作</p><h2>MOD 列表</h2></div>
      <div class="heading-actions">
        <el-button :disabled="busy || selected.length === 0" @click="batch('enable')">批量启用</el-button>
        <el-button :disabled="busy || selected.length === 0" @click="batch('disable')">批量停用</el-button>
        <el-button type="danger" plain :disabled="busy || selected.length === 0" @click="batch('remove')">批量删除</el-button>
      </div>
    </div>

    <el-table :data="state.mods" class="flat-table" stripe @selection-change="(rows: ModEntry[]) => (selected = rows)">
      <el-table-column type="selection" width="46" />
      <el-table-column label="MOD" min-width="240">
        <template #default="scope">
          <strong>{{ scope.row.name }}</strong>
          <p class="table-subtitle">
            {{ scope.row.version || '未标注版本' }} · 来源 {{ baseName(scope.row.sourceDir) }} · {{ scope.row.entryCount }} 个文件
          </p>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="100">
        <template #default="scope"><el-tag size="small" effect="plain">{{ scope.row.type }}</el-tag></template>
      </el-table-column>
      <el-table-column label="标签" min-width="150">
        <template #default="scope">
          <el-tag v-for="tag in scope.row.tags" :key="tag" size="small" effect="plain" class="tag-inline">{{ tag }}</el-tag>
          <span v-if="scope.row.tags.length === 0" class="muted">-</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="120">
        <template #default="scope">
          <el-tag :type="scope.row.deployed.length > 0 ? 'success' : 'info'" size="small">
            {{ scope.row.deployed.length > 0 ? `已部署 ${scope.row.deployed.length}` : '未部署' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="300" fixed="right">
        <template #default="scope">
          <el-button link :type="scope.row.deployed.length > 0 ? 'danger' : 'primary'" @click="toggle(scope.row)">
            {{ scope.row.deployed.length > 0 ? '停用' : '启用' }}
          </el-button>
          <el-button link type="primary" @click="showPlan(scope.row)">安装计划</el-button>
          <el-button link type="primary" @click="showDeploy(scope.row)">部署文件</el-button>
          <el-button link type="primary" @click="openEditor(scope.row)">编辑</el-button>
          <el-button link type="danger" @click="remove(scope.row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="state.mods.length === 0" description="当前游戏还没有导入 MOD" />

    <el-dialog v-model="planVisible" :title="`安装计划：${planName}`" width="720px">
      <p class="table-subtitle">
        共 {{ planItems.length }} 个文件将写入游戏目录，其中 {{ planOverwrite }} 个会覆盖已有文件（覆盖前自动建立还原点）。
      </p>
      <el-table :data="planItems" height="360">
        <el-table-column prop="source" label="来源" min-width="240" />
        <el-table-column prop="target" label="写入目标" min-width="240" />
        <el-table-column label="覆盖" width="80">
          <template #default="scope">
            <el-tag :type="scope.row.overwrite ? 'warning' : 'success'" size="small">
              {{ scope.row.overwrite ? '是' : '新增' }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <el-dialog v-model="deployVisible" :title="`部署文件：${deployName}`" width="720px">
      <el-table :data="deployFiles" height="360">
        <el-table-column prop="target" label="文件路径" min-width="400" />
        <el-table-column label="来源" width="100">
          <template #default="scope">
            <el-tag :type="scope.row.created ? 'success' : 'warning'" size="small">
              {{ scope.row.created ? '新增' : '覆盖' }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <el-dialog v-model="editing" title="编辑 MOD" width="520px">
      <el-form v-if="editing" label-position="top">
        <el-form-item label="名称"><el-input v-model="editForm.name" /></el-form-item>
        <el-form-item label="版本"><el-input v-model="editForm.version" /></el-form-item>
        <el-form-item label="标签（用、或逗号分隔）"><el-input v-model="editForm.tags" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editing = null">取消</el-button>
        <el-button type="primary" :loading="busy" @click="saveEditor">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.tag-inline {
  margin-right: 4px;
}
</style>
