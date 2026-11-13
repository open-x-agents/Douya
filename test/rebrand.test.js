import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { t } from '../src/i18n/index.js'
import { PANEL_ROUTE, PANEL_PAGE_ROUTE } from '../src/host/constants.js'
import { ODM_PROFILE_BUNDLES } from '../scripts/start-dsh-util.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

test('public name is Douya / 豆芽; internal ids that would break upgrades stay', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.name, 'douya')
  assert.match(pkg.description, /desktop personal assistant/i)
  assert.equal(pkg.homepage, 'https://open-x-agents.github.io/Douya/')
  assert.equal(pkg.repository.url, 'git+https://github.com/open-x-agents/Douya.git')

  assert.equal(t('app.title', 'en'), 'Douya')
  assert.equal(t('app.title', 'zh'), '豆芽')
  assert.match(t('dock.head_sub', 'en'), /desktop personal assistant/i)
  assert.match(t('dock.head_sub', 'zh'), /桌面版个人助手/)

  assert.match(read('index.js'), /export const name = 'opendigitalmate'/)
  assert.equal(PANEL_ROUTE, '/api/opendigitalmate')
  assert.equal(PANEL_PAGE_ROUTE, '/api/opendigitalmate/page')
  assert.ok(ODM_PROFILE_BUNDLES.includes('opendigitalmate'))
  assert.ok(ODM_PROFILE_BUNDLES.includes('dsh-muse-ui'))
  assert.match(read('cordis.patch.yml'), /id: opendigitalmate/)
  assert.match(read('src/i18n/index.js'), /const LS_KEY = 'odm\.lang'/)

  const readme = read('README.md')
  assert.match(readme, /^# Douya/m)
  assert.doesNotMatch(readme, /openDigitalMate|Open Digital Mate|open-x-agents\/openDigitalMate/)
  assert.match(readme, /desktop personal assistant/i)
  assert.match(readme, /desktop-v0\.1\.0/)

  const site = read('site/index.html')
  assert.match(site, /desktop personal assistant/i)
  assert.match(site, /桌面版个人助手/)
  assert.doesNotMatch(site, /openDigitalMate|Open Digital Mate/)

  // Hero "Download Douya / 下载豆芽" jumps to the on-page section, not GitHub.
  assert.match(site, /<section id="download">/)
  assert.match(site, /class="btn primary" href="#download"/)
  assert.doesNotMatch(site, /class="btn primary" href="https:\/\/github\.com\//)
})
