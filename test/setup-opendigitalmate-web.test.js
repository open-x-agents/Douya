import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const scriptSrc = join(repoRoot, 'scripts', 'setup-opendigitalmate-web.sh')
const realNode = process.execPath

function shSingle(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

async function writeExec(file, body) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, body)
  await chmod(file, 0o755)
}

const pnpmStub = `#!/bin/sh
set -eu
if [ "\${1:-}" != "install" ]; then
  echo "stub pnpm: $*" >&2
  exit 1
fi
exec ${shSingle(realNode)} --input-type=module -e '
import { readFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
mkdirSync("node_modules", { recursive: true });
for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
  if (typeof spec !== "string" || !spec.startsWith("link:")) {
    console.error("not a link: " + name + " " + spec);
    process.exit(1);
  }
  const dest = "node_modules/" + name;
  rmSync(dest, { recursive: true, force: true });
  symlinkSync(spec.slice(5), dest);
}
'
`

function nodeShim() {
  return `#!/bin/sh
set -e
for arg in "$@"; do
  case "$arg" in
    *process.versions.node*) exit 0 ;;
  esac
done
exec ${shSingle(realNode)} "$@"
`
}

function npmShim(npmLog) {
  return `#!/bin/sh
set -e
printf '%s\\n' "$*" >> ${shSingle(npmLog)}
case "$*" in
  "install --omit=dev --no-fund --no-audit")
    mkdir -p node_modules/deep-view
    printf '%s\\n' '{"name":"deep-view","version":"0.1.0"}' > node_modules/deep-view/package.json
    exit 0
    ;;
esac
echo "unexpected npm: $*" >&2
exit 1
`
}

async function makeTree(options = {}) {
  const {
    git = true,
    deepView = true,
    harness = true,
    dshWeb = true,
    pnpm = true,
    vendor = true,
    placeScript = 'repo',
  } = options
  const root = await mkdtemp(join(tmpdir(), 'odm-web-'))
  const odm = join(root, 'openDigitalMate')
  const bin = join(root, '.fake-bin')
  const npmLog = join(root, 'npm.log')
  await writeFile(npmLog, '')
  await writeExec(join(bin, 'uname'), '#!/bin/sh\nprintf "%s\\n" Darwin\n')
  await writeExec(join(bin, 'node'), nodeShim())
  await writeExec(join(bin, 'npm'), npmShim(npmLog))
  await mkdir(join(odm, 'vendor/ds-bot'), { recursive: true })
  await writeFile(join(odm, 'package.json'), `${JSON.stringify({ name: 'opendigitalmate', private: true })}\n`)
  if (vendor) {
    await writeFile(join(odm, 'vendor/ds-bot/package.json'), `${JSON.stringify({
      name: 'ds-bot',
      version: '0.2.4',
      dependencies: { 'deep-view': '0.1.0' },
    })}\n`)
  }
  if (deepView) {
    await mkdir(join(odm, 'vendor/ds-bot/node_modules/deep-view'), { recursive: true })
    await writeFile(
      join(odm, 'vendor/ds-bot/node_modules/deep-view/package.json'),
      '{"name":"deep-view","version":"0.1.0"}\n',
    )
  }
  if (git) {
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    await execFileAsync('git', ['init', '-q'], { cwd: odm, env: gitEnv })
    await execFileAsync('git', ['config', 'user.email', 'dev@example.com'], { cwd: odm, env: gitEnv })
    await execFileAsync('git', ['config', 'user.name', 'Dev'], { cwd: odm, env: gitEnv })
    await execFileAsync('git', ['add', 'package.json'], { cwd: odm, env: gitEnv })
    await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], { cwd: odm, env: gitEnv })
  }
  if (harness) {
    await mkdir(join(root, 'deepseek-harness'), { recursive: true })
    await writeFile(join(root, 'deepseek-harness/package.json'), '{}\n')
  }
  if (dshWeb) {
    await writeExec(join(root, 'dsh-web.sh'), '#!/bin/sh\nprintf "START_MARKER:%s\\n" "$1"\n')
  }
  if (pnpm) {
    await writeExec(join(root, 'tools/bin/pnpm'), pnpmStub)
  }
  const script = placeScript === 'root'
    ? join(root, 'setup-opendigitalmate-web.sh')
    : join(odm, 'scripts/setup-opendigitalmate-web.sh')
  await mkdir(dirname(script), { recursive: true })
  await cp(scriptSrc, script)
  await chmod(script, 0o755)
  return {
    root,
    odm,
    bin,
    script,
    npmLog,
    profile: join(root, 'data/web/harness/profiles/web'),
  }
}

async function hostAt(root) {
  await mkdir(join(root, 'deepseek-harness'), { recursive: true })
  await writeFile(join(root, 'deepseek-harness/package.json'), '{}\n')
  await writeExec(join(root, 'dsh-web.sh'), '#!/bin/sh\nprintf "START_MARKER:%s\\n" "$1"\n')
  await writeExec(join(root, 'tools/bin/pnpm'), pnpmStub)
}

function run(script, args, { bin, cwd, extraEnv = {} } = {}) {
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` }
  delete env.DSH_DEV_ROOT
  Object.assign(env, extraEnv)
  return execFileAsync('bash', [script, ...args], { encoding: 'utf8', env, cwd })
    .then(
      result => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
      err => {
        if (typeof err.code === 'number') {
          return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
        }
        throw err
      },
    )
}

async function writeProfile(tree, { bundles, cordis = true, dsBotLink, odmLink } = {}) {
  const dsbot = join(tree.odm, 'vendor/ds-bot')
  await mkdir(join(tree.profile, 'node_modules'), { recursive: true })
  const pkg = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {
      'ds-bot': dsBotLink ?? `link:${dsbot}`,
      opendigitalmate: odmLink ?? `link:${tree.odm}`,
    },
    dsh: {
      profile: {
        bundles: bundles ?? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot'],
      },
    },
  }
  await writeFile(join(tree.profile, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  const botLink = join(tree.profile, 'node_modules/ds-bot')
  const odmLinkPath = join(tree.profile, 'node_modules/opendigitalmate')
  await rm(botLink, { force: true })
  await rm(odmLinkPath, { force: true })
  await symlink(dsbot, botLink)
  await symlink(tree.odm, odmLinkPath)
  if (cordis) {
    await writeFile(
      join(tree.profile, 'cordis.patch.yml'),
      '- insert:\n    - id: opendigitalmate\n      name: opendigitalmate\n',
    )
  }
}

function insertCount(text) {
  return [...text.matchAll(/name:\s*"?opendigitalmate"?/g)].length
}

test('help resolves ROOT as the parent of this checkout', async () => {
  const tree = await makeTree()
  const result = await run(tree.script, ['help'], { bin: tree.bin })
  assert.equal(result.code, 0)
  assert.ok(result.stdout.includes(`ROOT=${tree.root}`))
  assert.ok(result.stdout.includes(`ODM=${tree.odm}`))
  assert.match(result.stdout, /bash scripts\/setup-opendigitalmate-web\.sh check/)
  assert.match(result.stdout, /DSH_DEV_ROOT/)
  await rm(tree.root, { recursive: true, force: true })
})

test('a script copied to ROOT links $ROOT/openDigitalMate', async () => {
  const tree = await makeTree({ placeScript: 'root' })
  const result = await run(tree.script, ['help'], { bin: tree.bin })
  assert.equal(result.code, 0)
  assert.ok(result.stdout.includes(`ROOT=${tree.root}`))
  assert.ok(result.stdout.includes(`ODM=${tree.odm}`))
  assert.match(result.stdout, /bash setup-opendigitalmate-web\.sh check/)
  await rm(tree.root, { recursive: true, force: true })
})

test('DSH_DEV_ROOT overrides the harness tree and rejects a missing directory', async () => {
  const tree = await makeTree({ harness: false, dshWeb: false, pnpm: false })
  const harnessRoot = await mkdtemp(join(tmpdir(), 'odm-dsh-'))
  await hostAt(harnessRoot)
  const help = await run(tree.script, ['help'], {
    bin: tree.bin,
    cwd: dirname(harnessRoot),
    extraEnv: { DSH_DEV_ROOT: basename(harnessRoot) },
  })
  assert.equal(help.code, 0)
  assert.ok(help.stdout.includes(`ROOT=${harnessRoot}`))
  assert.ok(help.stdout.includes(`ODM=${tree.odm}`))

  const missing = await run(tree.script, ['help'], {
    bin: tree.bin,
    extraEnv: { DSH_DEV_ROOT: join(tree.root, 'nope') },
  })
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /DSH_DEV_ROOT 不是目录/)
  await rm(tree.root, { recursive: true, force: true })
  await rm(harnessRoot, { recursive: true, force: true })
})

test('check requires macOS and Node >= 24.9', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'odm-uname-'))
  await writeExec(join(bin, 'uname'), '#!/bin/sh\nprintf "%s\\n" Darwin\n')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
  delete env.DSH_DEV_ROOT
  const version = await execFileAsync('bash', [scriptSrc, 'check'], {
    encoding: 'utf8',
    env,
  }).then(
    () => ({ code: 0, stderr: '' }),
    err => ({ code: err.code, stderr: err.stderr ?? '' }),
  )
  const [major, minor] = process.versions.node.split('.').map(Number)
  const belowNode = major < 24 || (major === 24 && minor < 9)
  if (belowNode) {
    assert.equal(version.code, 1)
    assert.match(version.stderr, /需要 Node >=24\.9/)
  } else {
    assert.doesNotMatch(version.stderr, /需要 Node >=24\.9/)
  }

  const linux = await run(scriptSrc, ['check'], { bin: await mkdtemp(join(tmpdir(), 'odm-empty-')) })
  assert.equal(linux.code, 1)
  assert.match(linux.stderr, /请在 macOS 上运行/)
  await rm(bin, { recursive: true, force: true })
})

test('check lists every missing piece and does not install deep-view', async () => {
  const tree = await makeTree({
    git: false,
    deepView: false,
    harness: false,
    dshWeb: false,
    pnpm: false,
    vendor: false,
  })
  const result = await run(tree.script, ['check'], { bin: tree.bin })
  assert.equal(result.code, 1)
  assert.ok(result.stdout.includes(`根目录：${tree.root}`))
  assert.ok(result.stdout.includes(`openDigitalMate：${tree.odm}`))
  assert.match(result.stderr, /不像 ds_dev 根目录/)
  for (const piece of [
    'deepseek-harness 源码',
    'tools/bin/pnpm（先 dsh-dev.sh setup）',
    'dsh-web.sh',
    'openDigitalMate 仓库',
    'vendor/ds-bot',
    'vendor/ds-bot/node_modules/deep-view → npm install --omit=dev',
    'profile package.json',
    'cordis.patch.yml 未 insert opendigitalmate',
    'profile node_modules links',
    '有缺失项',
  ]) {
    assert.match(result.stdout, new RegExp(piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.doesNotMatch(result.stdout, /检查全部通过/)
  assert.equal(await readFile(tree.npmLog, 'utf8'), '')
  await rm(tree.root, { recursive: true, force: true })
})

test('check rejects a profile whose only bundle is opendigitalmate', async () => {
  const tree = await makeTree()
  await writeProfile(tree, { bundles: ['opendigitalmate'] })
  const result = await run(tree.script, ['check'], { bin: tree.bin })
  assert.equal(result.code, 1)
  assert.match(result.stdout, /profile bundles 没有 ds-bot（会变成非 Bot 界面）/)
  assert.match(result.stdout, /bundles 只有 opendigitalmate、没有 ds-bot/)
  await rm(tree.root, { recursive: true, force: true })
})

test('check accepts absolute or relative links that resolve to this checkout', async () => {
  const tree = await makeTree()
  await writeProfile(tree)
  const absolute = await run(tree.script, ['check'], { bin: tree.bin })
  assert.equal(absolute.code, 0, absolute.stdout + absolute.stderr)
  assert.match(absolute.stdout, /检查全部通过/)

  const profileDir = tree.profile
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {
      'ds-bot': `link:${relative(profileDir, join(tree.odm, 'vendor/ds-bot'))}`,
      opendigitalmate: `link:${relative(profileDir, tree.odm)}`,
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot'] } },
  }, null, 2)}\n`)
  const relativeLinks = await run(tree.script, ['check'], { bin: tree.bin })
  assert.equal(relativeLinks.code, 0, relativeLinks.stdout + relativeLinks.stderr)

  const other = join(tree.root, 'other-bot')
  await mkdir(other, { recursive: true })
  await writeProfile(tree, { dsBotLink: `link:${other}` })
  const wrong = await run(tree.script, ['check'], { bin: tree.bin })
  assert.equal(wrong.code, 1)
  assert.match(wrong.stdout, /profile package.json 未正确 link ds-bot \/ opendigitalmate/)
  assert.doesNotMatch(wrong.stdout, /profile bundles 没有 ds-bot/)
  await rm(tree.root, { recursive: true, force: true })
})

test('setup rewrites the Bot profile, keeps cordis config, and installs deep-view', async () => {
  const tree = await makeTree({ deepView: false })
  await mkdir(tree.profile, { recursive: true })
  await writeFile(join(tree.profile, 'cordis.patch.yml'), '- id: llm\n  config:\n    provider: deepseek')
  const setup = await run(tree.script, ['setup'], { bin: tree.bin })
  assert.equal(setup.code, 0, setup.stdout + setup.stderr)
  assert.equal(setup.stderr, '')
  assert.match(setup.stdout, /检查全部通过/)
  assert.equal(await readFile(tree.npmLog, 'utf8'), 'install --omit=dev --no-fund --no-audit\n')
  const deepView = JSON.parse(await readFile(join(tree.odm, 'vendor/ds-bot/node_modules/deep-view/package.json'), 'utf8'))
  assert.equal(deepView.name, 'deep-view')

  const pkgPath = join(tree.profile, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  assert.deepEqual(pkg.dependencies, {
    'ds-bot': `link:${join(tree.odm, 'vendor/ds-bot')}`,
    opendigitalmate: `link:${tree.odm}`,
  })
  assert.deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot'])
  assert.equal(await readlink(join(tree.profile, 'node_modules/ds-bot')), join(tree.odm, 'vendor/ds-bot'))
  assert.equal(await readlink(join(tree.profile, 'node_modules/opendigitalmate')), tree.odm)

  const patch = await readFile(join(tree.profile, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /provider: deepseek/)
  assert.equal(insertCount(patch), 1)
  assert.match(patch, /deepseek\n- insert:\n {4}- id: opendigitalmate\n {6}name: opendigitalmate\n/)

  pkg.dependencies.extra = '1.0.0'
  pkg.dsh.profile.bundles = ['opendigitalmate']
  await writeFile(pkgPath, JSON.stringify(pkg))
  const again = await run(tree.script, [], { bin: tree.bin })
  assert.equal(again.code, 0, again.stdout + again.stderr)
  const rewritten = JSON.parse(await readFile(pkgPath, 'utf8'))
  assert.deepEqual(Object.keys(rewritten.dependencies).sort(), ['ds-bot', 'opendigitalmate'])
  assert.deepEqual(rewritten.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot'])
  assert.equal(insertCount(await readFile(join(tree.profile, 'cordis.patch.yml'), 'utf8')), 1)
  assert.equal(await readFile(tree.npmLog, 'utf8'), 'install --omit=dev --no-fund --no-audit\n')

  const check = await run(tree.script, ['check'], { bin: tree.bin })
  assert.equal(check.code, 0, check.stdout + check.stderr)
  await rm(tree.root, { recursive: true, force: true })
})

test('a similarly named cordis key is not treated as the opendigitalmate insert', async () => {
  const tree = await makeTree()
  await mkdir(tree.profile, { recursive: true })
  await writeFile(join(tree.profile, 'cordis.patch.yml'), 'name: opendigitalmate-extra\n')
  const setup = await run(tree.script, ['setup'], { bin: tree.bin })
  assert.equal(setup.code, 0, setup.stdout + setup.stderr)
  const patch = await readFile(join(tree.profile, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /name: opendigitalmate-extra/)
  assert.match(patch, /^ {6}name: opendigitalmate$/m)
  await rm(tree.root, { recursive: true, force: true })
})

test('setup does not duplicate an existing quoted opendigitalmate insert', async () => {
  const tree = await makeTree()
  await mkdir(tree.profile, { recursive: true })
  await writeFile(
    join(tree.profile, 'cordis.patch.yml'),
    '- id: llm\n  config:\n    provider: deepseek\n- insert:\n    - id: opendigitalmate\n      name: "opendigitalmate"\n',
  )
  const setup = await run(tree.script, ['setup'], { bin: tree.bin })
  assert.equal(setup.code, 0, setup.stdout + setup.stderr)
  const patch = await readFile(join(tree.profile, 'cordis.patch.yml'), 'utf8')
  assert.equal(insertCount(patch), 1)
  assert.match(patch, /provider: deepseek/)
  assert.equal(await readFile(tree.npmLog, 'utf8'), '')
  await rm(tree.root, { recursive: true, force: true })
})

test('setup wires this checkout into a separate DSH_DEV_ROOT', async () => {
  const tree = await makeTree({ harness: false, dshWeb: false, pnpm: false })
  const harnessRoot = await mkdtemp(join(tmpdir(), 'odm-dsh-'))
  await hostAt(harnessRoot)
  const setup = await run(tree.script, ['setup'], {
    bin: tree.bin,
    extraEnv: { DSH_DEV_ROOT: harnessRoot },
  })
  assert.equal(setup.code, 0, setup.stdout + setup.stderr)
  const pkg = JSON.parse(await readFile(join(harnessRoot, 'data/web/harness/profiles/web/package.json'), 'utf8'))
  assert.equal(pkg.dependencies['ds-bot'], `link:${join(tree.odm, 'vendor/ds-bot')}`)
  assert.equal(pkg.dependencies.opendigitalmate, `link:${tree.odm}`)
  assert.equal(await readFile(join(tree.root, 'data/web/harness/profiles/web/package.json'), 'utf8').catch(() => ''), '')
  await rm(tree.root, { recursive: true, force: true })
  await rm(harnessRoot, { recursive: true, force: true })
})

test('setup stops before writing a profile when the harness tree is incomplete', async () => {
  const noHarness = await makeTree({ harness: false })
  const harness = await run(noHarness.script, ['setup'], { bin: noHarness.bin })
  assert.equal(harness.code, 1)
  assert.match(harness.stderr, /先准备 deepseek-harness/)
  assert.equal(await readFile(join(noHarness.profile, 'package.json'), 'utf8').catch(() => ''), '')

  const noWeb = await makeTree({ dshWeb: false })
  const web = await run(noWeb.script, ['setup'], { bin: noWeb.bin })
  assert.equal(web.code, 1)
  assert.match(web.stderr, /缺少 dsh-web\.sh/)

  const noGit = await makeTree({ git: false })
  const repo = await run(noGit.script, ['setup'], { bin: noGit.bin })
  assert.equal(repo.code, 1)
  assert.match(repo.stderr, /不是 git 仓库/)

  const noVendor = await makeTree({ vendor: false })
  const vendor = await run(noVendor.script, ['setup'], { bin: noVendor.bin })
  assert.equal(vendor.code, 1)
  assert.match(vendor.stderr, /缺少 vendored ds-bot/)

  await rm(noHarness.root, { recursive: true, force: true })
  await rm(noWeb.root, { recursive: true, force: true })
  await rm(noGit.root, { recursive: true, force: true })
  await rm(noVendor.root, { recursive: true, force: true })
})

test('start launches dsh-web only after check passes', async () => {
  const tree = await makeTree()
  const early = await run(tree.script, ['start'], { bin: tree.bin })
  assert.equal(early.code, 1)
  assert.match(early.stderr, /先跑 setup 补齐缺失项/)
  assert.doesNotMatch(`${early.stdout}${early.stderr}`, /START_MARKER/)

  const setup = await run(tree.script, ['setup'], { bin: tree.bin })
  assert.equal(setup.code, 0, setup.stdout + setup.stderr)
  const start = await run(tree.script, ['start'], { bin: tree.bin })
  assert.equal(start.code, 0, start.stdout + start.stderr)
  assert.match(start.stdout, /转调 bash dsh-web\.sh start/)
  assert.match(start.stdout, /START_MARKER:start/)
  await rm(tree.root, { recursive: true, force: true })
})

test('unknown command is an error', async () => {
  const tree = await makeTree()
  const result = await run(tree.script, ['nope'], { bin: tree.bin })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /未知命令：nope/)
  await rm(tree.root, { recursive: true, force: true })
})
