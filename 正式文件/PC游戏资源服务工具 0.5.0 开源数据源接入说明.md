# PC游戏资源服务工具 0.5.0 开源数据源接入说明

> 交付版本：`0.5.0`（在 0.4.0 多源聚合检索基础上，接入**开源 / 公开数据源**）
> 交付日期：2026-10-06
> 配套可执行文件：`正式文件\游戏资源服务工具演示 0.5.0.exe`

---

## 1. 本次做了什么

0.4.0 已经把「多源聚合检索」的骨架做完了，但**一个源都没接**，用户得自己填地址才有数据。

0.5.0 解决的就是这一步：把两个**公开、免鉴权**的开源数据源做成**内置预置源**，装上就能用。

| 能力 | 0.4.0 | 0.5.0 |
|---|---|---|
| 数据源 | 只能手填 JSON / RSS 地址 | 内置 GameBanana + GitHub 开源源，开箱即用 |
| 数据源类型 | `json` / `rss` | 新增 `gamebanana` / `github` 两类**适配器** |
| 关键词检索 | 本地过滤已拉取的列表 | 支持把关键词**送进数据源**（`{keyword}` 占位符） |
| 缓存 | 全量聚合缓存 | 区分「静态源缓存」与「关键词源实时结果」，避免串味 |

---

## 2. 为什么是这两个源

候选源都**实测过**，未采用的也记录原因，避免以后重复踩坑。

| 候选源 | 实测结果 | 结论 |
|---|---|---|
| **GameBanana apiv11** | `200 OK`，JSON，免鉴权，`Util/Search/Results` 支持 `_sSearchString` 关键词检索；收录 4,761 款游戏、557,626 条资源 | ✅ **采用** |
| **GitHub REST API** | `200 OK`，JSON，免鉴权；仓库搜索与 Release 列表均可用 | ✅ **采用** |
| PCGamingWiki Cargo API | `403 Forbidden`（Cloudflare）；换浏览器 UA 仍 403 | ❌ 本机不可达 |
| Nexus Mods API | `401 Unauthorized`，需 OAuth / API Key | ❌ 非「开箱即用」 |
| ModDB RSS | `403 Forbidden`（Cloudflare） | ❌ 本机不可达 |
| Thunderstore | `200 OK`，但单次响应 **332 MB** | ❌ 体积不适合做聚合源 |

> 参考项目背景：`Game-Save-Manager` 的存档库源自 PCGamingWiki（经其自有签名 S3 分发，非公开接口）；`mayflyMods` 对接 Nexus Mods。两者上游在本机都不可直连，因此改用可达且公开的 GameBanana 与 GitHub。

---

## 3. 预置源定义

两条预置源写在 `客户端源码\electron\presetSources.ts`，id 固定，便于配置合并与去重。

| 名称 | kind | 地址 | 优先级 | 说明 |
|---|---|---|---|---|
| GameBanana | `gamebanana` | `https://gamebanana.com/apiv11/Util/Search/Results?_sSearchString={keyword}&_nPerpage=30` | 60 | 收录 MOD / 皮肤 / 工具类资源 |
| GitHub 开源项目 | `github` | `https://api.github.com/search/repositories?q={keyword}&per_page=30&sort=stars&order=desc` | 70 | 检索开源工具 / 存档编辑器 / 修改器仓库 |

**注入策略**：只在配置里 `searchSources` 为空时注入一次，并把 `searchSourcesSeeded` 落盘为 `true`。
所以：

- 全新安装 → 自带两个预置源；
- 从 0.3.0 / 0.4.0 升级（旧配置 `searchSources` 为 `[]`）→ 自动补上；
- 用户主动删除后 → **不会**在下次启动被强行加回。

---

## 4. 适配器字段映射（实测响应结构）

### 4.1 GameBanana（`_aRecords[]`）

GameBanana 返回 `{ _aMetadata, _aRecords: [...] }` 信封，字段名带下划线前缀。

| 本工具字段 | GameBanana 字段 | 处理 |
|---|---|---|
| `id` | `_idRow` | 拼成 `gb-<id>` |
| `title` | `_sName` | 缺则丢弃该条 |
| `kind` | — | 由 `标题 + 分类` 关键词推断（见 4.3） |
| `gameName` | `_aGame._sName` | 直接映射 |
| `source` | `_aSubmitter._sName` | 空则回退源名称 |
| `updatedAt` | `_tsDateUpdated` → `_tsDateModified` → `_tsDateAdded` | **Unix 秒**转 `YYYY-MM-DD` |
| `tags` | `_aRootCategory._sName` + `_aSubCategory._sName` | 过滤空值，最多 6 个 |
| `version` | `_sVersion` | 直接映射 |
| `risk` | `_bHasContentRatings` | `true` → `中`，否则 `低` |
| `homepage` | `_sProfileUrl` | 直接映射 |
| `downloadUrl` | — | **留空**：检索接口不返回文件直链，引导回源站下载 |
| `status` | — | 一律 `待核实` |

### 4.2 GitHub（两种形态自动识别）

**形态一：仓库搜索** `{ total_count, items: [...] }`

| 本工具字段 | GitHub 字段 | 处理 |
|---|---|---|
| `id` | `id` | 拼成 `gh-repo-<id>` |
| `title` | `full_name` | 如 `mtkennerly/ludusavi` |
| `source` | `owner.login` | 作者 / 组织 |
| `updatedAt` | `pushed_at` → `updated_at` | 取 ISO 8601 前 10 位 |
| `tags` | `topics` | 最多 6 个 |
| `description` | `description` + `license.spdx_id` + `stargazers_count` | 拼成 `说明 · 许可 MIT · ★ 308` |
| `homepage` | `html_url` | 仓库主页 |
| `downloadUrl` | — | 留空，需到仓库 Release 页下载 |

**形态二：Release 列表** `[ {...} ]`

| 本工具字段 | GitHub 字段 | 处理 |
|---|---|---|
| `id` | `id` | 拼成 `gh-rel-<id>` |
| `title` | `name` | 空则回退 `<owner/repo> <tag>` |
| `version` | `tag_name` | 直接映射 |
| `downloadUrl` | `assets[0].browser_download_url` | 取**第一个有直链的资产** |
| `fileName` | `assets[0].name` | 与上面对应 |
| `updatedAt` | `published_at` | 取前 10 位 |
| `source` | `author.login` | 发布者 |
| `description` | `body` | 剥离 HTML 标签后截断 400 字 |
| `risk` | `prerelease` | `true` → `中`，否则 `低` |

### 4.3 类型推断规则

适配器不依赖源端分类，统一按 `标题 + 描述 + 分类/标签` 文本推断本工具的 `kind`：

| 命中关键词 | 判定 |
|---|---|
| `补丁` / `patch` / `汉化` / `localization` / `translation` | 补丁 |
| `存档` / `save file` / `savedata` | 存档 |
| `修改器` / `trainer` / `cheat` / `editor` / `修改工具` | 修改器 |
| 其余 | MOD |

---

## 5. `{keyword}` 占位符

数据源地址里写 `{keyword}` 即表示**该源需要关键词**：

- 检索时自动替换为当前关键词（URL 编码后拼入）；
- 关键词为空时**不向其发起请求**，状态里标记 `需输入关键词`，界面顶部给出提示；
- 结果**不写入聚合缓存**（结果随关键词变化，缓存会串味）。

对比：不含 `{keyword}` 的源属于「静态源」，行为与 0.4.0 一致 —— 拉一次全量列表、本地过滤、写聚合缓存。

**两类源的结果会在同一轮检索中合并去重**，同 id（或「标题 + 游戏名」归一）只保留一条，并累积溯源信息。

---

## 6. 缓存与降级

| 情况 | 行为 |
|---|---|
| 静态源 + 缓存未过期 | 直接用缓存，不发请求 |
| 静态源 + 缓存过期 / 点「联网刷新」 | 真实联网，成功则刷新缓存 |
| 静态源全部失败 | 回退上一次缓存 |
| 静态源失败且无缓存 | 回退内置离线目录（5 条演示数据） |
| 关键词源 | 每轮实时拉取，不读写聚合缓存 |
| 一个源都没启用 | 回退旧的「在线资源目录地址」单源模式，再退离线目录 |

界面顶部「结果来源」标签会明确区分 `实时联网` / `本地缓存` / `离线兜底`，不会拿缓存冒充实时数据。

---

## 7. 界面用法

**设置 → 在线检索数据源**

- 预置源卡片带 `预置` 蓝色标签，卡片上方蓝框是数据来源与限流说明；
- 每条源可「启用 / 停用」「删除」「测试连通性」；
- GitHub 源想提高额度：在「请求头」填 `Authorization: Bearer <你的 Token>`。

**资源中心**

- 输入游戏名 / 资源名回车即检索（GameBanana 与 GitHub 只有输入关键词才会被请求）；
- 关键词为空时，顶部会有信息条提示「GameBanana、GitHub 开源项目 需要关键词才会检索」；
- 来源标签、耗时、`源正常` 计数实时展示；失败的源逐条黄色告警并附原因；
- 卡片动作：详情 / 加入我的资源 / 下载（`downloadUrl` 为空时自动禁用）/ 复制链接 / 打开主页。

---

## 8. 排障对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| 顶部提示「需要关键词才会检索」 | 预置源含 `{keyword}`，关键词为空 | 输入关键词后回车 |
| GameBanana 报 `HTTP 4xx/5xx` | 对方限流或临时故障 | 稍后重试；到设置页点「测试连通性」看具体信息 |
| GitHub 报 `HTTP 403` | 未带 Token 触发限流（搜索接口约 10 次/分钟） | 在请求头填 `Authorization: Bearer <Token>`，或降低检索频率 |
| 报「返回结构与 GameBanana 契约不符：未找到 `_aRecords` 数组」 | 地址不是 apiv11 接口，或对方改了结构 | 核对地址；必要时改用自定义 `json` 源 |
| 报「返回结构与 GitHub 契约不符」 | 地址既不是仓库搜索也不是 Release 列表 | 核对地址；搜索用 `/search/repositories`，Release 用 `/repos/{owner}/{repo}/releases` |
| `downloadUrl` 为空、下载按钮灰 | GameBanana 检索接口 / GitHub 仓库搜索都不给直链 | 点「打开主页」回源站下载；或用 Release 形态的 GitHub 源 |
| 结果都是「待核实」 | 第三方源的条目一律不自动标「可用」 | 设计如此；确认后再手动加入我的资源 |

---

## 9. 合规边界

- 预置源只做**检索与呈现**，不实现任何反作弊规避、DRM 绕过或破解分发能力。
- 所有第三方条目一律标 `待核实`，风险按源端信号（内容分级 / 预发布）推断为 `中` 或 `低`，不自动标 `可用`。
- 下载只使用源端明确提供的直链（GitHub Release 资产）；GameBanana 检索接口无直链，界面引导回源站，不在本地代抓。
- 请求头字段可用于放用户自己的 Token，工具不内置、不代管任何凭据。

---

## 10. 验证结果

| 项 | 结果 |
|---|---|
| `vue-tsc --noEmit` + `tsc -p tsconfig.electron.json --noEmit` | 通过 |
| 既有回归（`_test_onlineSearch.mjs`） | **48/48 通过** |
| 新增回归（`_test_presets.mjs`） | **62/62 通过** |
| 真实联网冒烟（`_test_presets_live.mjs`） | **2/2 源可用**：GameBanana 11 条（2326 ms）、GitHub 30 条（4768 ms） |

新增回归覆盖：预置源定义、`withPresets` 注入策略、配置播种与「删除后不加回」、GameBanana 字段映射 15 项、GitHub 仓库映射 9 项、GitHub Release 映射 8 项、`{keyword}` 替换与跳过、关键词源不入缓存、结构不符错误隔离、`testSource` 占位关键词。

回归入口：

```
临时文件\_探查\_run_onlineSearch_test.sh   # 既有 48 项
临时文件\_探查\_run_presets_test.sh        # 新增 62 项
临时文件\_探查\_test_presets_live.mjs      # 真实联网冒烟
```

---

## 11. 未做 / 待确认

- **未接入**任何需要账号鉴权的源（Nexus Mods 等）；如需对接，请你提供 API Key 与允许的调用范围。
- **未做**按游戏维度定向拉取（GameBanana 的 `Game/{id}/Subfeed`）—— 需要先把游戏名映射到 GameBanana 数值 id，属后续增量。
- **未做**内置 curated 仓库清单；当前 GitHub 源是关键词搜索，结果偏通用。若你有一批固定关注的仓库，可在设置页按 Release 形态逐条配置。
- 预置源的**字段映射基于 2026-10-06 实测响应**；第三方改结构时可能需要同步调整适配器。
