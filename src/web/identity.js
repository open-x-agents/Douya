// Resolve the user's display name from connected Composio sources only.
// Order: GitHub profile name → GitHub login. Gmail only exposes an email address, which we
// do not treat as a human display name. Never read .odm-data/profile.json for greetings.

import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { resolveDisplayName, setLastGithubIdentity } from './aggregation.js'

export function identityPath(home = '.odm-data') {
  return join(home, 'identity.json')
}

export async function loadCachedIdentity(home = '.odm-data') {
  const path = identityPath(home)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    return { login: raw.login || '', name: raw.name || '', source: raw.source || '', at: raw.at || '' }
  } catch { return null }
}

export async function saveCachedIdentity(home, identity) {
  if (!identity?.login && !identity?.name) return
  const path = identityPath(home)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({
    login: identity.login || '',
    name: identity.name || '',
    source: identity.source || 'github',
    at: new Date().toISOString(),
  }, null, 2), 'utf8')
}

/**
 * Probe connected toolkits for a display name.
 * Prefers GitHub's human `name` over `login`. Updates aggregation.lastGithubIdentity.
 */
export async function fetchIdentityFromSources(composioClient, { home = '.odm-data', log = () => {} } = {}) {
  if (!composioClient) return loadCachedIdentity(home)
  try {
    const r = await composioClient.executeAction('GITHUB_GET_THE_AUTHENTICATED_USER', {})
    const d = r?.data?.data || r?.data
    if (d?.login || d?.name) {
      const identity = { login: d.login || '', name: d.name || '', source: 'github' }
      setLastGithubIdentity({ login: identity.login, name: identity.name })
      await saveCachedIdentity(home, identity)
      log(`[Identity] from github: ${resolveDisplayName('', identity) || '(empty)'}`)
      return identity
    }
  } catch (e) { log(`[Identity] github failed: ${e.message}`) }
  return loadCachedIdentity(home)
}

export function displayNameOf(identity) {
  return resolveDisplayName('', identity)
}
