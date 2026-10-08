// 日期归一化与网盘链接抽取。
//
// 两段逻辑都来自参考项目 game-aggregator 的 shared.js，
// 各自解决一个已实测的缺陷（见函数注释），移植为 TypeScript 并保留原判据。

/**
 * 日期归一化 —— 全站唯一出口。
 *
 * 为什么必须有这一层：不同源站的日期格式不同（`2026-09-14` / `2026/9/9`），
 * 且源站文本里「日期」后面常常紧跟着别的数字，而 `\d{1,2}` 是**贪婪**的，
 * 会把紧跟的数字一并吞掉：
 *
 *     源站真值 `2026/9/8`  →  旧正则抓成 `2026/9/89`   （多吞一个 9）
 *     源站真值 `2025/3/4`  →  旧正则抓成 `2025/3/48`   （多吞一个 8）
 *
 * 后果不只是显示难看：`new Date('2026/9/89T00:00:00Z')` 是 Invalid Date，
 * 兜底算出的时间戳变成 NaN → 该条在「最新更新」里被当成 0 排到最后，
 * 或与日期标签互相矛盾地排在一起。
 *
 * 职责：解析（两种分隔符）→ 校验月/日范围 → 还原被吞的「日」→ 输出 ISO。
 * 返回 null 表示无法得到合法日期，由调用方自行兜底。
 *
 * ⚠️ 取舍：`日 > 31` 时取**首位数字**（`89` → `8`）而非直接丢弃。
 */
export function normDate(input: string | null | undefined): string | null {
  const m = String(input == null ? '' : input).match(/(\d{4})[/-](\d{1,2})[/-](\d{1,3})/)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  let day = Number(m[3])
  if (month < 1 || month > 12) return null
  if (day > 31) day = Number(String(m[3])[0]) // 被后续数字污染的还原
  if (!(day >= 1 && day <= 31)) return null
  const dt = new Date(Date.UTC(year, month - 1, day))
  // 剔除 2/30 这类不存在的日子（Date 会顺延，反查即可发现）
  if (dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${year}-${pad(month)}-${pad(day)}`
}

/** 归一化日期 → 当日 00:00 UTC 毫秒（排序用）。无法解析返回 0。 */
export function dateTs(input: string | null | undefined): number {
  const normalized = normDate(input)
  if (!normalized) return 0
  const t = Date.parse(`${normalized}T00:00:00Z`)
  return Number.isFinite(t) ? t : 0
}

/** 相对时间文案：刚刚 / N 分钟前 / N 小时前 / M月D日。 */
export function ts2label(tsMs: number, now: number = Date.now()): string | null {
  if (!tsMs) return null
  const diff = now - tsMs
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(tsMs)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

// ---------------------------------------------------------------------------
// 网盘链接抽取
// ---------------------------------------------------------------------------

/** 网盘域名 → 平台名。顺序无关，取首个命中。 */
export const NETDISK: ReadonlyArray<readonly [RegExp, string]> = [
  [/pan\.quark\.cn/i, '夸克网盘'],
  [/pan\.baidu\.com/i, '百度网盘'],
  [/pan\.xunlei\.com/i, '迅雷网盘'],
  [/cloud\.189\.cn/i, '天翼云盘'],
  [/caiyun\.139\.com|yun\.139\.com/i, '移动云盘'],
  [/www\.aliyundrive\.com|alipan\.com/i, '阿里云盘'],
  [/123pan\.com/i, '123 网盘'],
  [/lanzou[a-z]?\.com/i, '蓝奏云'],
  [/mypikpak\.com/i, 'PikPak'],
  [/drive\.uc\.cn/i, 'UC 网盘'],
]

/**
 * 站内链接**不是下载**：正文里常夹帮助中心、另一篇帖子的链接，
 * 实测它们会混进下载清单，让「6 个盘口」变成「7 条里有一条是废话」。
 * 默认只认站外链接。
 *
 * 注：本项目的资源站与应用站点与参考项目不同，这里仅作为「同站内容页」
 * 的通用排除口径；如需排除自有站点，追加到 INTERNAL_HOST_RE 即可。
 */
export const INTERNAL_HOST_RE = /(^|\.)(jidiyouxi\.com|52jidi\.com|xgamer?\.[a-z]+)$/i

export interface ExtractedLink {
  url: string
  kind: string
}

/**
 * 从一段自由文本里抽网盘链接。
 * @param text 待抽取文本（MOD 说明、资源描述等）
 * @param opts.max 最多返回几条（防正文爆炸），默认 20
 * @param opts.dropInternal 是否丢掉站内链接，默认 true
 */
export function extractLinks(
  text: string | null | undefined,
  opts: { max?: number; dropInternal?: boolean } = {},
): ExtractedLink[] {
  const { max = 20, dropInternal = true } = opts
  const out: ExtractedLink[] = []
  const seen = new Set<string>()
  const re = /https?:\/\/[^\s"'<>）)】\]，,。；;]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(String(text == null ? '' : text)))) {
    const url = m[0].replace(/[.,;。，、]+$/, '')
    if (seen.has(url)) continue
    seen.add(url)
    if (dropInternal) {
      let host = ''
      try {
        host = new URL(url).hostname
      } catch {
        continue
      }
      if (INTERNAL_HOST_RE.test(host)) continue
    }
    const hit = NETDISK.find(([re2]) => re2.test(url))
    out.push({ url, kind: hit ? hit[1] : '其他链接' })
    if (out.length >= max) break
  }
  return out
}
