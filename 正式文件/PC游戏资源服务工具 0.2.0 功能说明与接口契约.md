# PC游戏资源服务工具 0.2.0 功能说明与接口契约

- 文档版本：0.2.0
- 更新时间：2026-10-04
- 适用范围：`客户端源码`（Electron + Vue 3 + TypeScript）
- 对应立项：`正式文件\PC游戏资源服务工具立项简案.docx`

---

## 一、本次升级做了什么

0.1.0 是纯静态原型：9 个页面全部读内存数组，所有「备份 / 恢复 / 启停 MOD / 安装补丁」都只是提示气泡，不落盘、不碰文件。

0.2.0 换成真实实现：

1. 打通 Electron 主进程 ↔ 渲染进程的 IPC 桥（`preload.cjs` + `ipcMain` 处理器）。
2. 所有状态真实落盘到 `%APPDATA%\PCGameResourceHub\data`，重启后保留。
3. 四条业务线（存档、MOD、修改器资源、检索与资源库）全部改为真实文件操作。
4. 每次写操作写入操作记录，破坏性操作保留还原点或部署记录。

---

## 二、进程边界与架构

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 主进程 | `electron/*.ts` | 文件系统、子进程解压、Steam 扫描、HTTP 下载、持久化 |
| 预加载 | `electron/preload.ts` → `dist-electron/preload.cjs` | 通过 `contextBridge` 暴露 `window.api`，沙箱为 `true`，不使用 Node 直连 |
| 渲染进程 | `src/*.vue`、`src/state.ts`、`src/api.ts` | 界面与共享状态，只通过 `window.api` 访问系统能力 |

- 渲染进程不开启 `nodeIntegration`，`contextIsolation: true`、`sandbox: true`。
- 预加载脚本必须是 CJS，因此构建脚本会先用 esbuild 产出 `preload.cjs`。
- 每个 IPC 处理器统一返回信封 `{ ok: true, data } | { ok: false, error }`，渲染侧 `call()` 负责解包并在失败时抛错。

### 主进程模块

| 文件 | 职责 |
| --- | --- |
| `electron/main.ts` | 设定数据目录、创建窗口、挂载 preload、启动 IPC |
| `electron/ipc.ts` | 全部 IPC 通道注册与参数校验 |
| `electron/store.ts` | JSON 持久化与目录布局 |
| `electron/log.ts` | 操作记录（含推送到渲染进程） |
| `electron/util.ts` | 占位符展开、越界路径防护、目录复制、体积统计 |
| `electron/exec.ts` | 子进程调用封装 |
| `electron/archive.ts` | 解压工具探测、条目安全校验、解压与打包 |
| `electron/games.ts` | Steam 库扫描（注册表 + `libraryfolders.vdf` + `appmanifest_*.acf`）、启动游戏 |
| `electron/saves.ts` | 备份 / 恢复 / 轮换 / 固定 / 导出 / 导入 |
| `electron/mods.ts` | 导入 / 安装计划 / 安装 / 卸载 / 冲突 / 配置档案 |
| `electron/catalog.ts` | 在线目录拉取与缓存、下载队列、本地导入、更新检查 |
| `electron/offlineCatalog.ts` | 内置离线兜底目录 |

---

## 三、数据目录结构

数据根目录：`%APPDATA%\PCGameResourceHub\data`

```
data/
├─ config.json                         设置
├─ games.json                          游戏库
├─ library.json                        我的资源
├─ logs.json                           操作记录（最多 500 条）
├─ backups/
│  ├─ index.json                       备份索引
│  └─ <游戏 id>/<备份 id>/
│     ├─ manifest.json                 原始存档路径、名称、备注、时间
│     └─ data/p0、data/p1…             与存档路径一一对应的内容
├─ mods/
│  ├─ index.json                       MOD 元数据 + 部署记录
│  ├─ profiles.json                    配置档案
│  ├─ files/<MOD id>/                  导入的 MOD 源文件
│  └─ restore/<MOD id>/<时间戳>/       安装覆盖前的还原点
├─ catalog/cache.json                  在线目录缓存
├─ downloads/
│  ├─ index.json                       下载队列
│  └─ <资源名>/<文件名>                下载落盘文件
├─ exports/                            备份导出归档（zip）
└─ staging/                            导入解压临时区（用完即删）
```

---

## 四、IPC 接口契约

以下为 `window.api` 的全部通道。所有调用返回 `{ ok, data } | { ok, error }`。

### 应用与配置

| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `app:info` | — | `{ dataDir, version, packaged, toolsDir, toolsAvailable }` |
| `app:openPath` | `path` | 打开结果字符串（空串表示成功） |
| `app:openDataDir` | — | 同上 |
| `app:revealFile` | `path` | `true`（资源管理器中定位） |
| `config:get` | — | `AppConfig` |
| `config:update` | `Partial<AppConfig>` | 更新后的 `AppConfig`（`backupKeep` 会被夹取到 1–50） |

`AppConfig` 字段：`backupKeep: number`、`archiveTool: string`、`catalogBaseUrl: string`、`catalogAutoRefresh: boolean`。

### 对话框

| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `dialog:pickDirectory` | — | 选中的目录，取消返回空串 |
| `dialog:pickFiles` | `filters: { name, extensions[] }[]` | 选中文件数组，取消返回 `[]` |

### 游戏库

| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `games:list` | — | `Game[]` |
| `games:scanSteam` | — | `{ steamRoot, detected[], skipped[], added }` |
| `games:add` | `{ name, dir, savePaths?, aliases? }` | 新增的 `Game` |
| `games:update` | `id, Partial<Game>` | 更新后的 `Game`（`id` 与 `source` 不可改） |
| `games:remove` | `id` | `true` |
| `games:launch` | `id` | `true`（Steam 游戏走 `steam://rungameid/<appid>`，手动游戏取目录下最短文件名 exe） |
| `games:openDir` | `id` | 打开结果字符串 |

`scanSteam` 合并策略：已存在的游戏保留用户配置的别名与存档路径，只刷新安装目录与库位置。appid `228980`（Steamworks 运行库）被跳过。

### 存档

| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `saves:list` | `gameId?` | `BackupEntry[]`（按时间倒序） |
| `saves:backup` | `gameId, note` | 新建的 `BackupEntry` |
| `saves:restore` | `gameId, backupId` | `{ autoBackupId, restored[] }` |
| `saves:remove` | `gameId, backupId` | `true` |
| `saves:pin` | `gameId, backupId, pinned` | `true` |
| `saves:inspect` | `gameId, backupId` | `{ total, files[] }`（最多 200 条） |
| `saves:export` | `gameId, backupId` | 导出的 zip 绝对路径 |
| `saves:import` | `zipPath` | 新增的 `BackupEntry[]` |

关键规则：

- 备份时对每条存档路径展开占位符（`%APPDATA%`、`%LOCALAPPDATA%`、`%USERPROFILE%`、`%DOCUMENTS%`、`%PROGRAMDATA%`、`%TEMP%`）后复制到 `data/p{i}`。
- **恢复前强制自动备份**，返回的 `autoBackupId` 即该自动备份编号。
- 轮换只清理超出 `backupKeep` 的**非固定**备份，固定备份永不清理。

### MOD

| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `mods:list` | `gameId?` | `ModEntry[]` |
| `mods:import` | `paths[], gameId` | `{ imported[], failed[] }` |
| `mods:plan` | `modId` | `{ items: {source,target,overwrite}[], overwriteCount }` |
| `mods:install` | `modId` | 更新后的 `ModEntry` |
| `mods:uninstall` | `modId` | 更新后的 `ModEntry` |
| `mods:setEnabled` | `modId, enabled` | 更新后的 `ModEntry`（启用=安装，停用=卸载） |
| `mods:remove` | `modId` | `true`（已部署时拒绝） |
| `mods:update` | `modId, { name?, version?, tags?, type? }` | 更新后的 `ModEntry` |
| `mods:conflicts` | `gameId` | `{ target, modIds[], modNames[] }[]` |
| `mods:profiles:list` | `gameId?` | `ModProfile[]` |
| `mods:profiles:save` | `gameId, name` | 新建的 `ModProfile` |
| `mods:profiles:apply` | `profileId` | `true` |
| `mods:profiles:delete` | `profileId` | `true` |

关键规则：

- 导入支持文件夹、单文件、`zip`、`7z`、`rar`（rar 需完整版 7-Zip）。
- 解压前先列出条目并拒绝含绝对路径或 `..` 的越界条目。
- 安装采用**复制**而非软链接；复制前对已存在的目标文件建立还原点（`mods/restore/...`），安装中途失败会回滚已复制文件。
- 卸载按部署记录逐个删除并清理空目录。
- 冲突检测口径：同一游戏下**已部署**的多个 MOD 写入同一目标路径。

### 资源目录与下载

| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `catalog:load` | `force?` | `{ source: 'online'\|'cache'\|'offline', file: CatalogFile, error }` |
| `catalog:download` | `resourceId` | 新建的 `DownloadTask` |
| `catalog:downloads` | — | `DownloadTask[]` |
| `catalog:removeDownload` | `id` | `true`（同时删除已下载文件） |
| `catalog:localImport` | `paths[]` | `DownloadTask[]`（记入本地导入） |
| `catalog:checkUpdates` | — | `{ taskId, title, localVersion, remoteVersion }[]` |

下载事件：主进程通过 `download:progress` 推送整个 `DownloadTask`，渲染侧用 `api.onDownloadProgress` 订阅。
操作记录事件：主进程通过 `log:append` 推送 `LogEntry`，渲染侧用 `api.onLog` 订阅。

### 资源库与日志

| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `library:list` | — | `LibraryItem[]` |
| `library:add` | `{ resourceId, title, kind, gameName }` | 更新后的列表 |
| `library:remove` | `resourceId` | `true` |
| `logs:list` | `limit` | `LogEntry[]` |
| `logs:clear` | — | `true` |

---

## 五、在线资源目录契约（状态：待确认）

> 该契约是本工具自定义的，**当前没有可用的服务端**，需与运营后台对齐后确认。在确认前，工具会：
> 1. 未配置地址时使用 `electron/offlineCatalog.ts` 的内置数据；
> 2. 配置了地址但拉取失败时回退到上次缓存的 `catalog/cache.json`。

- 请求：`GET {catalogBaseUrl}/catalog.json`（若 `catalogBaseUrl` 本身以 `.json` 结尾，则直接使用该地址）
- 响应：

```json
{
  "version": "2026-10-04",
  "updatedAt": "2026-10-04",
  "resources": [
    {
      "id": "res-101",
      "title": "探索辅助工具",
      "kind": "修改器",
      "gameName": "星陨边境",
      "gameAliases": ["星陨", "Starfall Frontier"],
      "version": "1.4.2",
      "compatibleVersion": "星陨边境 1.4.2",
      "gameVersion": "1.4.2",
      "source": "已验证作者页",
      "status": "可用",
      "updatedAt": "2026-09-26",
      "description": "单机模式使用的修改器。",
      "tags": ["单机", "版本匹配"],
      "risk": "中",
      "downloadUrl": "https://example.com/files/xxx.zip",
      "fileName": "starfall-trainer-1.4.2.zip",
      "homepage": ""
    }
  ]
}
```

字段约束：

- `kind` ∈ `修改器 | 存档 | MOD | 补丁`
- `status` ∈ `可用 | 待核实 | 不适配`
- `risk` ∈ `低 | 中`
- `downloadUrl` 为空时该资源不可下载，界面会禁用下载按钮
- `fileName` 为空时回退取 `downloadUrl` 的路径末段

---

## 六、三条参考线能力对照

| 能力 | 来源 | 0.2.0 状态 |
| --- | --- | --- |
| 存档备份 / 恢复 / 轮换 / 固定 / 导出导入 | Game-Save-Manager | 已实现 |
| 存档路径自动识别（PCGamingWiki 数据库） | Game-Save-Manager | 未实现，当前靠人工配置路径 |
| 账号 ID 识别（Steam / Epic / Xbox…） | Game-Save-Manager | 未实现 |
| 批量备份 / 批量恢复 | Game-Save-Manager | 未实现（当前按当前游戏操作） |
| MOD 导入（文件夹 / 单文件 / zip / 7z / rar） | mayflyMods | 已实现（rar 需完整版 7-Zip） |
| MOD 安装 / 卸载 / 部署记录 / 失败回滚 | mayflyMods | 已实现（复制方式，非软链接） |
| 覆盖风险检测 / 安装计划预览 | mayflyMods | 已实现 |
| 冲突检测 / 配置档案 | mayflyMods | 已实现 |
| 批量启用 / 停用 / 删除 | mayflyMods | 已实现 |
| 按游戏 adapter 的安装规则 | mayflyMods | 未实现，当前为通用规则（保留相对路径直投游戏目录 + 跳过说明文件） |
| NexusMods 集成 / aria2 / 翻译层 | mayflyMods | 未实现 |
| 修改器多源目录聚合 | Game-Cheats-Manager | 已实现（目录来自在线/离线契约） |
| 双语即时检索 | Game-Cheats-Manager | 已实现（名称 + 别名 + 标签 + 来源） |
| 下载归档 / 防重复下载 / 更新检查 / 本地导入 | Game-Cheats-Manager | 已实现 |
| 反作弊绕过提示 | Game-Cheats-Manager | **不实现**（立项排除） |
| Defender 白名单助手 | Game-Cheats-Manager | **不实现**（立项排除） |

---

## 七、合规边界

- 仅面向单机、本地文件与可追溯资源场景。
- 不提供联网游戏辅助、反作弊规避、DRM 绕过、账号体系规避与破解分发。
- 客户端不内置任何修改器本体，只做资源目录、下载与本地管理。
- 文件写入仅限用户显式配置的路径与工具数据目录，不扫描无关目录。
- 破坏性操作（恢复存档、安装/卸载 MOD）均保留还原点或部署记录。

---

## 八、运行、构建与验证

```powershell
# 依赖安装（store/cache 已固定到 F 盘）
cd F:\Codex\Work\PC游戏资源服务工具\客户端源码
pnpm install

# 开发（先产出 preload.cjs，再并行起 vite 与主进程）
pnpm dev

# 类型检查
pnpm typecheck

# 构建
pnpm build

# 打包 Windows 便携版
$env:ELECTRON_BUILDER_CACHE = "F:\Codex\Supports\electron-builder-cache"
pnpm package:win
```

本次已执行的验证：

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 渲染进程类型检查 | `vue-tsc --noEmit` | 退出码 0 |
| 主进程类型检查 | `tsc -p tsconfig.electron.json --noEmit` | 退出码 0 |
| 渲染层构建 | `vite build` | 产出 `dist/index.html` 与 `dist/assets/*` |
| 主进程构建 | `tsc -p tsconfig.electron.json` | 产出 `dist-electron/*.js` 与 `preload.cjs` |

---

## 九、待确认事项

| 编号 | 事项 | 影响 | 建议确认角色 |
| --- | --- | --- | --- |
| 1 | 在线资源目录的后端地址与字段契约 | 决定资源检索、下载、更新检查能否接入真实数据 | 服务端 / 运营后台负责人 |
| 2 | 是否允许随包分发 `7za.exe`（LGPL + unRAR restriction） | 决定压缩包导入/导出是否开箱可用 | 法务 / 项目负责人 |
| 3 | rar 包支持策略（要求用户自装 7-Zip，或改用完整版 7-Zip 随包） | 影响 rar 资源的可用率 | 项目负责人 |
| 4 | MOD 安装是否改为软链接、是否引入按游戏 adapter 规则 | 影响部署精度与冲突口径 | 研发 |
| 5 | 是否补充存档路径自动识别数据源（本地词典或在线库） | 影响首次使用门槛 | 产品 / 研发 |
| 6 | 成品代码签名 | 影响 Windows 首次运行的信任提示 | 项目负责人 |

## 十、下一步建议

1. 先确认第 1 项：拿到真实目录接口后，把 `catalogBaseUrl` 指向它并跑通「检索 → 下载 → 本地导入」闭环。
2. 补 MOD adapter 规则表（按游戏名匹配 `skipPatterns` 与目标根目录），提升部署准确率。
3. 补存档路径识别：先做本地词典（游戏名 → 已知存档路径），再评估在线库。
4. 增加受控启动测试：在真实便携版上验证「扫描 Steam → 备份 → 恢复 → 导入 MOD → 安装 → 卸载」全链路。
5. 批量能力（批量备份/恢复、批量 MOD 编辑）按立项二期节奏排期。
