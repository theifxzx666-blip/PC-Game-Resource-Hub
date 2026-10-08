# 第三方代码与授权说明

更新时间：2026 年 10 月 8 日

本项目为非商用 Demo。根据项目委托方说明，已获得相关作者授权；任何对外发布、再次分发或扩展复用前，仍需由项目负责人复核授权范围与适用许可证。

## Ludusavi（存档路径数据）

- 项目地址：https://github.com/mtkennerly/ludusavi
- 上游许可证：MIT License。
- 本项目使用位置：`客户端源码/resources/data/save-paths.json`（内置知识库，随包分发）。
- 复用范围：**仅使用其 manifest 数据**（游戏名、Steam appid、安装目录、存档路径、注册表项），经字段裁剪与格式转换后作为离线数据集分发；**未调用或复制其任何代码**。
- 转换说明：源数据 5.62 MB → 本项目 2.73 MB，剔除了上游站点专用字段（预渲染 Windows 路径、移动端字段等）；路径占位符保持 Ludusavi 原口径（`<home>`、`<winLocalAppData>` 等 16 个），由 `electron/savePathLibrary.ts` 在运行时解析。
- 规模：6613 款游戏 / 15042 条路径 / 6502 条带 Steam appid。
- 版权声明：Copyright (c) 2019 Matthew T. Kennerly。

## game-aggregator（算法移植 + 元数据来源）

- 项目地址：https://github.com/A13612812330/game-aggregator
- 本项目使用位置与范围：
  1. **算法移植** → `src/utils/gameName.ts`（名称归一化 `normKey` / 代际数字防误配 `numMismatch`）与 `src/utils/sourceText.ts`（日期归一 `normDate` / 网盘识别表 `NETDISK` / 链接抽取 `extractLinks`），移植自其 `data/name-normalize.js`、`data/date-norm.js`、`shared.js`。
  2. **别名数据** → `客户端源码/resources/data/name-aliases.json`，由其 `data/cn-names.json` 与 `fetchers/aliases.json` 合并整理（142 条）。
  3. **元数据来源** → `客户端源码/resources/data/trainers.json`，由其 `data/mods.json` 转换而来。
- 变更说明（元数据）：
  - **只保留元数据，剥离全部下载直链** —— `downloadUrl` 与 `fileName` 字段恒为空串，仅保留来源帖地址（`homepage`）与网盘平台分类（`linkKinds`，如「百度网盘」「夸克网盘」）。
  - 正文压平并截断至 220 字符；时间戳归一为 `YYYY-MM-DD`。
  - 剔除移动端（手游）条目，只保留 PC 端 MOD / 修改器。
  - 转换脚本位于本机 `临时文件/_探查/_build_trainers.py`（不入库）。
- 规模：8943 条（7825 MOD + 1118 修改器）。
- **权利归属**：该数据集是社区公开帖的离线快照，标题、正文、封面的权利归原始发布者所有。本项目不构成内容再分发，仅为检索索引。若权利人要求移除相关条目，可通过仓库 Issue 联系。

## mayflyMods

- 项目地址：https://github.com/aojiangfuyou1/mayflyMods
- 上游许可证：MIT License，另附上游作者的特殊使用说明。
- 本项目使用位置：`src/utils/modPath.ts`
- 复用范围：路径拆分、文件名与扩展名判断工具函数。
- 变更说明：移除了未被本项目使用的安装规则与适配器代码，仅保留通用路径处理函数；文件头保留来源和许可证说明。
- 版权声明：Copyright (c) 2026 aojiangfuyou。

## Game Save Manager

- 项目地址：https://github.com/dyang886/Game-Save-Manager
- 上游许可证：GNU GPL v3。
- 本项目使用范围：仅参考其「备份、恢复、历史版本与操作确认」的产品流程；本项目未复制或链接其 GPL 源代码。
- 原因：避免在未留存独立书面授权条款的情况下，将 GPL 代码直接并入本项目。

## Game Cheats Manager

- 项目地址：https://github.com/dyang886/Game-Cheats-Manager
- 本项目使用范围：作为修改器资源目录、版本标记与资源状态展示的产品参考。
- 当前状态：本项目未复制其源代码。若后续需要直接复用代码，应先记录对应文件、版本、许可证与授权证明。
- 明确不采用的能力：反作弊绕过提示、Windows Defender 白名单助手。二者属于本项目立项范围之外的合规红线。

## 7-Zip（7za.exe）

- 项目地址：https://www.7-zip.org/
- 许可证：GNU LGPL v2.1 或更高版本，另有 unRAR restriction 附加条款。
- 本项目使用位置：`客户端源码/resources/tools/7za.exe`，打包后位于安装包 `resources/tools/7za.exe`。
- 复用范围：以独立可执行文件形式随包分发，通过子进程调用，用于解压用户导入的 zip / 7z 资源包，以及生成备份导出归档。
- 变更说明：未修改二进制文件，仅原样复制并按原许可证分发。
- 限制说明：`7za.exe` 不支持 rar 格式；若需支持 rar，需由用户另行安装完整版 7-Zip 并在「设置」中指定其 `7z.exe` 路径。
- 如需满足 LGPL 再链接要求，请注意本程序通过独立进程调用该工具，未与其静态链接。

## 本项目边界

本项目不包含联网对战辅助、反作弊规避、DRM 绕过、账号体系规避、破解分发或干扰游戏安全机制的功能。

内置修改器 / MOD 知识库只保留元数据，**不含任何下载直链**：`downloadUrl` 与 `fileName` 恒为空串，`homepage` 指向来源帖地址由用户自行查看。该约束由 `npm run verify:data` 强制校验，一旦数据集出现下载直链即校验失败。
