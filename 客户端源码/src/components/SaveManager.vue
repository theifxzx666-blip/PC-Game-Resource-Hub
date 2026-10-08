<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, call, formatBytes } from '../api'
import { state, refreshGameScoped, selectedGame } from '../state'
import type { BackupEntry } from '../types'

const busy = ref(false)
const note = ref('')
const inspectVisible = ref(false)
const inspectDetail = ref<{ total: number; files: string[] }>({ total: 0, files: [] })
const inspectName = ref('')

const game = computed(() => selectedGame())
const gameId = computed(() => state.selectedGameId)

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

function backup(): void {
  if (!gameId.value) {
    ElMessage.warning('请先在顶部选择「当前游戏」。')
    return
  }
  void guard(async () => {
    const entry = await call(api.saves.backup(gameId.value, note.value.trim()))
    note.value = ''
    await refreshGameScoped()
    ElMessage.success(`备份完成：${formatBytes(entry.sizeBytes)} / ${entry.fileCount} 个文件`)
  })
}

function importArchive(): void {
  void guard(async () => {
    const files = await call(api.dialog.pickFiles([{ name: '备份归档', extensions: ['zip'] }]))
    if (files.length === 0) return
    const added = await call(api.saves.import(files[0]))
    await refreshGameScoped()
    ElMessage.success(`已导入 ${added.length} 条备份记录`)
  })
}

async function restore(entry: BackupEntry): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `恢复「${entry.name}」会覆盖当前存档目录。恢复前工具会自动创建一份「恢复前自动备份」，是否继续？`,
      '确认恢复',
      { type: 'warning', confirmButtonText: '先备份再恢复', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  await guard(async () => {
    const result = await call(api.saves.restore(entry.gameId, entry.id))
    await refreshGameScoped()
    ElMessage.success(`已恢复到 ${result.restored.length} 个目录，自动备份号：${result.autoBackupId}`)
  })
}

function togglePin(entry: BackupEntry): void {
  void guard(async () => {
    await call(api.saves.pin(entry.gameId, entry.id, !entry.pinned))
    await refreshGameScoped()
  })
}

function inspect(entry: BackupEntry): void {
  void guard(async () => {
    inspectName.value = entry.name
    inspectDetail.value = await call(api.saves.inspect(entry.gameId, entry.id))
    inspectVisible.value = true
  })
}

function exportOne(entry: BackupEntry): void {
  void guard(async () => {
    const out = await call(api.saves.export(entry.gameId, entry.id))
    await call(api.revealFile(out))
    ElMessage.success(`已导出：${out}`)
  })
}

async function remove(entry: BackupEntry): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除备份「${entry.name}」？该操作不可撤销。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await guard(async () => {
    await call(api.saves.remove(entry.gameId, entry.id))
    await refreshGameScoped()
    ElMessage.success('已删除')
  })
}

function openBackupsDir(): void {
  void call(api.openDataDir()).catch((error: Error) => ElMessage.error(error.message))
}
</script>

<template>
  <section class="page-section">
    <div class="section-heading">
      <div>
        <p class="eyebrow">备份优先 · 可回溯</p>
        <h2>存档管理</h2>
        <p class="desc">
          备份为真实文件复制，恢复前会强制创建自动备份。滚动保留 {{ state.config.backupKeep }} 份非固定备份，固定备份永不清理。
        </p>
      </div>
      <div class="heading-actions">
        <el-input v-model="note" placeholder="备份备注（可选）" style="width: 200px" />
        <el-button :loading="busy" @click="importArchive">导入归档</el-button>
        <el-button :loading="busy" @click="openBackupsDir">打开数据目录</el-button>
        <el-button type="primary" :loading="busy" :disabled="!gameId" @click="backup">创建备份</el-button>
      </div>
    </div>

    <el-alert
      v-if="game && game.savePaths.length === 0"
      class="stack-gap"
      type="warning"
      :closable="false"
      show-icon
      :title="`「${game.name}」尚未配置存档路径，请到「游戏库 → 配置」中填写后再备份。`"
    />

    <el-table :data="state.backups" class="flat-table" stripe>
      <el-table-column label="备份名称" min-width="260">
        <template #default="scope">
          <strong>{{ scope.row.name }}</strong>
          <p class="table-subtitle">{{ scope.row.note || '无备注' }}</p>
        </template>
      </el-table-column>
      <el-table-column prop="createdAt" label="创建时间" width="180" />
      <el-table-column label="大小" width="110">
        <template #default="scope">{{ formatBytes(scope.row.sizeBytes) }}</template>
      </el-table-column>
      <el-table-column prop="fileCount" label="文件数" width="90" />
      <el-table-column label="状态" width="110">
        <template #default="scope">
          <el-tag v-if="scope.row.pinned" type="warning" size="small">已固定</el-tag>
          <span v-else class="muted">滚动保留</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="270" fixed="right">
        <template #default="scope">
          <el-button link type="primary" @click="restore(scope.row)">恢复</el-button>
          <el-button link type="primary" @click="togglePin(scope.row)">{{ scope.row.pinned ? '取消固定' : '固定' }}</el-button>
          <el-button link type="primary" @click="inspect(scope.row)">内容</el-button>
          <el-button link type="primary" @click="exportOne(scope.row)">导出</el-button>
          <el-button link type="danger" @click="remove(scope.row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="state.backups.length === 0" description="当前游戏还没有备份记录" />

    <el-dialog v-model="inspectVisible" :title="`备份内容：${inspectName}`" width="720px">
      <p class="table-subtitle">共 {{ inspectDetail.total }} 个文件，最多展示前 200 个。</p>
      <div class="file-list">
        <span v-for="file in inspectDetail.files" :key="file" class="path-value">{{ file }}</span>
      </div>
    </el-dialog>
  </section>
</template>

<style scoped>
.file-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 420px;
  overflow: auto;
}
</style>
