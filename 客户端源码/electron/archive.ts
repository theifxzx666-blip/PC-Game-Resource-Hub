import fs from 'node:fs'
import path from 'node:path'
import { run } from './exec.js'

const SYSTEM_7ZIP = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
]

let cachedTool: string | null = null
let cachedRarSupport: boolean | null = null

/** 依次尝试：用户配置 → 随包 7za → 系统 7-Zip。返回可执行文件绝对路径，找不到返回 null。 */
export function resolveExtractor(bundledDir: string, configured = ''): string | null {
  if (cachedTool && fs.existsSync(cachedTool)) return cachedTool
  const candidates = [
    configured,
    path.join(bundledDir, '7za.exe'),
    path.join(bundledDir, '7z.exe'),
    ...SYSTEM_7ZIP,
  ].filter((item): item is string => Boolean(item))
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        cachedTool = candidate
        return candidate
      }
    } catch {
      /* 忽略不可访问的候选路径 */
    }
  }
  return null
}

export function requireExtractor(bundledDir: string, configured = ''): string {
  const tool = resolveExtractor(bundledDir, configured)
  if (!tool) throw new Error('未找到可用的解压工具（7za.exe / 7-Zip）。请在「设置」中指定解压工具路径。')
  return tool
}

/** 通过 `7z i` 的真实输出判断当前工具是否支持 rar，避免猜测。 */
export async function supportsRar(tool: string): Promise<boolean> {
  if (cachedRarSupport !== null) return cachedRarSupport
  try {
    const { stdout } = await run(tool, ['i'])
    cachedRarSupport = /\brar\b/i.test(stdout) && /Rar/i.test(stdout)
  } catch {
    cachedRarSupport = false
  }
  return cachedRarSupport
}

async function listEntries(tool: string, archive: string): Promise<string[]> {
  const { code, stdout, stderr } = await run(tool, ['l', '-slt', '-ba', archive])
  if (code !== 0) throw new Error(`读取压缩包失败：${(stderr || stdout).trim().slice(0, 300)}`)
  const archiveResolved = path.resolve(archive)
  const paths: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('Path = ')) continue
    const value = line.slice('Path = '.length).trim()
    if (!value) continue
    if (path.resolve(value) === archiveResolved) continue
    paths.push(value)
  }
  return paths
}

function assertSafeEntries(entries: string[]): void {
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/')
    if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/')) {
      throw new Error(`压缩包内含绝对路径条目，已拒绝解压：${entry}`)
    }
    if (normalized.split('/').some((seg) => seg === '..')) {
      throw new Error(`压缩包内含越界条目，已拒绝解压：${entry}`)
    }
  }
}

export interface ExtractResult {
  entries: number
  dest: string
}

export async function extractArchive(tool: string, archive: string, dest: string): Promise<ExtractResult> {
  const ext = path.extname(archive).toLowerCase()
  if (ext === '.rar' && !(await supportsRar(tool))) {
    throw new Error('当前解压工具（7za）不支持 rar。请安装 7-Zip 并在「设置」中指定其 7z.exe 路径。')
  }
  const entries = await listEntries(tool, archive)
  assertSafeEntries(entries)
  fs.mkdirSync(dest, { recursive: true })
  const { code, stdout, stderr } = await run(tool, ['x', '-y', '-bd', `-o${dest}`, archive])
  if (code !== 0) throw new Error(`解压失败：${(stderr || stdout).trim().slice(0, 300)}`)
  return { entries: entries.length, dest }
}

export async function createZip(tool: string, outFile: string, srcDir: string): Promise<void> {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  if (fs.existsSync(outFile)) fs.rmSync(outFile, { force: true })
  const { code, stdout, stderr } = await run(tool, ['a', '-tzip', '-y', '-bd', outFile, '.'], srcDir)
  if (code !== 0) throw new Error(`打包失败：${(stderr || stdout).trim().slice(0, 300)}`)
}
