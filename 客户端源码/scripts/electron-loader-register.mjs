/**
 * 注册 ESM 加载钩子（供 package.json 的 verify:search 使用）。
 *
 * 直接写 `node --import ./scripts/electron-loader.mjs` 不行 —— 那样注册的
 * resolve 钩子要在**同一次加载**里生效，而 hook 文件本身的 `register` 调用
 * 需要走 node:module 的 register API。这里统一走 register，避免 Windows 下
 * `--import` 路径解析的坑。
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(path.join(here, 'electron-loader.mjs')));
