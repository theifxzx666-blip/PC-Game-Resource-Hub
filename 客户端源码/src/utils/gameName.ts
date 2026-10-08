// 游戏名归一化与别名展开。
//
// 归一化是「跨源匹配」的唯一真源：检索去重、存档路径库兜底匹配、
// 游戏名与目录名比对都必须走这里，避免同一语义出现多份清洗规则
// （参考项目曾因网盘抽取写了两份导致同一输入两个结果）。
//
// 移植自 game-aggregator 的 data/name-normalize.js（MIT 上游数据同源），
// 保留其两条核心护栏：剥符号但保留 CJK、代际数字不匹配则拒绝。

/** 归一化时一律剥掉的符号（含商标号、度数、全角标点）。 */
const SYMBOLS =
  /[™®©°′″·・:：,，.。!！?？'"“”‘’()（）[\]【】<>《》|｜/\\~～\-–—_+*&#@$%^;；＊]/g

/** 游戏名 → 归一化键。保留 CJK，剥掉全部符号与空白。 */
export function normKey(value: string): string {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(SYMBOLS, '')
}

/** 去空白但保留符号：用于展示与「轻度比较」。 */
export function looseKey(value: string): string {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
}

/**
 * 游戏名标题里出现的「代际数字」。
 * 例：《The Sims 4》→ [4]，《文明6》→ [6]，《巫师3：狂猎》→ [3]。
 */
export function genNums(title: string): string[] {
  const text = String(title == null ? '' : title)
  const out = new Set<string>()
  // 阿拉伯数字：1–3 位，避免把年份（4 位）当成代际
  for (const m of text.matchAll(/(?<![a-z0-9])(\d{1,3})(?![0-9])/gi)) out.add(m[1])
  return [...out]
}

/**
 * 代际数字防误配护栏。
 *
 * 查询词带代际数字、而命中条目的标题通篇不含该数字 → 视为误配并拒绝。
 * 实测拦下《The Sims 1》错配到《The Sims 4》、《文明5》错配到《文明6》这类问题。
 *
 * 注意：只在这两个条件同时成立时拒绝 —— 查询带数字 + 目标不含。
 * 目标带数字而查询不带（如「巫师」→《巫师3》）属于合理匹配，放行。
 */
export function numMismatch(query: string, target: string): boolean {
  const q = genNums(query)
  if (q.length === 0) return false
  const t = new Set(genNums(target))
  return q.some((n) => !t.has(n))
}

/** 别名表：键为玩家俗称/缩写，值为规范名。 */
export type AliasTable = Record<string, string>

/**
 * 用别名表把查询词展开成候选列表（原词在前，规范名在后，已去重）。
 * 例：'法环' → ['法环', '艾尔登法环']。
 */
export function expandAlias(query: string, table: AliasTable): string[] {
  const keys = [query, ...(table[query] ? [table[query]] : [])]
  const out: string[] = []
  for (const k of keys) {
    if (k && !out.includes(k)) out.push(k)
  }
  // 归一化键也尝试命中一次
  const normalized = normKey(query)
  for (const [alias, full] of Object.entries(table)) {
    if (normKey(alias) === normalized && !out.includes(full)) out.push(full)
  }
  return out
}

/**
 * 判断一条候选条目是否与查询匹配，附带代际护栏。
 * @returns 'exact' | 'contains' | 'alias' | null
 */
export function matchQuality(
  query: string,
  candidate: { title: string; aliases?: string[] },
  table: AliasTable = {},
): 'exact' | 'contains' | 'alias' | null {
  const q = normKey(query)
  if (q.length < 2) return null

  const candidates = [candidate.title, ...(candidate.aliases ?? [])]
  for (const raw of candidates) {
    if (!raw) continue
    // title 是「中文/英文/别名」拼接串，按 / 切段后逐段比较
    for (const seg of String(raw).split('/')) {
      const key = normKey(seg)
      if (!key) continue
      if (key === q) {
        if (numMismatch(query, seg)) continue
        return 'exact'
      }
      if (key.includes(q) || (q.length >= 4 && q.includes(key))) {
        if (numMismatch(query, seg)) continue
        return 'contains'
      }
    }
  }

  const expanded = expandAlias(query, table).map(normKey)
  if (expanded.length > 1) {
    for (const raw of candidates) {
      for (const seg of String(raw ?? '').split('/')) {
        const key = normKey(seg)
        if (key && expanded.slice(1).includes(key)) {
          if (numMismatch(query, seg)) continue
          return 'alias'
        }
      }
    }
  }
  return null
}
