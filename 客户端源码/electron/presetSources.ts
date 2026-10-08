/**
 * 内置预置数据源。
 *
 * 这些源来自经过实测可用的**开源 / 公开**服务，随应用提供，用户开箱即用，
 * 可在设置页停用或删除（删除后不会自动恢复）。
 *
 * 实测结论（2026-10-06，见 `正式文件\PC游戏资源服务工具 0.5.0 开源数据源接入说明.md`）：
 * - GameBanana apiv11：公开 API，免鉴权，`Util/Search/Results` 支持 `_sSearchString` 关键词检索。
 * - GitHub REST API：公开 API，免鉴权（未带 Token 时有速率限制）。
 *
 * 未采用：
 * - PCGamingWiki Cargo API：Cloudflare 返回 403，本机不可达。
 * - Nexus Mods API：需 OAuth / API Key，非「开箱即用」。
 * - ModDB RSS：Cloudflare 返回 403。
 * - Thunderstore：单次响应约 332 MB，不适合作为聚合源。
 *
 * 合规：预置源只做「检索与呈现」，资源条目一律标为「待核实」，不提供任何绕过检测的能力。
 */
import type { SearchSource } from './types.js'

/** 预置源 id 固定，便于配置合并与去重时保持稳定。 */
export const PRESET_SOURCE_IDS = ['preset-gamebanana', 'preset-github'] as const

/**
 * 预置源定义。
 * `url` 中的 `{keyword}` 在检索时替换为当前关键词；关键词为空则跳过该源。
 */
export const presetSources: SearchSource[] = [
  {
    id: 'preset-gamebanana',
    name: 'GameBanana',
    kind: 'gamebanana',
    url: 'https://gamebanana.com/apiv11/Util/Search/Results?_sSearchString={keyword}&_nPerpage=30',
    enabled: true,
    sourceLabel: 'GameBanana',
    priority: 60,
    headers: '',
    lastTestedAt: '',
    lastState: '未测试',
    lastMessage: '',
    preset: true,
    presetNote:
      '公开 API，免鉴权。收录 4,700+ 款游戏的 MOD / 皮肤 / 工具类资源，条目一律标「待核实」，下载与授权请以 GameBanana 页面为准。',
  },
  {
    id: 'preset-github',
    name: 'GitHub 开源项目',
    kind: 'github',
    url: 'https://api.github.com/search/repositories?q={keyword}&per_page=30&sort=stars&order=desc',
    enabled: true,
    sourceLabel: 'GitHub',
    priority: 70,
    headers: '',
    lastTestedAt: '',
    lastState: '未测试',
    lastMessage: '',
    preset: true,
    presetNote:
      '公开 API，免鉴权。检索开源工具 / 存档编辑器 / 修改器等项目仓库，需到仓库 Release 页自行下载。未带 Token 时搜索接口限流约 10 次/分钟；可在下方请求头填 `Authorization: Bearer <你的 Token>` 提升额度。',
  },
]

/**
 * 把预置源并入已保存的数据源列表。
 *
 * 规则：**仅当保存列表为空时注入**。这样首次安装与从旧版本升级（旧配置 `searchSources` 为 `[]`）
 * 都能拿到预置源，而用户主动删除后不会在下次启动被强行加回。
 */
export function withPresets(saved: SearchSource[]): SearchSource[] {
  if (!Array.isArray(saved) || saved.length === 0) {
    return presetSources.map((source) => ({ ...source }))
  }
  return saved
}
