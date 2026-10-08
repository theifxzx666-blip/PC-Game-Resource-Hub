/**
 * Electron 桩模块（仅测试用）。
 *
 * 只实现 util.ts / savePathLibrary.ts / trainerLibrary.ts 实际用到的成员：
 *   app.isPackaged  — 置 false，走「开发态」路径分支
 *   app.getAppPath() — 返回仓库根，使 resources/data 能被找到
 *   app.getPath(name) — 只实现 appData / documents，其余回退仓库根
 *
 * 注意：本文件被 scripts/electron-loader.mjs 解析为 `electron` 的替身，
 * 不要在任何生产代码路径里引用。
 */
import path from 'node:path';
import process from 'node:process';

const root = process.env.VERIFY_SEARCH_ROOT || process.cwd();

export const app = {
  isPackaged: false,
  getAppPath: () => root,
  getPath: (name) => {
    if (name === 'appData') return process.env.APPDATA || root;
    if (name === 'documents') return path.join(process.env.USERPROFILE || root, 'Documents');
    return root;
  },
};

export default { app };
