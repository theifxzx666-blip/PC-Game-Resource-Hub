import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const PLACEHOLDERS: Array<[string, string]> = [
  ['%USERPROFILE%', process.env.USERPROFILE ?? ''],
  ['%LOCALAPPDATA%', process.env.LOCALAPPDATA ?? ''],
  ['%APPDATA%', process.env.APPDATA ?? ''],
  ['%PROGRAMDATA%', process.env.PROGRAMDATA ?? ''],
  ['%TEMP%', process.env.TEMP ?? ''],
  ['%DOCUMENTS%', path.join(process.env.USERPROFILE ?? '', 'Documents')],
]

export function expandPlaceholders(input: string): string {
  let out = input.trim()
  for (const [token, value] of PLACEHOLDERS) {
    out = out.split(token).join(value)
    out = out.split(token.toLowerCase()).join(value)
  }
  return out
}

export function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

export function nowText(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export function isSubPath(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function safeJoin(root: string, relative: string): string {
  const cleaned = relative.replace(/\\/g, '/').replace(/^\/+/, '')
  if (cleaned.split('/').some((seg) => seg === '..')) {
    throw new Error(`拒绝越界路径：${relative}`)
  }
  const target = path.join(root, cleaned)
  if (!isSubPath(root, target)) throw new Error(`拒绝越界路径：${relative}`)
  return target
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

export function copyDir(src: string, dest: string): void {
  ensureDir(dest)
  fs.cpSync(src, dest, { recursive: true, force: true })
}

export function dirSize(dir: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        files += 1
        try {
          bytes += fs.statSync(full).size
        } catch {
          /* 忽略无法读取的文件 */
        }
      }
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return { bytes, files }
}

export function listFilesRecursive(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function removeEmptyDirs(root: string, dir: string): void {
  let current = dir
  while (isSubPath(root, current) && path.resolve(current) !== path.resolve(root)) {
    try {
      if (fs.readdirSync(current).length > 0) return
      fs.rmdirSync(current)
    } catch {
      return
    }
    current = path.dirname(current)
  }
}
