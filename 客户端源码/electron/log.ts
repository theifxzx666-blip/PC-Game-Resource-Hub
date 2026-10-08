import { store } from './store.js'
import { nowText, uid } from './util.js'
import type { LogEntry } from './types.js'

type LogSink = (entry: LogEntry) => void

let sink: LogSink | null = null

export function setLogSink(fn: LogSink | null): void {
  sink = fn
}

export function appendLog(
  action: string,
  target: string,
  status: LogEntry['status'] = '成功',
  detail = '',
): LogEntry {
  const entry: LogEntry = { id: uid('log'), action, target, time: nowText(), status, detail }
  const list = store.logs()
  list.unshift(entry)
  store.saveLogs(list.slice(0, 500))
  sink?.(entry)
  return entry
}
