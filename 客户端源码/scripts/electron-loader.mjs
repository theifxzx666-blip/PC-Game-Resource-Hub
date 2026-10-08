/**
 * ESM 加载钩子：把 `electron` 解析到一个本地桩模块。
 *
 * 为什么需要它：dist-electron/*.js 是 ESM，顶层 `import { app } from 'electron'`。
 * 测试环境没有 Electron 运行时，Node 会因 'electron' 是无法解析的裸模块而报错。
 *
 * 用 Module._load 打桩只能拦截 CJS require，拦不住 ESM import —— 必须走
 * `node --import` 注册的 loader 钩子。见 verify-search.cjs 的用法。
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM = pathToFileURL(path.join(here, 'electron-shim.mjs')).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: SHIM, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
