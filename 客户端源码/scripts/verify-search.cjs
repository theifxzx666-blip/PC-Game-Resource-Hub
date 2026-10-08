/**
 * 资源中心检索链路回归测试（npm run verify:search）
 *
 * 为什么要有这个脚本：
 *   0.7.0 发布后用户报「资源中心搜星露谷物语没有任何结果」。
 *   根因不是数据缺失（知识库里明明有 348 条星露谷 MOD），而是**检索链路的
 *   控制流写错了**：内置知识库只在「在线源一条都没拉到」时才兜底，一旦
 *   配了预置源（GameBanana / GitHub），GitHub 会返回一堆「星露谷物语复刻版」
 *   「MOD 安装器」之类的**无关项目**，pool 非空 → 知识库永远不被查询 →
 *   过滤后 0 条。
 *
 *   这类「代码改一行、行为全变」的链路必须有回归测试，否则下次重构又会踩。
 *
 * 策略：**直接加载编译产物 dist-electron/**，不重新实现一遍逻辑。
 *   复刻一份逻辑来测等于测了个假的 —— 那份副本永远是对的。
 *   前置条件：先跑 `npm run build`（或至少 tsc -p tsconfig.electron.json）。
 *
 *   编译产物是 ESM 且 `import { app } from 'electron'`，测试环境没有 Electron
 *   运行时；因此必须通过 scripts/electron-loader.mjs 这个 ESM 加载钩子把
 *   `electron` 解析成本地桩模块。脚本自身用 `node --import` 启动，或由
 *   npm script 传入 --import（见 package.json 的 verify:search）。
 *
 * 覆盖：
 *   1. 中文正式名搜索能拿到知识库结果（修复前为 0）
 *   2. 英文名 / 俗称 经别名表展开后同样能命中
 *   3. 真正的「该游戏的资源」排在「关于该游戏的项目」前面
 *   4. 不存在的游戏返回 0 条
 *   5. 无关键词时不铺全库（性能与体验）
 *
 * 退出码 0 = 全部通过；1 = 有失败项。
 */
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist-electron');

if (!fs.existsSync(path.join(dist, 'onlineSearch.js'))) {
  console.error(`[verify-search] 未找到编译产物：${path.join(dist, 'onlineSearch.js')}`);
  console.error('[verify-search] 请先执行 npm run build（或 npx tsc -p tsconfig.electron.json）。');
  process.exit(1);
}

const failures = [];
const passes = [];

/**
 * 注册一个检查项。fn 可以是同步或 async 函数。
 *
 * ★ 必须 await：检索链路的检查项都是 `async`（searchOnline 是异步的）。
 *   早先写成同步 try/catch 时，返回的 Promise 被直接 push 进 passes，
 *   既丢掉了 detail（打印成 [object Promise]），也让「断言失败」变成
 *   unhandled rejection —— 测试永远是绿的。这是最危险的一类假通过。
 */
async function check(name, fn) {
  try {
    const detail = await fn();
    passes.push(`${name}${detail ? ' — ' + detail : ''}`);
  } catch (e) {
    failures.push(`${name} — ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 让桩模块的 getAppPath() 能指到仓库根（electron-shim.mjs 读这个环境变量）。
process.env.VERIFY_SEARCH_ROOT = root;
process.chdir(root);

const DATA = path.join(root, 'resources', 'data');

async function main() {
  const { searchOnline } = await import(pathToFileURL(path.join(dist, 'onlineSearch.js')).href);
  const { expandAlias, normKey } = await import(pathToFileURL(path.join(dist, 'util.js')).href);
  const { trainersAvailable, trainersForGame, trainersInfo } = await import(
    pathToFileURL(path.join(dist, 'trainerLibrary.js')).href
  );

  // 别名表数据文件也要在
  assert(
    fs.existsSync(path.join(DATA, 'name-aliases.json')),
    `缺少数据文件 name-aliases.json`,
  );

  // -------------------------------------------------------------------------
  // 0. 前置：知识库确实载入
  // -------------------------------------------------------------------------
  await check('内置知识库已载入', () => {
    assert(trainersAvailable(), 'trainers.json 未载入（检查 resources/data 路径）');
    const info = trainersInfo();
    assert(info.total >= 8000, `知识库条数异常偏少：${info.total}`);
    return `${info.total} 条`;
  });

  // -------------------------------------------------------------------------
  // 1. 中文正式名：能拿到知识库结果（修复前的死症状）
  // -------------------------------------------------------------------------
  await check('搜「星露谷物语」返回大量知识库结果', async () => {
    const result = await searchOnline({ keyword: '星露谷物语', page: 1, pageSize: 48 }, { force: true });
    assert(result.total > 100, `结果只有 ${result.total} 条（修复前为 0，期望 > 100）`);

    const libItems = result.items.filter((item) => item.sourceIds.includes('trainer-lib'));
    assert(libItems.length > 0, '首屏 48 条里没有任何知识库条目');

    const libStatus = result.statuses.find((s) => s.id === 'trainer-lib');
    assert(libStatus && libStatus.ok, '缺少「修改器知识库」数据源状态（界面无法展示来源）');
    assert(libStatus.count > 100, `知识库命中数上报异常：${libStatus.count}`);

    return `共 ${result.total} 条，首屏知识库 ${libItems.length} 条，知识库上报命中 ${libStatus.count} 条`;
  });

  // -------------------------------------------------------------------------
  // 2. 真正的「该游戏的资源」排在「关于该游戏的项目」前面
  // -------------------------------------------------------------------------
  await check('游戏本体资源排在「关于该游戏的项目」之前', async () => {
    const result = await searchOnline({ keyword: '星露谷物语', page: 1, pageSize: 12 }, { force: true });
    const top = result.items.slice(0, 6);
    assert(top.length >= 6, `首屏不足 6 条：${top.length}`);

    // 前 6 条必须是「游戏名就是星露谷物语」的知识库条目。
    // 若排序退化，title 含「星露谷物语」但 gameName 无关的在线项目会挤上来。
    const allGameExact = top.every(
      (item) => normKey(item.gameName) === normKey('星露谷物语'),
    );
    assert(
      allGameExact,
      `前 6 条游戏名不全是「星露谷物语」，排序退化。实际前 6 条：` +
        JSON.stringify(top.map((i) => `${i.title}(${i.gameName || '无'})`), null, 0),
    );
    return `前 6 条游戏名全部精确匹配`;
  });

  // -------------------------------------------------------------------------
  // 3. 英文名 / 俗称：经别名表展开后能命中
  // -------------------------------------------------------------------------
  await   await check('别名展开：英文名 / 俗称 → 中文正式名', () => {
    const cases = [
      // 英文名（schema 2 从 save-paths / trainers 双语标题扩充而来）
      ['Stardew Valley', '星露谷物语'],
      ['Terraria', '泰拉瑞亚'],
      ['Cyberpunk 2077', '赛博朋克2077'],
      // 玩家俗称（参考项目人工维护的 aliases.json）
      ['大表哥2', '荒野大镖客2'],
      ['泰拉', '泰拉瑞亚'],
      ['MC', '我的世界'],
      ['老头环', '艾尔登法环'],
    ];
    const results = [];
    for (const [alias, official] of cases) {
      const expanded = expandAlias(alias);
      assert(
        expanded.includes(official),
        `「${alias}」展开为 ${JSON.stringify(expanded)}，未包含「${official}」`,
      );
      results.push(`${alias}→${official}`);
    }
    return results.join('、');
  });

  await check('搜英文名「Stardew Valley」能命中知识库星露谷条目', async () => {
    const result = await searchOnline({ keyword: 'Stardew Valley', page: 1, pageSize: 12 }, { force: true });
    const hits = result.items.filter((item) => normKey(item.gameName) === normKey('星露谷物语'));
    assert(hits.length > 0, `未命中任何星露谷条目（共 ${result.total} 条），别名展开未生效`);
    return `命中 ${hits.length} 条星露谷条目`;
  });

  // -------------------------------------------------------------------------
  // 4. 不存在的游戏：0 条，不拿无关结果凑数
  // -------------------------------------------------------------------------
  await check('搜不存在的游戏返回 0 条', async () => {
    const result = await searchOnline({ keyword: '这个游戏绝对不存在zzzqqq', page: 1, pageSize: 12 }, { force: true });
    // 允许离线演示目录那 5 条兜底（它们不带关键词过滤语义），但不应有知识库条目
    const libItems = result.items.filter((item) => item.sourceIds.includes('trainer-lib'));
    assert(libItems.length === 0, `不存在的关键词命中了 ${libItems.length} 条知识库条目`);
    return `共 ${result.total} 条（无知识库误命中）`;
  });

  // -------------------------------------------------------------------------
  // 5. 无关键词：不铺全库
  // -------------------------------------------------------------------------
  await check('无关键词时不铺出全部知识库', async () => {
    const result = await searchOnline({ page: 1, pageSize: 12 }, { force: true });
    const libItems = result.items.filter((item) => item.sourceIds.includes('trainer-lib'));
    assert(
      libItems.length <= 400,
      `无关键词时知识库条目过多：${libItems.length}（预期 <= 400）`,
    );
    return `知识库取 ${libItems.length} 条（<= 400）`;
  });

  // -------------------------------------------------------------------------
  // 6. 多游戏泛化：确认不是只对星露谷打了补丁
  // -------------------------------------------------------------------------
  await check('泛化：其他游戏同样可搜', async () => {
    const cases = ['泰拉瑞亚', '恐怖黎明', '我的世界'];
    const report = [];
    for (const name of cases) {
      const direct = trainersForGame(name);
      const result = await searchOnline({ keyword: name, page: 1, pageSize: 12 }, { force: true });
      assert(
        result.total > 0,
        `「${name}」检索 0 条（索引里本有 ${direct.length} 条）`,
      );
      report.push(`${name}:${result.total}`);
    }
    return report.join('、');
  });

  // -------------------------------------------------------------------------
  // 7. 大条目数游戏不被截断
  //
  //    实测条目数 Top5：赛博朋克2077(719)、上古卷轴5(557)、
  //    GTA5(536)、模拟人生4(394)、星露谷物语(348)。
  //    早先 limit=300 并把 slice 写在 Map 之前，会把这些游戏砍掉一半以上，
  //    且被砍的是「文件顺序靠后」的条目而非「低相关」的，属静默数据丢失。
  // -------------------------------------------------------------------------
  await check('大条目数游戏：整款游戏的条目都进结果池', async () => {
    const cases = [
      ['赛博朋克2077', 719],
      ['上古卷轴5', 500],
      ['模拟人生4', 394],
      ['星露谷物语', 348],
    ];
    const report = [];
    for (const [name, minExpected] of cases) {
      const result = await searchOnline({ keyword: name, page: 1, pageSize: 12 }, { force: true });
      const status = result.statuses.find((s) => s.id === 'trainer-lib');
      assert(status, `「${name}」没有上报知识库来源状态`);
      assert(
        status.count >= minExpected,
        `「${name}」知识库只命中 ${status.count} 条，期望 >= ${minExpected}（疑似被截断）`,
      );
      report.push(`${name}:${status.count}`);
    }
    return report.join('、');
  });

  // -------------------------------------------------------------------------
  // 汇总
  // -------------------------------------------------------------------------
  console.log('');
  for (const line of passes) console.log(`  [OK]   ${line}`);
  for (const line of failures) console.log(`  [FAIL] ${line}`);
  console.log('');
  console.log(`verify-search: ${passes.length} 通过 / ${failures.length} 失败`);

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[verify-search] 执行异常：', e);
  process.exit(1);
});
