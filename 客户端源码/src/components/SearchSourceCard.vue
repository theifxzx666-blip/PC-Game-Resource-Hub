<script setup lang="ts">
import type { SearchSource } from '../types'

const props = defineProps<{
  source: SearchSource
  index: number
  testing: boolean
}>()

const emit = defineEmits<{
  (event: 'test', id: string): void
  (event: 'remove', id: string): void
}>()

function stateType(value: string): 'success' | 'danger' | 'info' {
  return value === '正常' ? 'success' : value === '失败' ? 'danger' : 'info'
}
</script>

<template>
  <div class="source-card">
    <div class="source-head">
      <strong>数据源 {{ props.index + 1 }}</strong>
      <div class="source-head-right">
        <el-tag v-if="props.source.preset" type="primary" size="small" effect="plain">预置</el-tag>
        <el-tag :type="stateType(props.source.lastState)" size="small" effect="plain">
          {{ props.source.lastState }}
        </el-tag>
        <el-switch v-model="props.source.enabled" active-text="启用" inline-prompt />
        <el-button link type="danger" @click="emit('remove', props.source.id)">删除</el-button>
      </div>
    </div>

    <p v-if="props.source.presetNote" class="source-note">{{ props.source.presetNote }}</p>

    <label class="source-label">名称</label>
    <el-input v-model="props.source.name" placeholder="用于界面展示与日志" />

    <label class="source-label">类型</label>
    <el-radio-group v-model="props.source.kind">
      <el-radio-button value="json">JSON 接口</el-radio-button>
      <el-radio-button value="rss">RSS / Atom</el-radio-button>
      <el-radio-button value="gamebanana">GameBanana</el-radio-button>
      <el-radio-button value="github">GitHub</el-radio-button>
    </el-radio-group>

    <label class="source-label">地址</label>
    <el-input v-model="props.source.url" placeholder="https://example.com/api/resources.json" />

    <p class="source-hint">
      地址里写入 {{ '{keyword}' }} 即表示该源需要关键词：检索时自动替换为当前关键词，关键词为空时跳过该源。例如
      <code>https://api.github.com/search/repositories?q={{ '{keyword}' }}</code>。
    </p>

    <label class="source-label">来源标注（留空用源名称）</label>
    <el-input v-model="props.source.sourceLabel" placeholder="展示在资源卡片的来源字段" />

    <label class="source-label">优先级（数字越小越优先）</label>
    <el-input-number v-model="props.source.priority" :min="1" :max="999" />

    <label class="source-label">请求头（每行一条 Key: Value，可选）</label>
    <el-input v-model="props.source.headers" type="textarea" :rows="2" placeholder="Authorization: Bearer xxx" />

    <div class="source-foot">
      <el-button :loading="props.testing" @click="emit('test', props.source.id)">测试连通性</el-button>
      <span v-if="props.source.lastTestedAt" class="muted">
        上次测试 {{ props.source.lastTestedAt }}：{{ props.source.lastMessage || '—' }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.source-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
  padding: 14px 16px;
  background: #f8fafc;
  border: 1px solid #e7ebf1;
  border-radius: 10px;
}

.source-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px dashed #e2e8f0;
  margin-bottom: 4px;
}

.source-head-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.source-label {
  font-size: 12px;
  color: #6b7280;
  margin-top: 4px;
}

.source-note {
  margin: 0 0 4px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.6;
  color: #475569;
  background: #eef4ff;
  border-left: 3px solid #7aa2f7;
  border-radius: 4px;
}

.source-hint {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: #6b7280;
}

.source-hint code {
  padding: 1px 4px;
  font-size: 11px;
  color: #334155;
  background: #eef2f7;
  border-radius: 3px;
  word-break: break-all;
}

.source-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 8px;
}
</style>
