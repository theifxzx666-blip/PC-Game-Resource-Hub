/**
 * Adapted from mayflyMods/src/adapters/utils.ts.
 * Copyright (c) 2026 aojiangfuyou. MIT License.
 * See THIRD_PARTY_NOTICES.md for the complete attribution.
 */
export function pathParts(filePath: string) {
  return filePath.replace(/\\/g, '/').split('/').filter(Boolean)
}

export function baseName(filePath: string) {
  return pathParts(filePath).pop() ?? filePath
}

export function extension(filePath: string) {
  const name = baseName(filePath).toLowerCase()
  const index = name.lastIndexOf('.')
  return index === -1 ? '' : name.slice(index + 1)
}

export function hasFile(files: string[], fileName: string) {
  return files.some((file) => baseName(file).toLowerCase() === fileName.toLowerCase())
}
