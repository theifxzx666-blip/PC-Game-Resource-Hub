# PC 游戏资源服务工具 · PC Game Resource Hub

面向单机 PC 玩家的**本地优先（local-first）**游戏资源桌面工具：把「游戏库管理 / 存档备份恢复 / MOD 启停 / 资源检索下载」收敛到一个 Windows 客户端里，所有破坏性操作都可回退。

> 当前版本 **0.7.2**（Electron 44 + Vue 3 + TypeScript）
> 形态：Windows 便携版单文件 EXE（portable），免安装、绿色运行。
> 数据目录：`%APPDATA%\PCGameResourceHub\data`
> 下载：[Releases](https://github.com/theifxzx666-blip/PC-Game-Resource-Hub/releases) · 源码与说明见下方各节

---

## Table of Contents

- [一、项目概述](#一项目概述)
- [二、设计思路](#二设计思路)
- [三、技术框架](#三技术框架)
- [四、仓库结构](#四仓库结构)
- [五、功能模块](#五功能模块)
- [六、技术方案细节](#六技术方案细节)
- [七、获取与构建](#七获取与构建)
- [八、验证记录](#八验证记录)
- [九、合规边界与第三方声明](#九合规边界与第三方声明)
- [Ten-minute Guide (English)](#ten-minute-guide-english)

---

## 一、项目概述

### 1.1 要解决的问题

玩家侧的周边工具长期是「一堆散装脚本 + 网盘链接」：存档备份靠手动复制、MOD 靠手抄说明、修改器/补丁靠论坛翻帖。本项目把这些动作做成一个**有账可查、可回退**的客户端。

### 1.2 目标能力

| 领域 | 能力 |
| --- | --- |
| Game Library | Steam 库自动扫描、手动添加、封面图标自动获取、按名称匹配 Steam 资料页 |
| Save Manager | 备份 / 恢复 / 轮换 / 固定 / 导出导入，**存档路径自动定位**（6613 款游戏知识库 + 探测 + 快照差分） |
| Mod Manager | 多格式导入、安装计划预览、复制式安装、卸载、冲突检测、配置档案（Profile） |
| Resource Center | 多数据源聚合检索、多维筛选、下载队列、本地导入、版本更新检查 |
| Knowledge Base | **内置离线知识库**：6613 款游戏 × 15042 条存档路径、6485 条游戏别名、8943 条修改器/MOD 元数据，随包分发、离线可用 |
| Governance | 操作记录（最多 500 条）、破坏性操作保留还原点或部署记录 |

### 1.3 交付形态

- 渲染进程：Vue 3 单页应用，7 个视图（概览 / 游戏库 / 存档管理 / MOD 管理 / 资源中心 / 操作记录 / 设置）。
- 主进程：文件系统、子进程解压、Steam 扫描、HTTP 下载与检索、JSON 持久化。
- 无需任何服务端即可运行（内置离线兜底目录 + 开源公开数据源）。

---

## 二、设计思路

五条主线，决定了后面所有技术选型。

### 2.1 进程边界即权限边界

渲染进程跑的是网页代码，**不开 `nodeIntegration`**，`contextIsolation: true`、`sandbox: true`。所有系统能力只能通过 `preload.cjs` 用 `contextBridge` 暴露的 `window.api` 调用，主进程侧统一做参数校验。

结果：界面代码无法直接触碰文件系统，能力清单在 `preload.ts` 与 `ipc.ts` 中显式枚举，可审计。

### 2.2 一切落盘，破坏性操作必有回退

- 状态全部持久化到 JSON，重启不丢。
- **恢复存档前强制自动备份**，"备份-恢复" 不是 "覆盖-丢档"。
- MOD 安装前对将被覆盖的目标文件建立还原点（`mods/restore/...`），复制中途失败会回滚已复制内容。

### 2.3 数据源可插拔，界面永不空白

在线检索不绑死任何单一后端：数据源是一份**可增删改的配置列表**（`json` / `rss` / `gamebanana` / `github`）。

**内置知识库是一等数据源，不是"最后的兜底"。** 这一点很关键 —— 早期版本把知识库写成「只有在线源一条都没拉到才用」，结果配了预置源后，在线源总是能返回**一些**结果（尽管往往不相关），知识库便永远轮不上：

```
搜「星露谷物语」
  → GitHub 返回 195 个「星露谷物语复刻版 / MOD 安装器 / 类似星露谷的游戏」
  → pool 非空，知识库被跳过
  → 过滤无关项目后：0 条结果
  → 知识库里 348 条真正的星露谷 MOD 一条都搜不到
```

现在的设计是**并入再排序**，而非逐级替换：

```
有关键词
  ├─ 在线关键词源实时拉取（GameBanana / GitHub …）
  └─ 内置知识库按别名展开 + 名称索引检索
       ↓  合并去重（mergeOnline）
      统一按 relevance 打分排序
        · 游戏名精确匹配  200 分   ← 最强信号
        · 游戏名以词开头  120 分
        · 标题包含关键词   50 分   ← 仅作补充
       ↓
      分页返回
```

「降级」只发生在**取数阶段**，且是逐源独立的：

```
真实联网  →  本地检索缓存（TTL）  →  内置知识库  →  演示目录（5 条）
   ↓              ↓                    ↓              ↓
  单源失败只降级为该源 0 条 + 状态提示，不影响其他源
```

来源判定（界面顶部标签）也随之细分：`实时联网` / `本地缓存` / `内置知识库` / `离线兜底`。

### 2.4 离线优先

- 游戏图标优先取 **Steam 本地封面缓存**，其次 exe 内嵌图标，最后才走 CDN。
- 资源目录无网时走 `offlineCatalog.ts` 内置数据。
- **内置知识库随包分发**（`resources/data/`，未打进 asar，可热替换）：
  存档路径库 6613 款、游戏别名 6485 条、修改器/MOD 元数据 8943 条。开箱即用，不需要联网初始化。
- 存档路径探测只读本机目录，不依赖任何在线库。

**别名表是检索质量的关键。** 知识库里的游戏名一律是中文正式名（如「星露谷物语」），
而用户可能输入英文名或俗称（`Stardew Valley` / `大表哥2` / `MC` / `老头环`）。
检索前先用 `expandAlias()` 把输入展开成候选名集合（支持 2 跳，防环），再拿候选名去查名称索引：

```
Stardew Valley  →  [Stardew Valley, 星露谷物语]
大表哥2          →  [大表哥2, 荒野大镖客2]
老头环           →  [老头环, 艾尔登法环]
```

6485 条别名有两个来源：参考项目人工维护的俗称表（14 条），以及**从自带数据反向抽取**——
`save-paths.json` 的 `title` 字段格式为「中文名/English Name/备注」，按 `/` 切段即可得到中英对照
（如 `星露谷物语/Stardew Valley/支持网络联机`），实测扩充出 6280 条。

### 2.5 合规边界：知识库只存元数据

内置的修改器/MOD 知识库是**离线元数据快照**，构建期即已剥离下载直链：

| 字段 | 取值 | 原因 |
| --- | --- | --- |
| `downloadUrl` | 恒空串 | 不提供抓取/分发能力 |
| `fileName` | 恒空串 | 不指向任何可下载对象 |
| `homepage` | 来源帖子页 | 用户自行在浏览器查看 |
| `linkKinds` | 仅分类名（如「百度网盘」） | 保留信息量，不携带链接 |
| `description` | **链接/口令已替换为「［见原帖］」** | 见下方说明 |
| `status` | 恒「待核实」 | 未经本项目核验 |
| `risk` | 修改器「中」/ MOD「低」 | 内存修改类工具默认更高风险 |

> **为什么 `description` 也要洗**：初版只清掉了结构化的 `links[]` 数组，
> `downloadUrl` / `fileName` 也确实恒为空串 —— 校验一路绿灯，声明看起来完美。
> 但正文（`content` → `description`）里**原样贴着网盘链接**：实测 8943 条中
> **8624 条（96%）** 中招，其中 7825 条 `pan.xunlei.com`、1326 条 `pan.baidu.com`。
> 这只检查字段、不看正文的做法，等于给自己开了一张**假的合规证明**。
>
> 现在构建期统一做 `sanitize_links()`：清洗 URL、裸网盘域名、网盘口令（`/~xxxx~/`）、
> 提取码，统一替换为占位符 `［见原帖］`，共清除 **13748 处**，残留 0。

**该约束由 `npm run verify:data` 强制校验**：一旦数据集里出现 `downloadUrl`、`fileName`，
或 `description` 里残留任何 http(s) 链接 / 裸网盘域名 / 网盘口令 / 提取码，校验立即失败。

### 2.6 知识库的覆盖范围（写在明处，而不是让界面空着）

内置知识库来自参考项目的社区帖离线快照，**只有 `MOD` 与 `修改器` 两类**，
`存档`、`补丁` 没有任何条目。资源中心保留了这两个分类入口，但行为是**如实返回空**而不是拿数据填上：

| 做法 | 为什么不做 |
| --- | --- |
| 用 `offlineCatalog` 的 5 条演示数据顶上 | 那 5 条是**虚构游戏**（星陨边境 / 深港纪事 / 轨道远征）。用户明确选了「存档」，却拿到 1 条假存档，比空结果更误导 —— 会以为检索到了，点进去才发现是演示数据 |
| 直接在界面上隐藏这两个分类 | 会让人以为「这工具不支持存档」，而事实是「暂时没接数据源」。信息量更少 |

实际选择：**保留入口 + 如实返回空 + 明确写出覆盖范围**。
界面通过主进程 `trainers:info` 读取真实的 `byKind` 统计来生成提示文案
（**不在前端写死类型清单** —— 之后真补了「存档」数据，界面自动跟上，不会留下一句过期的「暂不支持」）。

### 2.7 不做事清单（立项排除，等于设计约束）

不实现反作弊规避、DRM 绕过、破解分发、联网游戏辅助、账号体系规避。客户端**不内置任何修改器本体**，只做资源目录、下载与本地管理。文件写入仅限用户显式配置的路径与工具自身数据目录，不扫描无关目录。

---

## 三、技术框架

### 3.1 技术栈

| 层 | 技术 | 版本 | 用途 |
| --- | --- | --- | --- |
| Runtime | Electron | 44.4.5 | 桌面容器，主进程 / 渲染进程分离 |
| UI | Vue 3 | 3.x | 渲染层框架（Composition API + `<script setup>`） |
| 组件库 | Element Plus | 3.x | 表格、弹窗、表单、消息提示 |
| 状态 | Pinia | 3.x | 提供依赖注入上下文；业务共享状态集中在 `src/state.ts` 的 `reactive` 单例 |
| 语言 | TypeScript | 5.9.3 | 主进程与渲染进程全量类型化 |
| 渲染构建 | Vite | 5.x | 渲染进程打包（`dist/`） |
| 主进程构建 | tsc | 5.9.3 | `tsconfig.electron.json` 编译到 `dist-electron/`（ESM） |
| 预加载构建 | esbuild | 0.28.2 | `preload.ts` → **CJS**（`preload.cjs`） |
| 分发打包 | electron-builder | 24.x | Windows portable 目标 |
| 解压工具 | 7za.exe | 随包 | 子进程调用，解压 zip / 7z 与生成导出归档 |

### 3.2 构建链路（关键约束）

预加载脚本**必须产出 CJS**，否则 `sandbox: true` 下无法加载。因此 `build` 与 `dev` 都会先跑一次 esbuild：

```bash
esbuild electron/preload.ts --bundle --platform=node --format=cjs \
  --outfile=dist-electron/preload.cjs --external:electron
```

完整构建顺序：

```
build:preload (esbuild → preload.cjs)
      ↓
vite build                → dist/index.html + dist/assets/*
      ↓
tsc -p tsconfig.electron.json → dist-electron/*.js
      ↓
electron-builder --win portable → release/*.exe
```

`package.json` 中 `build.electronDist = node_modules/electron/dist`，复用已安装并验证过的本地 Electron 运行时；`build.win.signAndEditExecutable = false` 关闭代码签名（离线环境无 winCodeSign 缓存，开启会导致打包卡在下载）。

### 3.3 主进程模块地图

| 文件 | 职责 |
| --- | --- |
| `electron/main.ts` | 设定 `userData` 数据目录、创建窗口、挂载 preload、启动 IPC |
| `electron/ipc.ts` | 全部 IPC 通道注册与参数校验（`handle()` 统一信封） |
| `electron/preload.ts` | `contextBridge` 暴露 `window.api`，产出 `preload.cjs` |
| `electron/store.ts` | JSON 持久化与目录布局、配置归一与预置源播种 |
| `electron/types.ts` | 主进程领域类型（渲染层 `src/types.ts` 为镜像定义） |
| `electron/util.ts` | 占位符展开、越界路径防护、目录复制、体积统计、uid |
| `electron/log.ts` | 操作记录，并推送到渲染进程 |
| `electron/exec.ts` | 子进程调用封装 |
| `electron/archive.ts` | 解压工具探测、条目安全校验、解压与打包 |
| `electron/games.ts` | Steam 库扫描（注册表 + `libraryfolders.vdf` + `appmanifest_*.acf`）、启动游戏 |
| `electron/gameArt.ts` | 游戏图标生成与缓存、主程序（main exe）识别启发式 |
| `electron/steamLocate.ts` | Steam 安装根目录与 `steam.exe` 定位（含缓存） |
| `electron/steamStore.ts` | Steam 商城搜索、封面下载、本地封面缓存路径解析 |
| `electron/saves.ts` | 备份 / 恢复 / 轮换 / 固定 / 导出 / 导入 |
| `electron/savePathLibrary.ts` | **存档路径知识库**：加载 `save-paths.json`、占位符解析、Steam ID / 名称双索引 |
| `electron/savePathFinder.ts` | 存档路径一键探测（知识库优先）+ 启动前后快照差分 |
| `electron/trainerLibrary.ts` | **修改器/MOD 元数据知识库**：加载 `trainers.json`、游戏名索引、关键词检索 |
| `electron/mods.ts` | 导入 / 安装计划 / 安装 / 卸载 / 冲突 / 配置档案 |
| `electron/catalog.ts` | 在线目录拉取与缓存、下载队列、本地导入、更新检查 |
| `electron/onlineSearch.ts` | 多源聚合检索（解析、去重合并、打分、缓存降级） |
| `electron/presetSources.ts` | 内置预置数据源（GameBanana / GitHub） |
| `electron/offlineCatalog.ts` | 内置演示兜底目录（5 条） |

### 3.4 渲染层结构

```
src/
├─ main.ts              应用入口
├─ App.vue              侧边导航 + 顶栏 + 7 个视图切换 + 设置页
├─ state.ts             全局响应式状态与刷新动作（bootstrap / runSearch / refresh*）
├─ api.ts               window.api 的类型化包装 + call() 统一解包
├─ types.ts             渲染层类型（与 electron/types.ts 保持镜像）
├─ utils/modPath.ts     路径工具（改编自 mayflyMods，MIT）
├─ style.css            全局样式
└─ components/
   ├─ GameLibrary.vue       游戏库：扫描 / 添加 / 图标 / Steam 匹配 / 存档路径定位
   ├─ SaveManager.vue       存档管理：备份 / 恢复 / 固定 / 导出导入 / 快照差分
   ├─ ModManager.vue        MOD 管理：导入 / 计划 / 安装卸载 / 冲突 / 档案
   ├─ ResourceCenter.vue    资源中心：检索 / 筛选 / 下载队列
   └─ SearchSourceCard.vue  数据源编辑卡片（设置页复用）
```

---

## 四、仓库结构

```
PC游戏资源服务工具/
├─ README.md                    ← 本文档
├─ .gitignore
├─ 客户端源码/                   Electron + Vue 3 + TypeScript 工程
│  ├─ electron/                 主进程与预加载
│  ├─ src/                      渲染进程
│  ├─ resources/
│  │  ├─ data/                  ★ 内置知识库（随包分发，离线可用）
│  │  │  ├─ save-paths.json     存档路径库：6613 款 × 15042 条
│  │  │  ├─ name-aliases.json   游戏别名表：6485 条（中英对照 + 玩家俗称）
│  │  │  └─ trainers.json       修改器/MOD 元数据：8943 条（无下载直链）
│  │  └─ tools/                 随包解压工具（二进制不入库，见 §7.3）
│  ├─ scripts/
│  │  ├─ verify-deps.cjs        依赖完整性自检（还原被误改名的包文件）
│  │  ├─ verify-data.cjs        ★ 数据与契约校验（含 normKey 双实现一致性、正文无直链）
│  │  ├─ verify-search.cjs      ★ 检索链路回归测试（直接加载 dist-electron 产物）
│  │  ├─ electron-loader.mjs    ESM 加载钩子：把 electron 解析到桩模块
│  │  └─ electron-shim.mjs      Electron 桩（仅测试用）
│  ├─ package.json / package-lock.json
│  ├─ tsconfig.json / tsconfig.electron.json / vite.config.ts
│  └─ THIRD_PARTY_NOTICES.md    第三方声明（唯一维护文件）
├─ 正式文件/                    交付说明文档
│  ├─ 0.2.0 打包阻塞诊断与恢复步骤.md
│  ├─ PC游戏资源服务工具 0.2.0 功能说明与接口契约.md
│  ├─ PC游戏资源服务工具 0.4.0 在线检索接入说明.md
│  ├─ PC游戏资源服务工具 0.5.0 开源数据源接入说明.md
│  └─ PC游戏资源服务工具 0.6.0 游戏库修复与图标说明.md
└─ 测试/                        预留测试目录
```

> 便携版 `*.exe`、`node_modules`、构建产物、本机临时区与日志、以及含委托方信息的立项文档均已加入 `.gitignore`，不入库。
>
> ⚠️ `.gitignore` 中的运行时数据规则必须写成 `/data/` 而不能是裸 `data/` —— 后者会连 `客户端源码/resources/data/`（内置知识库）一起吞掉。已用 `!客户端源码/resources/data/` 显式解除。

---

## 五、功能模块

### 5.1 概览 Overview

统计卡片 + 最近操作，展示游戏数、备份数、已部署 MOD 数、资源库条数，并提供当前游戏快捷切换。

### 5.2 游戏库 Game Library

| 子能力 | 实现要点 |
| --- | --- |
| Steam 库扫描 | 注册表解析 Steam 根目录 → 解析 `libraryfolders.vdf` 得到所有库 → 遍历 `appmanifest_*.acf` |
| 手动添加 | `ElMessageBox.prompt` 输入名称（Electron 渲染进程**不实现 `window.prompt`**），名称支持三级回退 |
| 游戏图标 | 本地 Steam 封面 → exe 图标 → Steam CDN，统一裁剪为 160×160 PNG 缓存 |
| 匹配 Steam 资料页 | `store.steampowered.com/api/storesearch`（公开接口），回写 appid / 商店地址 / 封面 |
| 启动游戏 | 三级兜底：`steam.exe -applaunch` → 直接启动主程序 exe → `steam://` 协议 |
| 合并策略 | 重复扫描时保留用户配置的别名与存档路径，只刷新安装目录与库位置 |

### 5.3 存档管理 Save Manager

- **备份**：按配置的存档路径逐条展开占位符后复制到 `data/p{i}`，记录文件数与体积。
- **恢复**：恢复前**强制自动备份**，返回自动备份编号。
- **轮换**：只清理超出 `backupKeep` 的**非固定**备份，固定（pinned）备份永不清理。
- **导出 / 导入**：zip 归档，可在不同机器之间搬运。
- **存档路径自动定位**：一键探测 + 快照差分双路，弹窗候选列表附带文件统计（详见 §6.3）。

### 5.4 MOD 管理 Mod Manager

- **导入**：支持文件夹、单文件、`zip` / `7z` / `rar`（rar 需完整版 7-Zip）。
- **安装计划**：安装前列出 `{ source, target, overwrite }` 明细与覆盖数量。
- **安装 / 卸载**：复制式部署（非软链接），保留还原点，中途失败回滚；卸载按部署记录逐个删除并清理空目录。
- **冲突检测**：同一游戏下多个**已部署** MOD 写入同一目标路径即判定为冲突。
- **配置档案（Profile）**：保存一组 MOD 的启用集合与顺序，一键套用。

### 5.5 资源中心 Resource Center

- 多源聚合检索（关键词 + 游戏 / 类型 / 来源 / 状态 / 风险 / 标签 / 仅已入库游戏 + 排序 + 分页）。
- 顶部展示结果来源（实时联网 / 本地缓存 / 离线兜底）、耗时、正常源数量；失败源逐条告警。
- 下载队列（进度推送）、本地导入、版本更新检查；检索结果可直接投递下载队列。
- **离线知识库兜底**：无网或全部数据源失败时，从 8943 条内置修改器/MOD 元数据里按关键词返回相关结果（详见 §6.4）。

### 5.6 操作记录 / 设置

- 操作记录：全部写操作落盘（最多 500 条），失败项标红，支持清空。
- 设置：备份保留份数、解压工具路径、单源目录地址、自动刷新开关、检索缓存 TTL、单源超时、数据源列表编辑与连通性测试。

---

## 六、技术方案细节

### 6.1 IPC 契约与预加载桥

主进程用统一信封返回，渲染层的 `call()` 负责解包并在失败时抛错：

```ts
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }
```

通道按域前缀分组（节选）：

| 前缀 | 通道 |
| --- | --- |
| `app:` | `info` / `openPath` / `openDataDir` / `openExternal` / `revealFile` |
| `config:` | `get` / `update` |
| `dialog:` | `pickDirectory` / `pickFiles` |
| `games:` | `list` / `scanSteam` / `add` / `update` / `remove` / `launch` / `openDir` / `icons` / `refreshIcon` / `steamSearch` / `applySteamMatch` |
| `saves:` | `list` / `backup` / `restore` / `remove` / `pin` / `inspect` / `export` / `import` / `probePaths` / `snapshotTake` / `snapshotDiff` |
| `mods:` | `list` / `import` / `plan` / `install` / `uninstall` / `setEnabled` / `remove` / `update` / `conflicts` / `profiles:*` |
| `catalog:` | `load` / `download` / `downloads` / `removeDownload` / `localImport` / `checkUpdates` |
| `search:` | `query` / `sources` / `testSource` / `clearCache` / `cacheMeta` / `enqueueDownload` |
| `library:` / `logs:` | `list` / `add` / `remove`，`list` / `clear` |

两个**主进程 → 渲染进程**的推送事件：`log:append`（操作记录）、`download:progress`（下载进度）。

`app:openExternal` 仅放行 `http` / `https`。

### 6.2 数据目录布局

根目录 `%APPDATA%\PCGameResourceHub\data`（显式 `app.setPath('userData', ...)`，避免中文 `productName` 造成编码问题）：

```
data/
├─ config.json                     设置
├─ games.json                      游戏库
├─ library.json                    我的资源
├─ logs.json                       操作记录（≤500 条）
├─ backups/
│  ├─ index.json                   备份索引
│  └─ <游戏 id>/<备份 id>/
│     ├─ manifest.json             原始存档路径、名称、备注、时间
│     └─ data/p0、data/p1…         与存档路径一一对应的内容
├─ mods/
│  ├─ index.json                   MOD 元数据 + 部署记录
│  ├─ profiles.json                配置档案
│  ├─ files/<MOD id>/              导入的 MOD 源文件
│  └─ restore/<MOD id>/<时间戳>/   安装覆盖前的还原点
├─ catalog/
│  ├─ cache.json                   在线目录缓存
│  └─ search-cache.json            聚合检索缓存
├─ icons/<gameId>.png              游戏图标缓存（160×160 PNG）
├─ saves/snapshots.json            存档快照基线
├─ downloads/
│  ├─ index.json                   下载队列
│  └─ <资源名>/<文件名>            下载落盘文件
├─ exports/                        备份导出归档（zip）
└─ staging/                        导入解压临时区（用完即删）
```

### 6.3 存档路径自动定位（`savePathLibrary.ts` + `savePathFinder.ts`）

**三路并存**，候选列表统一打分排序，来源用 `origin` 字段区分：

| 优先级 | 来源（`origin`） | 分值 | 说明 |
| --- | --- | --- | --- |
| 1 | `library` | 99 | 内置知识库命中（6613 款 × 15042 条路径） |
| 2 | `snapshot` | 95 | 启动前后快照差分命中 |
| 3 | `known-rule` | 85 | 15 条热门游戏内置规则 |
| 4+ | `game-name-dir` / `appdata` / `documents` … | 递减 | 目录名扫描与惯例位置 |

#### 6.3.1 知识库（`savePathLibrary`）

数据源为 **Ludusavi manifest（MIT）** 的转换产物 `resources/data/save-paths.json`（2.73 MB）：

```
games[]    6613 款：{ k, name, title, steamId, installDir, cloud[], paths[], regs? }
bySteamId  { "<appid>": <games 下标> }      ← 与 Steam 库扫描结果直接 join
paths[]    { raw, ph[], tags? }             ← raw 为 POSIX 正斜杠书写
```

**匹配顺序**：先按 `steamId` 精确查（**零模糊匹配**），查不到再按名称 + 别名兜底。

> **为什么用 appid 做 joinKey**：Steam 扫描结果本身带 appid，知识库也用 appid 建索引，两边直接对接，不经过任何字符串相似度计算 —— 从根上消除「同名不同游戏」误配。

> **斜杠切段的重要性**：`title` 是「中文/英文/别名」的斜杠拼接串。必须按 `/` 切段后**逐段建键**；整串归一化会让匹配率从 ~79% 掉到 2%。

#### 6.3.2 占位符解析

Ludusavi 用 16 个占位符书写路径，解析时必须**最长优先**替换：

```typescript
['<home>', d.home],
['<winLocalAppDataLow>', d.localLow],  // ← 必须先于下一条，否则会被截断
['<winLocalAppData>',   d.local],
['<winAppData>',        d.roaming],
// … <winDocuments> <winSavedGames> <winPublic> <winProgramData>
//    <winDir> <osUserName> <root>
```

- `<storeUserId>` **不替换**，保留为通配符，由 `expandWildcard()` 列父目录后逐个展开（MS Store 游戏的账号 ID 目录名不可预测）。
- `<xdgData>` / `<xdgConfig>` / `<xdgCache>` 在 Windows 上判为不适用，直接跳过。
- 路径书写用 POSIX 正斜杠，Windows 侧由 `path.join` 兜住，不手工拼分隔符。

#### 6.3.3 规则表与快照差分（`savePathFinder`）

知识库未命中时的兜底：

1. **一键探测**：15 条热门游戏内置规则表（星露谷 / 巫师 3 / 艾尔登法环 / 博德之门 3 / 赛博朋克 2077 / 上古卷轴 5 / 辐射 4 / 空洞骑士 / 泰拉瑞亚 / 饥荒 / 黑魂 / 怪猎 / 生化危机 / 仁王 / 尼尔），加目录名关键字扫描。
   - 扫描根：`%APPDATA%`、`%LOCALAPPDATA%`、`Documents\My Games`、`Saved Games`、`Documents`、`AppData\LocalLow`、游戏安装目录。
   - 上限保护：`MAX_DEPTH = 4`、`MAX_COUNT_FILES = 2000`，避免大目录卡死。

2. **快照差分**：先建立基线快照（记录目录内文件数 / 体积 / 最近 mtime），启动游戏并保存进度后对比，命中的目录直接作为**高置信候选**。

**防误报三道闸**（首轮实测曾命中 `DingTalk\...\de`、`npm-cache\_cacache\index-v5\de` 这类噪音目录）：

| 闸门 | 规则 |
| --- | --- |
| 目录名长度门槛 | `MIN_MATCH_DIR_LEN = 5` |
| 噪音片段过滤 | `NOISE_FRAGMENTS`：cache / logs / tmp / backup / staging … |
| 词元长度 | ≥ 4，避免 `Stardew Valley` 拆出 `de` 这类碎片反向误匹配 |

修复后误报从 4 条降到 **0 条**。

报告文案会区分两种情况，避免「知识库有但我们没找到」被误解为「没有这条数据」：

> 知识库收录了该游戏的 **N** 条路径，其中 **M** 条在本机不存在（游戏可能尚未安装到该位置，或还没保存过存档）。

### 6.4 修改器 / MOD 元数据知识库（`trainerLibrary.ts`）

`resources/data/trainers.json`（8.32 MB，8943 条 = 7825 MOD + 1118 修改器）是社区帖的**离线元数据快照**。

```
resources[]  { id, title, kind, gameName, risk, status, description,
               source, homepage, tags[],
               cover, linkKinds[], linkCount, postedAt }   ← 后四项为扩展字段
stats        { total, byKind, withLinks, byNetdisk }
```

**检索能力**：

- `trainersForGame(gameName, aliases)` — 按游戏名取该游戏全部条目（**值为数组**：同一游戏常有几十条 MOD，不能只留一条）。
- `searchTrainers(keyword, kinds, limit)` — 标题 + 游戏名 + 描述 + 标签的归一化子串检索。

**接入位置**：作为 `onlineSearch` 的**离线兜底层**。当在线源全部失败、缓存过期时，用 `fallbackOffline(keyword)` 优先返回与关键词匹配的知识库条目（按相关性排序），而不是固定 5 条演示数据。

**归一化复用**：与存档路径库共用 `util.ts` 的 `normKey`。这是刻意的 —— 同一语义的清洗规则只能有一份，否则同一款游戏在两个模块里会算出两个键。

### 6.5 名称归一化的双实现与防漂移（`util.ts` ↔ `src/utils/gameName.ts`）

**这是一个已知的设计张力，必须显式记录。**

`electron/` 与 `src/` 是两个独立编译单元（`tsconfig.electron.json` 的 `rootDir` 为 `electron`），主进程代码**无法** import 渲染进程的 `src/utils/gameName.ts`。因此归一化函数在两侧各有一份：

| 位置 | 消费者 | 内容 |
| --- | --- | --- |
| `electron/util.ts` → `normKey` | 主进程：在线检索去重、知识库建键、别名匹配 | 唯一真源 |
| `src/utils/gameName.ts` → `normKey` | 渲染进程：名称比对与展示 | 镜像实现 |

**防漂移机制**：`npm run verify:data` 会

1. 从两个源文件里正则提取符号表字面量，断言**逐字符一致**；
2. 用 18 条共享语料（含 CJK、商标号、全角标点、斜杠拼接）跑两边实现，断言输出相同；
3. 断言关键性质：CJK 保留、空白与大小写处理、符号剥离完整。

任一侧被单独修改，校验立即失败。

**核心规则**（移植自上游，保留两条护栏）：

```typescript
// 剥符号但保留 CJK
const SYMBOLS = /[™®©°′″·・:：,，.。!！?？'"“”‘’()（）[\]【】<>《》|｜/\\~～\-–—_+*&#@$%^;；＊]/g
// 代际数字防误配：查询带代际数字而目标没有 → 拒绝
//   《The Sims 4》查到 Skyrim 不会被误配
```

**代际数字护栏**（`numMismatch`）：查询含 `4` 而目标不含，判为不匹配。避免「The Sims 4」误配到「The Sims 3」—— 这对修改器/MOD 匹配尤其关键，跨代际的修改器用上去会直接崩游戏。

### 6.6 日期归一与网盘链接抽取（`src/utils/sourceText.ts`）

移植自上游 `shared.js` 的两个纯函数，供渲染层展示用：

- **`normDate(input)`** — 处理**贪婪正则吃位**这个真实陷阱：

  ```
  输入 "2026/9/8"  →  正则 \d{1,2} 贪婪吞掉后续数字  →  2026/9/89  →  Invalid Date
  ```

  还原策略：`day > 31` 时只取被吞数字的**首位**，再用 `Date.UTC` 构造并**反向校验**月/日是否被规范化（`dt.getUTCMonth() !== month - 1` 则判为非法日期）。

- **`extractLinks(text)`** — 用 10 条网盘识别表（`NETDISK`）给链接分类（百度 / 夸克 / 迅雷 / 移动云盘 / UC …），并过滤站内跳转链接。

  > 上游踩过的坑：`extractLinks` 曾在两个文件里各写一份，**上限一个 12 一个 20、一个过滤站内一个不**，同一份正文抽出不同结果。本项目只保留一份实现。

### 6.7 游戏图标与主程序识别（`gameArt.ts`）

图标来源优先级（**离线优先**）：

```
① Steam 本地封面缓存  appcache/librarycache/<appid>/library_600x900[_schinese].jpg
② exe 内嵌图标        app.getFileIcon → 48×48
③ Steam CDN           cdn.cloudflare.steamstatic.com/steam/apps/<appid>/library_600x900.jpg
```

取到后居中裁剪为正方形并缩放到 160×160 PNG，缓存到 `data/icons/<gameId>.png`。

主程序识别 `resolveMainExe()` 扫描 2 层深度后按权重打分：

| 项 | 权重 |
| --- | --- |
| 文件名等于目录名 / 目标名 | **+6000** |
| 文件名包含目标名 | +2000 |
| 与目录名共享前缀 ≥ 5 字符 | +2500 |
| 体积（MB，上限 300） | +体积 |
| 目录深度 | −1500 / 层 |

并用 `NOISE_EXE_PREFIX` / `NOISE_EXE_ANY`（unins / setup / vcredist / crashhandler / reporter / createdump / diagnostic / uninstall…）与 `SKIP_DIR`（redist / thirdparty…）排除安装器与运行时。

> 纯启发式「取最大 exe」会误选 `UnityCrashHandler64.exe`（1.6 MB > 真实主程序 0.9 MB）或更深的 `wallpaperui.exe`（12.7 MB）。加入噪音黑名单与共享前缀加权后，在 4 个真实游戏目录上复验全部命中。

### 6.8 在线聚合检索（`onlineSearch.ts`）

**数据源契约**（4 种 kind）：

| kind | 响应形态 | 说明 |
| --- | --- | --- |
| `json` | `{ version?, updatedAt?, resources: [...] }` 或裸数组 | 自建接口，字段宽松缺省；缺 `id`/`title` 的条目丢弃 |
| `rss` | RSS 2.0 或 Atom | 条目映射为「待核实」资源，不含下载地址 |
| `gamebanana` | `{ _aMetadata, _aRecords: [...] }` | GameBanana apiv11，免鉴权；过滤 19 个非资源分区（Article / Blog / Thread / Question / Review / Tutorial / Wip / Concept…） |
| `github` | 仓库搜索 `{ total_count, items }` 或 Release 数组 | 仓库形态无直链；Release 形态取首个资产直链 |

`url` 支持 `{keyword}` 占位符（检索时 URL 编码替换），含占位符的源在关键词为空时**跳过**且其**结果不写入聚合缓存**（结果随关键词变化）。

**并发与隔离**：`Promise.allSettled` + 每源独立 `AbortController` 超时，单源失败 / 超时被完全隔离，只降级为该源 0 条 + 状态提示。

**跨源去重合并**：识别键取 `id`，无 `id` 时用「标题 + 游戏名」归一化文本。命中多源时标 `multiSource` 并累积 `sourceNames`；高优先级（数字小）源**只补齐**低优先级条目为空的字段，**不覆盖**已有非空值。

**相关性打分**：标题完全相等 120 / 前缀 80 / 包含 60，游戏名 40，别名 32，标签 20，来源 12，描述 10，可用 +6，低风险 +3，有下载地址 +4。

**「kind 误标」容错**：`sniffPayload()` 即使 kind 标成 `json`，也能识别 `_aRecords`（GameBanana）或 `total_count + items[].full_name`（GitHub）并改用对应适配器；命中 GameBanana 分区汇总时给出准确报错（`请在地址里补 _sModelName=Mod`），而不是笼统的「契约不符」。

**内置预置源**（`presetSources.ts`）：GameBanana apiv11 与 GitHub REST API，均免鉴权、实测可用。播种策略为「**仅在保存列表为空时注入**」，用户删除后不会在下次启动被加回。

> 候选源实测结论：PCGamingWiki Cargo API `403`（Cloudflare）、Nexus Mods API `401`（需 OAuth）、ModDB RSS `403`、Thunderstore 单次响应 **332 MB** —— 均未采用。

### 6.9 解压安全（`archive.ts`）

解压前**先列出条目**，拒绝含绝对路径或 `..` 的越界条目，再执行解压；`staging/` 作为中间区，用完即删。解压工具探测顺序：用户配置路径 → 随包 `resources/tools/7za.exe`。

### 6.10 MOD 安装的还原点与回滚（`mods.ts`）

1. 计算安装计划 → 展示覆盖数量。
2. 对每个将被覆盖的现存目标文件，先复制到 `mods/restore/<MOD id>/<时间戳>/`。
3. 执行复制；任一步失败 → 回滚本批已复制文件。
4. 写入部署记录（`DeployRecord{ source, target, created }`），卸载时据此逆操作并清理空目录。

### 6.11 本机构建环境的已知坑位

以下为离线 / 受限环境下的实际踩坑记录，复现构建前建议先过一遍：

| 现象 | 处理 |
| --- | --- |
| `pnpm` 失败（本机无法创建目录符号链接） | 改用 `npm install` + 扁平 `node_modules` |
| `npm install` 后 4 个包文件被改名为 `*.DELETE.<hash>` | 跑 `npm run verify:deps` 按原名还原 |
| 打包卡在下载 `winCodeSign` | 关闭代码签名（`signAndEditExecutable: false`） |
| 清理 `dist` / `release` 时被安全删除层拦截 | 用 Python `shutil.rmtree` 或 PowerShell `Remove-Item -LiteralPath` |
| `ELECTRON_RUN_AS_NODE=1` 使 Electron 退化为纯 Node | 跑真实 Electron 探针前先清除该变量 |

---

## 七、获取与构建

**直接下载**：便携版发布在 [Releases](https://github.com/theifxzx666-blip/PC-Game-Resource-Hub/releases)。

| 版本 | 文件 | 大小 | MD5 |
| --- | --- | --- | --- |
| 0.7.1 | [`PC-Game-Resource-Hub-0.7.1-portable.exe`](https://github.com/theifxzx666-blip/PC-Game-Resource-Hub/releases/download/v0.7.1/PC-Game-Resource-Hub-0.7.1-portable.exe) | 106,522,288 字节 | `d4ef0082c873a3702785ee05dead70bc` |
| 0.7.0 | [`PC-Game-Resource-Hub-0.7.0-portable.exe`](https://github.com/theifxzx666-blip/PC-Game-Resource-Hub/releases/download/v0.7.0/PC-Game-Resource-Hub-0.7.0-portable.exe) | 106,432,764 字节 | `38ffea55a7b104487dab1ce875b4e52a` |
| 0.6.0 | [`PC-Game-Resource-Hub-0.6.0-portable.exe`](https://github.com/theifxzx666-blip/PC-Game-Resource-Hub/releases/download/v0.6.0/PC-Game-Resource-Hub-0.6.0-portable.exe) | 104,969,924 字节 | `6e24d1b2c9533aff23f264621792c9ec` |

免安装，双击直接运行。**尚未进行代码签名**，Windows 首次运行可能显示未签名安全提示。

### 7.1 环境要求

- Node.js 22.x、npm 10.x
- Windows 10 / 11 x64

### 7.2 构建步骤

```bash
cd 客户端源码

# 1) 安装依赖（首次约 2 分钟）
npm install --registry=https://registry.npmmirror.com
npm run verify:deps        # 校验依赖完整性

# 2) 开发模式（Vite 热更新 + 主进程 + preload CJS）
npm run dev

# 3) 类型检查
npm run typecheck          # vue-tsc --noEmit + tsc -p tsconfig.electron.json --noEmit

# 4) 数据与契约校验（含 normKey 双实现一致性、正文无直链）
npm run verify:data

# 5) 检索链路回归测试（需先 npm run build）
npm run verify:search

# 6) 一次跑齐全部校验
npm run verify             # verify:deps + verify:data + verify:search

# 7) 仅构建产物
npm run build

# 8) 打 Windows 便携版（输出到 客户端源码/release）
npm run package:win
```

### 7.3 需要自行补齐的项

| 项 | 原因 | 补齐方式 |
| --- | --- | --- |
| `resources/tools/7za.exe` | 第三方二进制，授权范围待最终确认，故未入库 | 从 <https://www.7-zip.org/> 获取 `7za.exe` 放入 `客户端源码/resources/tools/`；或打包后在客户端「设置 → 解压工具路径」指向本机已装的 `7z.exe` |
| Electron 运行时 | `build.electronDist` 指向本地已安装目录 | 正常 `npm install` 会下载；离线环境请预置 `node_modules/electron/dist` |
| `winCodeSign` 缓存 | 当前离线环境无该缓存，开启签名会卡在下载 | 已默认关闭代码签名，无需处理 |
| 便携版 `*.exe` 成品 | 单文件约 105 MB，超出 GitHub 单文件 100 MB 上限，故不在代码仓库内 | 从 [Releases](https://github.com/theifxzx666-blip/PC-Game-Resource-Hub/releases) 下载，或本地 `npm run package:win` 自行构建 |

---

## 八、验证记录

| 版本 | 主题 | 关键验证 |
| --- | --- | --- |
| 0.1.0 | 静态原型 | 9 个页面交互演示（不落盘） |
| 0.2.0 | 真实功能版 | IPC 桥打通，状态真实落盘；`vue-tsc` / `tsc` 退出码 0；便携版产出 |
| 0.3.0 | 存档路径自动定位 | 端到端 3 项全通过；误报修复至 0 条 |
| 0.4.0 | 在线聚合检索 | **48/48 断言通过**（含单源失败隔离、超时隔离 1519 ms、缓存命中不发请求、离线降级） |
| 0.5.0 | 开源数据源接入 | **62/62 通过**；真实联网冒烟 2/2 源可用（GameBanana 11 条 / GitHub 30 条） |
| 0.6.0 | 游戏库修复与图标 | **46/46 通过**；Steam 联网冒烟 3/3 PASS；4 个真实游戏目录主程序识别全中 |
| 0.7.0 | 内置知识库接入 | **`npm run verify:data` 6/6 通过**；6613 款存档路径 + 142 别名 + 8943 条修改器元数据随包分发；`normKey` 双实现一致性通过（18 条语料） |
| 0.7.1 | 检索链路修复 | **`verify:data` 6/6 + `verify:search` 9/9 通过**；搜「星露谷物语」0 条 → **377 条**（前 6 条游戏名全部精确匹配）；别名表 142 → **6485 条**，英文名 `Stardew Valley` 0 条 → 12 条；知识库正文清除下载链接 **13748 处**、残留 0 |
| 0.7.2 | 类型筛选修复 | **`verify:data` 6/6 + `verify:search` 11/11 通过**；「选中修改器 + 空关键词」0 条 → **1118 条**，MOD 400 → **7825 条**（该类型全量）；「存档/补丁」不再拿虚构演示条目充数，改为如实返回空 + 界面说明覆盖范围 |

每轮均执行 `vue-tsc --noEmit` 与 `tsc -p tsconfig.electron.json --noEmit`，并以「受控启动 + 数据目录落盘」判定运行期可用性。

### 8.1 `verify:data` 校验项

| # | 校验 | 通过标准 |
| --- | --- | --- |
| A1 | `save-paths.json` 结构 | ≥6000 款、≥14000 条路径、`bySteamId` 无悬空索引 |
| A2 | 占位符白名单 | 全部路径的 `ph[]` 都在解析器支持列表内（漏一个就会残留 `<xxx>` 字面量） |
| A3 | `name-aliases.json` 结构 | ≥3000 条、无自指、无空值；**关键中英对照必须存在**（`Stardew Valley` / `Terraria` / `大表哥2` / `MC`） |
| A4 | `trainers.json` 结构 | ≥8000 条；**`downloadUrl` / `fileName` 必须全空**（合规红线）；**`description` 不得残留 http(s) 链接、裸网盘域名、网盘口令、提取码**；`homepage` 必须是 http(s) |
| B | `normKey` 双实现一致 | 符号表字面量逐字符相同 + 18 条语料两边输出相同 + CJK 保留/符号剥离性质成立 |
| C | 占位符解析 | 最长优先替换正确（`<winLocalAppDataLow>` 不被 `<winLocalAppData>` 截断）、`<storeUserId>` 保留为通配符 |

### 8.2 `verify:search` 校验项

检索链路是「改一行、行为全变」的典型，单靠 `verify:data`（只看数据）守不住，因此单独有回归测试。

实现上**直接加载 `dist-electron/` 编译产物**，不重新实现一遍检索逻辑 ——
复刻一份副本来测，那份副本永远是对的，等于测了个假的。产物是 ESM 且
`import { app } from 'electron'`，故通过 `scripts/electron-loader.mjs`（`node:module`
的 `register` 钩子）把 `electron` 解析到桩模块 `electron-shim.mjs`。

| # | 校验 | 通过标准 |
| --- | --- | --- |
| S1 | 知识库作为一等数据源并入 | 搜「星露谷物语」> 100 条；首屏含知识库条目；`trainer-lib` 状态上报命中数 |
| S2 | 排序不倒挂 | 前 6 条 `gameName` 全部精确等于关键词（「关于某游戏的项目」不得排在「某游戏的资源」之前） |
| S3 | 别名展开 | 英文名 / 俗称 → 中文正式名（含 2 跳） |
| S4 | 英文名检索命中 | 搜 `Stardew Valley` 能命中 星露谷物语 条目 |
| S5 | 不存在的关键词 | 返回 0 条知识库条目（不拿无关结果凑数） |
| S6 | 无关键词不铺全库 | 知识库条目 ≤ 400（避免首屏铺 8943 条） |
| S7 | 多游戏泛化 | 泰拉瑞亚 / 恐怖黎明 / 我的世界 均 > 0 条（确认不是只对星露谷打补丁） |
| S8 | 大条目数游戏不被截断 | 赛博朋克2077 ≥719、上古卷轴5 ≥500、模拟人生4 ≥394、星露谷物语 ≥348（early 版本的 300 上限会砍掉一半以上，且砍的是「文件顺序靠后」的条目） |
| S9 | 只选类型、不输关键词 | 「修改器」「MOD」各自能拿到**该类型的全部**条目，首屏不得混入其他类型。断言取 `trainersInfo().byKind` 的**实际条数**比对而非写死阈值 —— 数据集重生成后条数会变，写死只会变成维护负担 |
| S10 | 未覆盖类型不拿演示数据充数 | 知识库没有「存档」「补丁」数据时，选中它们必须**如实返回空**，不得回落到 `offlineCatalog` 的虚构游戏条目 |

**`libraryAsOnline()` 的两条排序纪律**（两次踩坑换来的）：

1. **类型筛选必须先于截断。** `trainers.json` 按 `kind` 连续存放（前 7825 条全是 MOD，修改器从下标 7825 才开始）。原实现「先取文件前 400 条 → 再按 kind 过滤」，那 400 条里零个修改器 → 选中「修改器」返回 0 条。
2. **上限要加在排序之后。** `searchTrainers` 按文件顺序扫到 limit 就 break，先截断再打分，丢的是「文件顺序靠后」而非「低相关」的条目。

两条其实是同一件事：**上限截的必须是「不符合条件」的尾部，而不是「碰巧排在后面」的条目。**

---

## 九、合规边界与第三方声明

### 9.1 本项目边界

- 仅面向单机、本地文件与可追溯资源场景。
- **不提供**联网游戏辅助、反作弊规避、DRM 绕过、账号体系规避与破解分发。
- 客户端不内置任何修改器本体，只做资源目录、下载与本地管理。
- **内置知识库只存元数据**：修改器/MOD 条目的 `downloadUrl` 与 `fileName` 恒为空，`description` 正文中的下载链接/提取码已统一替换为「［见原帖］」，只保留来源帖地址与网盘平台分类；该约束由 `npm run verify:data` 强制。
- 文件写入仅限用户显式配置的路径与工具自身数据目录，**不扫描无关目录**。
- 破坏性操作（恢复存档、安装 / 卸载 MOD）均保留还原点或部署记录。

### 9.2 第三方组件

| 组件 | 许可证 | 使用方式 |
| --- | --- | --- |
| [Ludusavi](https://github.com/mtkennerly/ludusavi) | MIT | 其 manifest 存档路径数据经转换后作为内置知识库 `resources/data/save-paths.json` 分发（6613 款 / 15042 条）；仅使用数据，未调用其代码 |
| [game-aggregator](https://github.com/A13612812330/game-aggregator) | — | 参考其数据组织方式；移植 `name-normalize.js`（名称归一化）与 `shared.js`（日期归一 / 网盘识别）的算法至本项目 TS 侧；修改器/MOD 元数据由其离线数据集转换而来 |
| [mayflyMods](https://github.com/aojiangfuyou1/mayflyMods) | MIT | 改编路径工具函数至 `客户端源码/src/utils/modPath.ts` |
| [Game-Save-Manager](https://github.com/dyang886/Game-Save-Manager) | GPL-3.0 | **仅参考产品流程**，未复制或链接其源码 |
| [Game-Cheats-Manager](https://github.com/dyang886/Game-Cheats-Manager) | — | 仅作资源目录与状态展示的产品参考，未复制源码；其「反作弊绕过提示」「Defender 白名单」属立项排除范围 |
| [7-Zip](https://www.7-zip.org/) | LGPL-2.1+ / unRAR restriction | 以独立可执行文件随包分发，通过子进程调用，未静态链接 |

> **数据来源说明**：内置修改器/MOD 知识库（`trainers.json`）是社区公开帖的离线元数据快照，**已剥离全部下载直链**，仅保留标题、所属游戏、来源页与网盘平台分类。该数据集不构成分发行为，相关内容的权利归原始发布者所有；若权利人要求移除，可通过仓库 Issue 联系。

完整声明见 [`客户端源码/THIRD_PARTY_NOTICES.md`](客户端源码/THIRD_PARTY_NOTICES.md)。

### 9.3 License

本仓库尚未附加开源许可证。在补充 `LICENSE` 之前，默认保留所有权利（All rights reserved）；对外分发第三方二进制（如 `7za.exe`）前，请先复核其授权范围。

---

## Ten-minute Guide (English)

**PC Game Resource Hub** is a local-first Windows desktop tool for single-player PC gamers. It unifies game library management, save backup/restore, MOD import/enable/disable, and resource search & download — with a rollback guarantee on every destructive operation.

**Architecture.** Electron main process (`客户端源码/electron`) owns the file system, archive subprocesses, Steam scanning, HTTP download/search and JSON persistence. The renderer (Vue 3 + Element Plus + Pinia, `客户端源码/src`) is sandboxed — `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` — and reaches system capabilities only through `window.api`, exposed by `preload.cjs` via `contextBridge`. Every IPC call returns `{ ok: true, data } | { ok: false, error }`.

**Pluggable data sources.** Online search is not bound to any single backend. Sources are a configuration list of four kinds — `json`, `rss`, `gamebanana`, `github` — fetched concurrently with per-source timeouts and full error isolation. A four-level degradation chain (live network → local TTL cache → bundled trainer metadata library → demo catalog) guarantees the UI is never empty.

**Bundled knowledge base.** `客户端源码/resources/data/` ships outside the asar and is hot-swappable: `save-paths.json` (6,613 games × 15,042 save paths, converted from the Ludusavi manifest, MIT), `name-aliases.json` (6,485 aliases — Chinese/English pairs plus player slang, derived from the bundled titles and the reference project), and `trainers.json` (8,943 trainer/MOD metadata records). Save-path lookup joins on Steam appid — a zero-fuzzy-match join that eliminates same-name mismatches at the root.

**Aliases are a first-class source, not a nicety.** The library stores Chinese canonical names ("星露谷物语") while users type English names or slang ("Stardew Valley", "大表哥2", "MC"). Queries are expanded through the alias table (two hops, cycle-guarded) before hitting the name index — without this step, English-name searches necessarily return zero.

**Metadata only.** The bundled trainer/MOD library is an offline metadata snapshot with all download links stripped at build time: `downloadUrl` and `fileName` are always empty strings, `homepage` points to the source post, `linkKinds` keeps only the platform category (e.g. "百度网盘"), and any download URL, access code, or netdisk token inside `description` is replaced with the placeholder "［见原帖］". Enforced by `npm run verify:data`.

**Offline-first.** Game icons prefer the local Steam library cache, then the embedded exe icon, and only then the Steam CDN. Save-path detection scans local directories only.

**Scope.** No anti-cheat circumvention, no DRM bypass, no crack distribution, no online-game assistance, no account bypass. The client ships no trainer binaries.

**Build.**

```bash
cd 客户端源码
npm install --registry=https://registry.npmmirror.com
npm run verify:deps
npm run typecheck
npm run verify             # deps + data + search
npm run build
npm run package:win
```

A portable `*.exe` is emitted to `客户端源码/release`. `resources/tools/7za.exe` is intentionally not committed — see §7.3.

Note: `verify:search` loads the compiled `dist-electron/` output, so run `npm run build` (or at least `tsc -p tsconfig.electron.json`) first. `npm run verify` does this for `verify:data` but not for `verify:search`'s prerequisites — the script will tell you if the artifacts are missing.

---

*文档版本：0.7.2 · 最近更新：2026-10-08*
