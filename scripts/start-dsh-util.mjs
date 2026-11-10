// Cross-platform bits used by scripts/start-dsh.mjs (Windows has no `ln`, uses
// Path/PATH, and os.tmpdir() instead of /tmp). Keep this import-safe for tests.
import { existsSync, mkdirSync, symlinkSync, cpSync } from 'node:fs'
import { dirname, join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'

export function userHome(env = process.env) {
  return env.HOME || env.USERPROFILE || ''
}

export function dshLogPath(env = process.env) {
  return env.ODM_DSH_LOG || join(tmpdir(), 'odm-dsh.log')
}

/** De-duplicate PATH entries, using the platform delimiter unless `sep` is set. */
export function mergePathEnv(current, extras = [], sep = delimiter) {
  const out = []
  for (const part of [...String(current || '').split(sep), ...extras.flatMap((p) => String(p || '').split(sep))]) {
    if (part && !out.includes(part)) out.push(part)
  }
  return out.join(sep)
}

/** Windows env is case-insensitive; keep a single PATH so we do not double the value. */
export function uniquePathEnv(env, pathValue, platform = process.platform) {
  const out = { ...env }
  if (platform === 'win32') {
    for (const k of Object.keys(out)) {
      if (k !== 'PATH' && k.toUpperCase() === 'PATH') delete out[k]
    }
  }
  out.PATH = pathValue
  return out
}

/**
 * Link a directory (junction on Windows, symlink elsewhere). Fall back to a
 * recursive copy if the link is refused (no privilege, or a cross-drive path).
 */
export function linkDir(target, dest, {
  platform = process.platform,
  exists = existsSync,
  mkdir = (p) => mkdirSync(p, { recursive: true }),
  symlink = symlinkSync,
  copy = (s, d) => cpSync(s, d, { recursive: true }),
} = {}) {
  if (!target || !dest) return 'skip'
  if (!exists(target)) return 'skip'
  if (exists(dest)) return 'exists'
  mkdir(dirname(dest))
  try {
    symlink(target, dest, platform === 'win32' ? 'junction' : 'dir')
    return 'link'
  } catch {
    copy(target, dest)
    return 'copy'
  }
}
