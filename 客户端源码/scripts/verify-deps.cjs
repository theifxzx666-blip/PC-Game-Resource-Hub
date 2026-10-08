/**
 * 依赖完整性校验（npm run verify:deps）
 *
 * 背景：本机存在「安全删除层」会拦截删除请求，npm 安装时会把部分包文件改名为
 * `*.DELETE.<32位hex>`，导致后续 electron-builder 启动即报 Cannot find module。
 * 同时 npm install <pkg> 曾把 package.json 覆盖成残缺版本（丢失 scripts / build 段）。
 *
 * 本脚本在每次安装依赖后、打包前运行，提前发现这两类问题。
 * 退出码 0 = 通过；1 = 发现问题（会在 stdout 给出修复提示）。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const problems = [];
const notes = [];

// ---- 1. package.json 完整性 ----
const pkgPath = path.join(root, 'package.json');
let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch (e) {
  problems.push(`package.json 无法解析：${e.message}`);
}

if (pkg) {
  for (const field of ['scripts', 'dependencies', 'devDependencies', 'build']) {
    if (!pkg[field] || Object.keys(pkg[field]).length === 0) {
      problems.push(`package.json 缺少 "${field}" 字段（可能被 npm install <pkg> 覆盖，需从版本控制恢复）`);
    }
  }
  const requiredScripts = ['build', 'build:preload', 'typecheck', 'package:win'];
  for (const s of requiredScripts) {
    if (!pkg.scripts?.[s]) problems.push(`package.json 缺少脚本 "${s}"`);
  }
  if (pkg.build) {
    const requiredFiles = ['dist/**', 'dist-electron/**', 'THIRD_PARTY_NOTICES.md'];
    for (const f of requiredFiles) {
      if (!Array.isArray(pkg.build.files) || !pkg.build.files.includes(f)) {
        problems.push(`package.json build.files 缺少 "${f}"`);
      }
    }
    if (pkg.build.productName !== '游戏资源服务工具演示') {
      problems.push(`package.json build.productName 异常：${pkg.build.productName}`);
    }
  }
}

// ---- 2. 关键包是否可解析 ----
const requiredModules = [
  'electron',
  'vite',
  'esbuild',
  'vue',
  'element-plus',
  'pinia',
  'typescript',
  'vue-tsc',
  'electron-builder',
];
const nm = path.join(root, 'node_modules');
for (const m of requiredModules) {
  const dir = path.join(nm, m);
  if (!fs.existsSync(dir)) {
    problems.push(`node_modules 缺少包：${m}`);
    continue;
  }
  try {
    // package.json 必须可读且能被 Node 解析入口
    const pj = path.join(dir, 'package.json');
    if (!fs.existsSync(pj)) {
      problems.push(`${m} 缺少 package.json`);
      continue;
    }
    require.resolve(m, { paths: [root] });
  } catch (e) {
    problems.push(`${m} 无法被 Node 解析：${e.message.split('\n')[0]}`);
  }
}

// ---- 3. Electron 运行时 ----
const electronDir = path.join(nm, 'electron');
const electronExe = path.join(electronDir, 'dist', 'electron.exe');
const electronPathTxt = path.join(electronDir, 'path.txt');
if (!fs.existsSync(electronExe)) {
  problems.push(
    'electron/dist/electron.exe 缺失。修复：从 F:\\Codex\\Supports\\electron-cache\\electron-v44.4.5-win32-x64.zip 解压到 node_modules/electron/dist，并写入 path.txt（内容：electron.exe）',
  );
} else {
  notes.push(`electron.exe 就绪（${(fs.statSync(electronExe).size / 1024 / 1024).toFixed(0)} MB）`);
}
if (!fs.existsSync(electronPathTxt)) {
  problems.push('electron/path.txt 缺失。修复：写入一行文本 electron.exe');
}

// ---- 4. .bin 关键 shim ----
const binDir = path.join(nm, '.bin');
for (const b of ['esbuild.cmd', 'electron-builder.cmd', 'vite.cmd', 'vue-tsc.cmd']) {
  if (!fs.existsSync(path.join(binDir, b))) {
    problems.push(`node_modules/.bin 缺少 ${b}`);
  }
}

// ---- 5. 安全删除层改名残留（核心检查）----
const renamed = [];
const walk = (dir, depth) => {
  if (depth > 6 || renamed.length > 200) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.cache' || entry.name === '.git') continue;
      walk(full, depth + 1);
    } else if (/\.DELETE\.[0-9a-f]{32}$/.test(entry.name)) {
      renamed.push(full);
    }
  }
};
walk(nm, 0);

if (renamed.length > 0) {
  problems.push(
    `发现 ${renamed.length} 个被安全删除层改名的文件（*.DELETE.<hash>），这会导致打包报 Cannot find module：\n` +
      renamed.map((f) => '    ' + path.relative(root, f)).join('\n') +
      '\n  修复：去掉 ".DELETE.<32位hex>" 后缀还原原名（可用 python 批量 os.replace）',
  );
}

// ---- 报告 ----
console.log('=== 依赖完整性校验 ===\n');
for (const n of notes) console.log('  [OK] ' + n);

if (problems.length === 0) {
  console.log('\n全部通过，可以执行 npm run package:win\n');
  process.exit(0);
}

console.log('');
for (const p of problems) console.log('  [FAIL] ' + p);
console.log(`\n共 ${problems.length} 项问题，请先修复后再打包。\n`);
process.exit(1);
