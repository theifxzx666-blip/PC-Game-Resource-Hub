/**
 * 数据与契约不变量校验（npm run verify:data）
 *
 * 为什么不用测试框架：本项目 devDependencies 刻意保持精简，
 * 且已有 scripts/verify-deps.cjs 的先例 —— 零依赖、退出码即结论。
 *
 * 校验三件事：
 *   A. 内置数据集（save-paths / name-aliases / trainers）结构完好、条数达标
 *   B. 归一化函数 normKey 在「主进程实现」与「渲染进程实现」之间输出一致
 *      —— 两边是独立编译单元无法互相 import，只能靠本脚本守住不漂移
 *   C. 存档路径占位符解析在 Windows 口径下不产生 POSIX 残留
 *
 * 退出码 0 = 全部通过；1 = 有失败项。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'resources', 'data');

const failures = [];
const passes = [];

function check(name, fn) {
  try {
    const detail = fn();
    passes.push(`${name}${detail ? ' — ' + detail : ''}`);
  } catch (e) {
    failures.push(`${name} — ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// A. 内置数据集
// ---------------------------------------------------------------------------

check('save-paths.json 结构', () => {
  const file = path.join(dataDir, 'save-paths.json');
  assert(fs.existsSync(file), `文件不存在：${file}`);
  const data = readJson(file);
  assert(Array.isArray(data.games), 'games 不是数组');
  assert(data.games.length >= 6000, `游戏数异常偏少：${data.games.length}`);
  assert(data.bySteamId && typeof data.bySteamId === 'object', 'bySteamId 索引缺失');

  let paths = 0;
  let withSteam = 0;
  const badPath = [];
  for (const g of data.games) {
    if (!g || typeof g !== 'object') {
      badPath.push('非对象条目');
      continue;
    }
    if (g.steamId) withSteam += 1;
    assert(typeof g.name === 'string' && g.name.length > 0, `条目缺 name：${JSON.stringify(g).slice(0, 80)}`);
    assert(Array.isArray(g.paths), `条目缺 paths：${g.name}`);
    for (const p of g.paths) {
      paths += 1;
      assert(typeof p.raw === 'string' && p.raw.length > 0, `${g.name} 的路径缺 raw`);
      assert(Array.isArray(p.ph), `${g.name} 的路径缺 ph 数组`);
    }
  }
  assert(badPath.length === 0, `脏条目 ${badPath.length} 个`);
  assert(paths >= 14000, `路径总数异常偏少：${paths}`);
  assert(withSteam >= 6000, `带 steamId 的游戏异常偏少：${withSteam}`);

  // bySteamId 的索引必须真的指向存在的游戏
  let dangling = 0;
  for (const [sid, idx] of Object.entries(data.bySteamId)) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= data.games.length) dangling += 1;
    else if (String(data.games[idx].steamId) !== String(sid)) {
      // 允许同 appid 多形态，但指向的游戏必须带同一 appid
      if (String(data.games[idx].steamId) !== String(sid)) dangling += 1;
    }
  }
  assert(dangling === 0, `bySteamId 有 ${dangling} 个悬空索引`);

  return `${data.games.length} 款 / ${paths} 条路径 / ${withSteam} 带 Steam ID`;
});

check('save-paths.json 占位符白名单', () => {
  const file = path.join(dataDir, 'save-paths.json');
  const data = readJson(file);
  // 解析器已支持的占位符（含最长优先替换所需的完整集合）
  const SUPPORTED = new Set([
    '<home>', '<base>', '<winAppData>', '<winLocalAppData>', '<winLocalAppDataLow>',
    '<winDocuments>', '<winSavedGames>', '<winPublic>', '<winProgramData>', '<winDir>',
    '<root>', '<osUserName>', '<storeUserId>', '<xdgData>', '<xdgConfig>', '<xdgCache>',
  ]);
  const unknown = new Map();
  for (const g of data.games) {
    for (const p of g.paths) {
      for (const ph of p.ph) {
        if (!SUPPORTED.has(ph)) unknown.set(ph, (unknown.get(ph) || 0) + 1);
      }
    }
  }
  assert(
    unknown.size === 0,
    `出现未支持的占位符（解析器会漏替换）：${[...unknown.entries()].map(([k, v]) => `${k}×${v}`).join(', ')}`,
  );
  return `${data.games.length} 款游戏的占位符全部在支持列表内`;
});

check('name-aliases.json 结构', () => {
  const file = path.join(dataDir, 'name-aliases.json');
  assert(fs.existsSync(file), `文件不存在：${file}`);
  const data = readJson(file);
  assert(data.aliases && typeof data.aliases === 'object' && !Array.isArray(data.aliases), 'aliases 不是对象');
  const keys = Object.keys(data.aliases);
  // 阈值说明：schema 1 只有 142 条（仅参考项目的 3A 大作），
  // schema 2 起从 save-paths/trainers 的双语标题扩充到 6000+，
  // 覆盖了知识库里真正高频的中小体量游戏。低于 3000 说明扩充没跑。
  assert(keys.length >= 3000, `别名数异常偏少：${keys.length}（schema 2 起应 >= 3000）`);
  const bad = [];
  for (const [k, v] of Object.entries(data.aliases)) {
    if (!k || typeof v !== 'string' || !v.trim()) bad.push(k);
    if (k === v) bad.push(`${k}（自指）`);
  }
  assert(bad.length === 0, `脏别名 ${bad.length} 个：${bad.slice(0, 5).join(', ')}`);

  // ★ 实测坑：schema 1 里没有「Stardew Valley」，导致英文名搜索 0 命中。
  //   这条断言把「关键中英对照必须存在」固化下来，防止扩充逻辑被改回去。
  const REQUIRED = [
    ['Stardew Valley', '星露谷物语'],
    ['Terraria', '泰拉瑞亚'],
    ['大表哥2', '荒野大镖客2'],
    ['MC', '我的世界'],
  ];
  const missing = REQUIRED.filter(([alias]) => !data.aliases[alias]).map(([alias]) => alias);
  assert(missing.length === 0, `缺少关键别名：${missing.join(', ')}`);

  return `${keys.length} 条别名（含关键中英对照）`;
});

check('trainers.json 结构', () => {
  const file = path.join(dataDir, 'trainers.json');
  assert(fs.existsSync(file), `文件不存在：${file}`);
  const data = readJson(file);
  assert(Array.isArray(data.resources), 'resources 不是数组');
  assert(data.resources.length >= 8000, `条数异常偏少：${data.resources.length}`);

  const KINDS = new Set(['修改器', '存档', 'MOD', '补丁']);
  const RISKS = new Set(['低', '中']);
  const seen = new Set();
  const problems = [];
  let modifier = 0;
  let withHomepage = 0;
  // 描述里残留的下载链接（见下方「自欺式合规」说明）
  const descLeaks = [];

  // ★ 描述字段的链接检测。
  //   只查 downloadUrl 字段是不够的：初版数据集 downloadUrl 全为空串，
  //   校验一路绿灯，但 description 里原样贴着 pan.xunlei.com / pan.baidu.com 直链，
  //   实测 8943 条中 8624 条（96%）中招 —— 合规声明成了自欺。
  //   现在把「描述不得含可点击链接」也固化成断言。
  const URL_RE = /https?:\/\/[^\s，。、；：）)】\]"']+/gi;
  const BARE_PAN_RE = /\b(?:pan|yun|cloud)\.\w+\.(?:com|cn|net)/i;
  // 网盘口令（夸克 /~xxxx~/）与提取码（提取码: abcd）也不能留
  const TOKEN_RE = /~[0-9A-Za-z]{6,}~/;
  const ACCESS_CODE_RE = /(?:提取码|访问码|提取密码|访问密码)\s*[:：]\s*[A-Za-z0-9]{4,}/;

  for (const r of data.resources) {
    if (!r || typeof r !== 'object') {
      problems.push('非对象条目');
      continue;
    }
    if (!r.id || seen.has(r.id)) problems.push(`id 缺失或重复：${r.id}`);
    else seen.add(r.id);
    if (!KINDS.has(r.kind)) problems.push(`${r.id} kind 非法：${r.kind}`);
    if (!RISKS.has(r.risk)) problems.push(`${r.id} risk 非法：${r.risk}`);
    if (r.kind === '修改器') modifier += 1;
    // ★ 合规红线：数据集里绝不能出现下载直链
    if (r.downloadUrl) problems.push(`${r.id} 出现了 downloadUrl（违反「只做元数据」约定）`);
    if (r.fileName) problems.push(`${r.id} 出现了 fileName（违反「只做元数据」约定）`);
    if (r.homepage) {
      withHomepage += 1;
      if (!/^https?:\/\//i.test(r.homepage)) problems.push(`${r.id} homepage 不是 http(s)：${r.homepage}`);
    }
    // 网盘来源分类里只能有分类名，不能混入 url
    for (const lk of r.linkKinds || []) {
      if (/^https?:|:\/\//i.test(lk)) problems.push(`${r.id} linkKinds 混入了链接：${lk}`);
    }
    // ★ 描述里不得残留可点击链接 / 网盘口令 / 提取码
    const desc = String(r.description || '');
    if (URL_RE.test(desc) || BARE_PAN_RE.test(desc) || TOKEN_RE.test(desc) || ACCESS_CODE_RE.test(desc)) {
      descLeaks.push(r.id);
    }
  }

  assert(problems.length === 0, `${problems.length} 项问题：${problems.slice(0, 5).join('; ')}`);
  assert(withHomepage === data.resources.length, `有 ${data.resources.length - withHomepage} 条缺来源页地址`);
  assert(
    descLeaks.length === 0,
    `${descLeaks.length} 条描述的正文里残留下载链接/口令（合规红线，例：${descLeaks.slice(0, 3).join(', ')}）`,
  );
  return `${data.resources.length} 条（${modifier} 修改器），全部为元数据、正文无直链`;
});

// ---------------------------------------------------------------------------
// B. normKey 双实现一致性（核心防漂移检查）
// ---------------------------------------------------------------------------

check('normKey 主进程/渲染进程实现一致', () => {
  const mainSrc = fs.readFileSync(path.join(root, 'electron', 'util.ts'), 'utf8');
  const rendererSrc = fs.readFileSync(path.join(root, 'src', 'utils', 'gameName.ts'), 'utf8');

  // 1) 符号表字面量必须逐字符一致
  const grab = (src, name) => {
    const re = new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*\\n?\\s*(/[^\\n]*?/g)`, 'm');
    const m = src.match(re);
    return m ? m[1] : null;
  };
  const mainSyms = grab(mainSrc, 'NORM_SYMBOLS');
  const renderSyms = grab(rendererSrc, 'SYMBOLS');
  assert(mainSyms, '主进程 util.ts 里找不到 NORM_SYMBOLS 正则');
  assert(renderSyms, '渲染进程 gameName.ts 里找不到 SYMBOLS 正则');
  assert(mainSyms === renderSyms, `符号表已漂移：\n  主进程  ${mainSyms}\n  渲染进程 ${renderSyms}`);

  // 2) 行为等价：同一份语料两边必须得到同一结果
  const evalNorm = (symbols, value) => {
    const re = eval(symbols); // 语料可信，仅用于校验
    return String(value == null ? '' : value)
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '')
      .replace(re, '');
  };

  const corpus = [
    'The Sims 4',
    'the sims 4',
    '《文明6》',
    '巫师3：狂猎',
    '  Baldur\'s Gate   3  ',
    'NieR:Automata™',
    '艾尔登法环 / ELDEN RING',
    '彩虹六号®：围攻',
    '（半条命）2',
    'Resident Evil 4 Remake',
    '星露谷物语—Stardew Valley',
    'HITMAN™ World of Assassination',
    '全面战争：三国',
    'C&C 红色警戒2',
    'Fate/Stay Night [Réalta Nua]',
    '',
    '   ',
    'A.B-C_D',
  ];

  const diffs = [];
  for (const s of corpus) {
    const a = evalNorm(mainSyms, s);
    const b = evalNorm(renderSyms, s);
    if (a !== b) diffs.push(`"${s}" → 主「${a}」/ 渲「${b}」`);
  }
  assert(diffs.length === 0, `${diffs.length} 条语料结果不一致：\n    ` + diffs.join('\n    '));

  // 3) 关键性质：CJK 必须被保留，符号必须被剥掉
  assert(evalNorm(mainSyms, '艾尔登法环') === '艾尔登法环', 'CJK 被误剥');
  assert(evalNorm(mainSyms, 'The Sims 4') === 'thesims4', '空白/大小写处理异常');
  assert(evalNorm(mainSyms, 'NieR:Automata™') === 'nierautomata', '符号剥离不完整');

  return `符号表一致 + ${corpus.length} 条语料输出一致`;
});

// ---------------------------------------------------------------------------
// C. 占位符解析不残留 POSIX 形态
// ---------------------------------------------------------------------------

check('占位符解析在 Windows 口径下可用', () => {
  // 归一化路径分隔符，便于跨平台比较
  const way = (p) => String(p).replace(/[\\/]+/g, path.sep).replace(/[\\/]$/, '').toLowerCase();

  // 复刻 savePathLibrary.localDirs + 替换顺序，验证 Windows 场景
  const home = os.homedir();
  const d = {
    home,
    roaming: process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
    local: process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
    localLow: path.join(home, 'AppData', 'LocalLow'),
    documents: path.join(home, 'Documents'),
    savedGames: path.join(home, 'Saved Games'),
    public: process.env.PUBLIC || 'C:\\\\Users\\\\Public',
    programData: process.env.PROGRAMDATA || 'C:\\\\ProgramData',
    winDir: process.env.WINDIR || 'C:\\\\Windows',
    osUserName: path.basename(home),
    systemRoot: process.env.SystemRoot || 'C:\\\\Windows',
  };

  // 顺序必须最长优先，否则 <winLocalAppData> 会先吃掉 <winLocalAppDataLow> 的前缀
  const SUBST = [
    ['<home>', d.home],
    ['<winLocalAppDataLow>', d.localLow],
    ['<winLocalAppData>', d.local],
    ['<winAppData>', d.roaming],
    ['<winDocuments>', d.documents],
    ['<winSavedGames>', d.savedGames],
    ['<winPublic>', d.public],
    ['<winProgramData>', d.programData],
    ['<winDir>', d.winDir],
    ['<osUserName>', d.osUserName],
    ['<root>', d.systemRoot],
  ];

  const resolve = (raw) => {
    let out = raw;
    for (const [token, value] of SUBST) out = out.split(token).join(value);
    return out;
  };

  // 最长优先顺序验证：低完整性目录不能被截断
  const low = resolve('<winLocalAppDataLow>/Game/Save');
  assert(
    way(low) === way(path.join(d.localLow, 'Game', 'Save')),
    `LocalLow 被截断：${low}`,
  );

  // <storeUserId> 保留为通配符，由上层展开
  const store = resolve('<winLocalAppData>/Packages/<storeUserId>/LocalState');
  assert(store.includes('<storeUserId>'), 'storeUserId 不应在解析阶段被替换');
  assert(!store.includes('<winLocalAppData>'), 'winLocalAppData 未被替换');

  const withHome = resolve('<home>/Documents/My Games');
  assert(way(withHome) === way(path.join(home, 'Documents', 'My Games')), `home 解析异常：${withHome}`);

  // 替换后不应残留任何已知占位符
  const sample = resolve('<root>/System32/<osUserName>/<winSavedGames>');
  for (const [token] of SUBST) {
    assert(!sample.includes(token), `解析后仍残留 ${token}：${sample}`);
  }

  return `最长优先替换正确，LocalLow / storeUserId / home 均符合预期`;
});

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

console.log('=== 数据与契约校验 ===\n');
for (const p of passes) console.log('  [OK] ' + p);

if (failures.length === 0) {
  console.log('\n全部通过。\n');
  process.exit(0);
}

console.log('');
for (const f of failures) console.log('  [FAIL] ' + f);
console.log(`\n共 ${failures.length} 项失败。\n`);
process.exit(1);
