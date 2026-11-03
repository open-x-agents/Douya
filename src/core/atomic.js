// Atomic writes, append-only line appends, and the one lock every writer takes.
//
// Two files fight over the same bytes (events.json is rewritten, ledger.jsonl only grows),
// so every write path is: in-process serialization -> cross-process lock file -> write.
// A crash can leave a stale lock or a stray *.tmp; the next writer breaks the lock after
// `staleMs` and the temporary file never replaces the real one. Nothing here knows what an
// event is — this module only moves bytes safely.

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const LOCK_FILE = 'store.lock'
const RETRY_MS = 25

export class LockTimeoutError extends Error {
  constructor(dir, timeoutMs) {
    super(`E_LOCK_TIMEOUT: could not take ${path.join(dir, LOCK_FILE)} within ${timeoutMs}ms`)
    this.name = 'LockTimeoutError'
    this.code = 'E_LOCK_TIMEOUT'
    this.dir = dir
    this.timeoutMs = timeoutMs
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The whole file, or null when it is not there yet. A missing file is a first run, not an
// error; anything else (permissions, I/O) is thrown so nobody mistakes it for empty data.
export async function readTextOrNull(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// Write to <path>.<uuid>.tmp, then rename over the target: a reader sees the old file or the
// new one, never half of either, and the directory keeps no *.tmp once the save returns.
export async function atomicWriteJson(file, value) {
  const target = path.resolve(file)
  const temp = `${target}.${randomUUID()}.tmp`
  const text = `${JSON.stringify(value, null, 2)}\n`
  await fs.mkdir(path.dirname(target), { recursive: true })
  let handle = null
  try {
    handle = await fs.open(temp, 'w')
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temp, target)
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await fs.unlink(temp).catch(() => {})
    throw error
  }
}

// Append one JSON object per line in a single write + fsync, so a crash loses the last line
// at worst and never tears the lines already on disk.
export async function appendJsonLines(file, lines) {
  const list = Array.isArray(lines) ? lines : [lines]
  if (list.length === 0) return 0
  const target = path.resolve(file)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const text = list.map((line) => `${JSON.stringify(line)}\n`).join('')
  const handle = await fs.open(target, 'a')
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  return list.length
}

// In-process queue per directory: two writers in this process never interleave, because the
// first one's promise is the second one's turn. The queue entry always settles to undefined
// so one failed task does not strand the writers behind it.
const chains = new Map()

function runSerial(key, task) {
  const previous = chains.get(key) ?? Promise.resolve()
  const result = previous.then(() => task(), () => task())
  const tail = result.then(() => undefined, () => undefined)
  chains.set(key, tail)
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key)
  })
  return result
}

// A lock older than staleMs belongs to a writer that died; move it aside (rename is atomic,
// so exactly one breaker wins) and let the next attempt take the lock. A fresh lock is never
// touched: waiting past timeoutMs throws instead of stealing someone's turn.
async function breakStaleLock(lockPath, { now, staleMs, nonce }) {
  let stat
  try {
    stat = await fs.stat(lockPath)
  } catch (error) {
    if (error.code === 'ENOENT') return true
    throw error
  }
  let recorded = Number.NaN
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, 'utf8'))
    recorded = Date.parse(parsed.at)
  } catch {
    // unreadable lock: its mtime is the only age we have
  }
  const age = now() - Math.max(stat.mtimeMs, Number.isFinite(recorded) ? recorded : Number.NEGATIVE_INFINITY)
  if (age <= staleMs) return false
  const stalePath = `${lockPath}.${nonce}.stale`
  try {
    await fs.rename(lockPath, stalePath)
  } catch (error) {
    if (error.code === 'ENOENT') return true
    throw error
  }
  await fs.unlink(stalePath).catch(() => {})
  return true
}

async function holdLock(root, task, { timeoutMs, staleMs, now, wait }) {
  await fs.mkdir(root, { recursive: true })
  const lockPath = path.join(root, LOCK_FILE)
  const nonce = randomUUID()
  const deadline = now() + timeoutMs
  let handle = null
  for (;;) {
    try {
      handle = await fs.open(lockPath, 'wx')
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (await breakStaleLock(lockPath, { now, staleMs, nonce })) continue
      if (now() >= deadline) throw new LockTimeoutError(root, timeoutMs)
      await wait(RETRY_MS)
      continue
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString(), nonce }))
    } catch (error) {
      await handle.close().catch(() => {})
      await fs.unlink(lockPath).catch(() => {})
      throw error
    }
    break
  }
  try {
    return await task()
  } finally {
    await handle.close().catch(() => {})
    await fs.unlink(lockPath).catch(() => {})
  }
}

// Serialize in this process, then take <dir>/store.lock across processes, then run the task.
// The lock is released whether the task resolves or throws.
export async function withDataLock(dir, task, options = {}) {
  const { timeoutMs = 10000, staleMs = 30000, now = Date.now, sleep = defaultSleep } = options
  const root = path.resolve(dir)
  return runSerial(root, () => holdLock(root, task, { timeoutMs, staleMs, now, wait: sleep }))
}
