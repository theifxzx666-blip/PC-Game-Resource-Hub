# 客户端源码 · PC Game Resource Hub Client

PC 游戏资源服务工具的 Windows 桌面客户端（Electron + Vue 3 + TypeScript）。

项目概述、设计思路、技术框架与功能模块说明见仓库根目录的 [`../README.md`](../README.md)。

## 目录一览

- `electron/` 主进程与预加载脚本（文件系统、Steam 扫描、存档/MOD、在线检索、打包）
- `src/` 渲染进程（Vue 3 + Element Plus + Pinia）
- `resources/tools/` 随包解压工具（`7za.exe` 不入库，见根 README §7.3）
- `scripts/verify-deps.cjs` 依赖完整性自检

## 运行与构建

依赖安装走 **npm**（本机无法创建目录符号链接，pnpm 的 isolated 布局不可用）。

```bash
npm install --registry=https://registry.npmmirror.com
npm run verify:deps   # 校验依赖完整性
npm run dev           # 开发模式
npm run typecheck     # 类型检查
npm run build         # 仅构建产物
npm run package:win   # 打 Windows 便携版，输出到 release/
```

## 构建链路约束

预加载脚本必须以 **CJS** 产出（`dist-electron/preload.cjs`），因此 `build` 与 `dev` 都会先执行一次 esbuild：

```bash
esbuild electron/preload.ts --bundle --platform=node --format=cjs \
  --outfile=dist-electron/preload.cjs --external:electron
```

## 第三方声明

见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。
