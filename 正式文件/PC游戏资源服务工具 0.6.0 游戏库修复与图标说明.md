# PC 游戏资源服务工具 0.6.0 — 游戏库修复、图标与 Steam 资料匹配

> 版本：0.6.0 ｜ 交付物：`游戏资源服务工具演示 0.6.0.exe`
> 本文记录本轮的四个问题根因、修复方式与验证结果，以及新增能力的用法与排障。
> 上一版说明见 `PC游戏资源服务工具 0.5.0 开源数据源接入说明.md`。

---

## 1. 本轮修复的四个问题

### 1.1 手动选择目录添加游戏时报错

**现象**：点「添加游戏目录」→ 选目录 → 报错，游戏加不进去。

**根因**：`GameLibrary.vue` 用 `window.prompt()` 弹输入框取游戏名。**Electron 渲染层不实现 `window.prompt`**，
该调用直接失败，名字拿不到（或拿到 `undefined`），后续 `name.trim()` 抛错，整个添加流程中断。

**修法**：换成 Element Plus 的输入弹窗（`ElMessageBox.prompt`），并在三处做兜底：

| 层级 | 兜底行为 |
|---|---|
| 弹窗 | 默认填目录名，回车确认；点「取消」直接安全退出，不算错误 |
| 主进程 `buildManualGame` | 名字为空 → 用目录名；目录名也取不到 → 用「未命名游戏」 |
| IPC `games:add` | 目录为空 → 明确报「未选择游戏目录」，不再抛 `undefined` 异常 |

### 1.2 点击「启动游戏」提示「需要新应用以打开此 Steam 链接」

**现象**：每次点启动都弹 Windows 的协议选择框。

**根因**：旧实现只调用 `shell.openExternal('steam://rungameid/<appid>')`，完全依赖系统里 `steam://`
协议的注册情况。注册表里 Steam 在 `E:\[Game]Steam`，但协议关联未必落在当前用户/提权上下文，于是系统无法处理该链接。

**修法**：改为分级启动，**不再依赖协议注册**：

1. **Steam 游戏** → 从注册表 `HKCU\Software\Valve\Steam` 的 `SteamExe`（回退 `SteamPath` → 默认安装目录）
   解析出 `steam.exe`，以 `steam.exe -applaunch <appid>` 拉起。这是最正规的路径，能带上 Steam 覆盖层与云存档。
2. **有安装目录** → 在目录里挑主程序 exe 直接启动（离线兜底）。
3. **以上都不可用且是 Steam 游戏** → 最后才回退 `steam://rungameid/<appid>`。

启动成功后界面会给出具体反馈，例如「已通过 Steam 启动（appid 413150）」或「已启动 SlayTheSpire2.exe」。

### 1.3 资源中心报「数据源「GameBanana」拉取失败：返回结构与契约不符」

**关键排查**：实测 GameBanana 检索端点 `Util/Search/Results?_sSearchString=`（含模型约束 / 无约束 / 无结果 / 翻页四种情况）
**始终返回 `{ _aMetadata, _aRecords: [...] }`**，`_aRecords` 一定存在（无结果时为空数组）。
但线上那条报错文案是**通用 JSON 解析器**抛的，说明当时该源的 `kind` 不是 `gamebanana`，而是被降级成了 `json`
（`sanitizeSource` 对无法识别的 kind 静默回落 `json`），于是走了「找 resources / items / data 数组」的通用分支。

**修法（双保险）**：

1. **结构嗅探**：`kind = json` 时先看响应结构 —— 出现 `_aRecords` 按 GameBanana 解析，
   出现 `total_count + items[].full_name` 按 GitHub 解析，都不像才走通用 JSON。这样即使类型被误选，可用数据也不会被「契约不符」挡在门外。
2. **准确报错**：真的解析不了时，区分两种情况给出可操作文案
   （例如「GameBanana 返回的是分区汇总而不是条目列表，请在地址里补 `_sModelName=Mod`」），不再抛含糊的通用文案。

顺带修掉了结果质量问题：

| 改进 | 说明 |
|---|---|
| 分区过滤 | 按实测 `_sModelName` 过滤掉 Article / Blog / Thread / Question / Review / Tutorial / Wip / Concept 等 19 个非资源分区，只保留 Mod / Tool / Sound / Spray / Model 等可下载类型 |
| 类型映射 | `Tool` → 修改器；`Mod` / `Sound` / `Spray` / `Model` 等 → MOD |
| 停更标记 | 源站 `_bIsObsolete` → 状态标为「不适配」 |
| 无附件提示 | 源站 `_bHasFiles !== true` → 描述里注明「源站标记该条目没有附件文件」 |
| 标签富化 | 除根/子分类外，并入源站 `_aTags`（最多 6 个） |

### 1.4 游戏只有文字，看不出是哪个游戏

见下一节。

---

## 2. 游戏图标（新增）

### 2.1 取图优先级（离线优先，逐级降级）

| 顺序 | 来源 | 是否需要联网 | 说明 |
|---|---|---|---|
| 1 | **Steam 本地库封面缓存** | 否 | `<Steam>/appcache/librarycache/<appid>/library_600x900[_schinese].jpg`。实测本机该目录有 144 个 appid 子目录，质量最高 |
| 2 | **主程序 exe 图标** | 否 | `app.getFileIcon()` 提取。实测 Windows 下 `large` 为 48×48，任何已安装游戏都有 |
| 3 | **Steam 官方封面** | 是 | `cdn.cloudflare.steamstatic.com/steam/apps/<appid>/library_600x900.jpg` → `header.jpg` → 商店搜索返回的 `tiny_image` |
| — | 兜底 | — | 以上都取不到时，界面显示游戏名首字母占位块，不会空白 |

处理与缓存：统一**居中裁成方形**并缩放到 160×160，写成 PNG 落在数据目录的 `icons/<gameId>.png`；
之后每次读取直接命中缓存。「配置游戏」弹窗里可点「重新生成图标」强制重算（例如换了安装目录、或先取了 exe 图标后来又匹配上 Steam）。

### 2.2 主程序 exe 挑选启发式（在 4 个真实游戏目录上校准）

游戏目录里往往有多个 exe，需要挑出真正的主程序。打分规则：

- 文件名与游戏名 / 目录名**完全一致** → **+6000**
- 互相包含 → **+2000**
- 与游戏名 / 目录名**共享 ≥5 个字符前缀** → **+2500**
- 体积越大越像主程序（上限 300 分）
- 路径越深扣分越多（每层 −1500），主程序通常在根目录
- 按名字排除安装器与运行库：`unins*` / `setup*` / `vcredist*` / `dxsetup*` / `dotnet*`，以及名字里含
  `crashhandler` / `crashreport` / `createdump` / `errorreport` / `reporter` / `diagnostic` / `uninstall` 的

实测结果（真机 Electron 探针）：

| 游戏目录 | 挑中的主程序 | 说明 |
|---|---|---|
| `Stardew Valley` | `Stardew Valley.exe` | 与目录同名 |
| `Slay the Spire 2` | `SlayTheSpire2.exe` | 归一化后与目录同名 |
| `wallpaper_engine` | `distribution\wallpaper64.exe` | 压过更深层的 `distribution\bin\wallpaperui.exe`（12.7 MB）与根目录 `launcher.exe` |
| `BALLxPIT` | `Balls.exe` | **压过更大的 `UnityCrashHandler64.exe`（1.6 MB > 0.9 MB）** |
| `SecretsOfGrindea` | `Secrets Of Grindea.exe` | 与游戏名共享前缀 |
| `Crusaders Quest Hero Town` | `CQ Hero Town.exe` | 真实主程序名与目录名不一致，仍正确命中 |

> 其中前两条是实测踩坑：`UnityCrashHandler64.exe` 比主程序更大，`wallpaperui.exe` 在更深一层 ——
> 只按体积或只按层数挑都会错，因此同时引入名字排除与「同源命名」加权。

---

## 3. 按名称匹配 Steam 资料页（新增）

### 3.1 数据来源

```
GET https://store.steampowered.com/api/storesearch/?term=<关键词>&l=schinese&cc=CN
→ 200 { total, items: [ { type, name, id, price?{initial,final,currency}, metascore?, platforms?, tiny_image? } ] }
```

公开接口，免登录、免 API Key。`l=schinese` 让名称与封面走中文资源。

### 3.2 界面用法

游戏库表格新增「Steam 资料」列：

- 未匹配 → 「按名称匹配」按钮，弹出候选列表（封面 / 名称 + appid / 价格 / 媒体评分 / 平台），点「选用」写入。
- 已匹配 → 显示 appid + 「资料页」按钮，用系统默认浏览器打开商店页。
- 也可在「配置游戏」弹窗里操作，并显示当前图标来源与时间。

选用后写入游戏的 `steamAppId` / `storeUrl` / `storeCoverUrl`，并**立即用官方封面刷新图标**。
手动添加的游戏匹配成功后，「启动游戏」也会优先走 `steam.exe -applaunch`。

### 3.3 网络抖动与重试

本机实测 `store.steampowered.com` 可达但**抖动明显** —— 同一条请求可能一次成功、一次 `fetch failed`。
因此：

- 商店检索内置**一次重试**（间隔 500 ms），两次都失败才报错；
- 超时下限提到 **12 秒**（不受「设置 → 单源请求超时」调小影响），因为首次握手实测可达 12 s 以上；
- 失败文案明确告知**已安装的 Steam 游戏图标不依赖联网**，仍会正常显示，避免误判为整体故障。

---

## 4. 数据字段变更（兼容旧数据）

`games.json` 每个游戏新增 5 个字段，`store.games()` 在读取时统一归一，旧文件缺字段一律补空串，
**不会因为升级而丢数据**：

| 字段 | 含义 |
|---|---|
| `steamAppId` | 「匹配 Steam 资料」得到的商店 appid |
| `storeUrl` | Steam 商店页地址 |
| `storeCoverUrl` | 商店搜索返回的封面小图，作图标兜底 |
| `iconSource` | 当前图标来源：`steam-cover` / `steam-cdn` / `exe` / `cache` |
| `iconUpdatedAt` | 图标最后生成时间 |

数据目录新增 `icons/` 子目录存放图标 PNG。

---

## 5. 排障对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| 添加游戏报错 | 旧版 `window.prompt` 不受支持 | 0.6.0 已改用输入弹窗，升级即可 |
| 点启动弹「需要新应用以打开此 Steam 链接」 | 旧版只走 `steam://` 协议 | 0.6.0 改为 `steam.exe -applaunch` 优先，升级即可 |
| 启动失败提示「未在游戏目录下找到可执行文件」 | 目录里没有 exe，或全被判定为安装器/运行库 | 检查安装目录是否正确；或「配置游戏」里手动填对目录 |
| 启动失败提示「该游戏未关联安装目录，也没有 Steam appid」 | 手动添加的游戏没填目录，也没匹配 Steam | 补安装目录，或在「Steam 资料」列做匹配 |
| 图标是首字母占位块 | 三个来源都没取到 | 点「重新生成图标」；确认安装目录有效，或先做 Steam 资料匹配 |
| 图标是 exe 小图标，不够好看 | Steam 本地无该游戏封面缓存 | 在「Steam 资料」列匹配一次，会用官方封面重刷 |
| 数据源报「结构与契约不符」 | 源的类型选错，或响应确实是别的结构 | 0.6.0 已加结构嗅探；仍失败时按提示改用正确类型，GameBanana 请确认地址含 `_sSearchString=` |
| 报「GameBanana 返回的是分区汇总而不是条目列表」 | 该地址没约束分区 | 在地址里补 `&_sModelName=Mod` 后重试 |
| 匹配 Steam 提示连接失败 | 商店域名网络抖动 | 直接重试（已内置一次自动重试）；不影响已有的本地图标 |
| 资源中心结果里混进文章/讨论 | 旧版未过滤分区 | 0.6.0 已过滤 19 个非资源分区 |

---

## 6. 回归验证（0.6.0）

| 项 | 结果 |
|---|---|
| `vue-tsc --noEmit` + `tsc -p tsconfig.electron.json --noEmit` | 通过 |
| 新增 `_test_gamefix.mjs`（46 项） | **46/46 通过** |
| 既有 `_test_presets.mjs`（62 项） | **62/62 通过** |
| 既有 `_test_onlineSearch.mjs`（48 项） | **48/48 通过** |
| 真机 Electron 图标探针（`_icon_probe`） | `nativeImage` 解码/裁剪/缩放/dataURL 全通；`getFileIcon` 48×48；6 个真实游戏目录主程序挑选 4/4 命中（2 个仅记录） |
| Steam 商店联网冒烟（`_test_steam_live.mjs`） | 3/3 通过（首个请求靠内置重试成功） |
| `app.asar` 核验 | 见 AGENTS.md 验收记录 |

新增测试入口（Git Bash）：

```bash
临时文件/_探查/_run_gamefix_test.sh       # 46 项离线回归
临时文件/_探查/_run_presets_test.sh       # 62 项离线回归
临时文件/_探查/_run_onlineSearch_test.sh  # 48 项离线回归
临时文件/_探查/_run_steam_live.sh         # Steam 商店真实联网（易碎）
```

---

## 7. 合规边界（未变）

本工具仍只面向**单机、本地文件、可追溯资源**场景，不提供也不计划提供：
联网游戏辅助、反作弊规避、Windows Defender 白名单、DRM 绕过、账号体系规避、破解分发。
Steam 相关能力仅涉及「读取本机安装信息 + 查询商店公开信息」，不读取账号、不涉及购买与登录态。
