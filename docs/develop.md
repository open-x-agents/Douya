# Develop Douya

This is the source-checkout path: run, test, and pack from git. End users who only want the Electron app should start at the root [README](../README.md#download-the-desktop-app) and [install.md](install.md).

## Requirements

- Node.js (ESM)
- [`dsh`](https://github.com/deepseek-ai/dsh) on `PATH`, with an `odm` profile that includes this host plugin and `dsh-muse-ui`. Long-term memory is official `@modelcontextprotocol/server-memory`, registered via `dsh-mcp-client`.
- For chat: an LLM provider key (DeepSeek recommended)
- For sources: a [Composio](https://app.composio.dev) key
- For source-run memory: `npm install @modelcontextprotocol/server-memory@2.1.1` so `scripts/start-dsh.mjs` can register it — [memory.md](memory.md)

## Run

```bash
npm install
npm start
# → node scripts/start-dsh.mjs → dsh --profile odm --port 7777
open "$(cat .odm-data/dsh-web.url)"   # must be the token URL; bare :7777 is 401
```

`npm start` reads `.odm-data/config.json` when present and applies LLM env for the dsh process. Saving **Settings → AI model** also applies env in the same process, so you usually do not need a restart. See [LLM_SETUP.md](LLM_SETUP.md).

`npm run start:standalone` / `scripts/server.js` is the older Muse-only path. Prefer `npm start` for real Chief chat.

The Muse shell is the [`dsh-muse-ui`](../packages/dsh-muse-ui) plugin and is served at `/api/opendigitalmate/app`. From this checkout (macOS / Linux):

```bash
dsh plugin --profile odm add link:$(pwd)/packages/dsh-muse-ui
```

`scripts/start-dsh.mjs` writes a `dsh-mcp-client` entry for official MCP Memory into the odm profile’s `cordis.patch.yml` (bundled Node, `MEMORY_FILE_PATH` under the data dir; no `npx`). Restart dsh after adding plugins by hand. Without `dsh-muse-ui`, the stock dsh shell stays; host APIs still work.

On macOS you can open the token URL with a system Shortcut: [mac-shortcut.md](mac-shortcut.md).

Environment knobs used by the desktop shell (and useful when spawning it from this checkout):

| Setting | Default |
| --- | --- |
| `ODM_ROOT` | this checkout, then (when packaged) the bundled `app-runtime`, then `~/Documents/git/openDigitalMate` |
| `DSH_BIN` | `$DSH_BIN`, then (when packaged) the bundled dsh JS entry, then `~/Documents/git/dsh-rc5/bin/dsh`, then `dsh` on `PATH` |
| `ODM_PORT` | `7777` |
| `ODM_DATA_DIR` | (packaged) `userData/odm-data`; (source) `<repo>/.odm-data` |
| `DSH_HOME` | (packaged) `userData/dsh-odm`; (source) `<repo>/.dsh-odm` |

## Test

```bash
npm test
# same as: node --test 'test/**/*.test.js' 'acceptance-cases/**/*.test.js'
```

Layers, pr-guard, merge-tree, and the pre-release gate: [testing.md](testing.md). Restart after pulls: `npm start` or `scripts/.odm-restart.sh`.

## Pack the desktop app (developers)

```bash
npm run desktop:dev          # Electron against this checkout
npm --prefix desktop run bundle:runtime  # stage desktop/resources/app-runtime (server + dsh)
npm run desktop:build:mac    # stages app-runtime, then → desktop/dist/*.dmg (one arch per job in CI)
npm run desktop:build:win    # stages app-runtime, then → desktop/dist/*.exe (build on Windows or CI)
npm run desktop:build:linux  # stages app-runtime, then → desktop/dist/*.AppImage and *.deb (build on Linux or CI)
```

CI builds installers only on a `desktop-v*` tag or a manual run of the `desktop` workflow — not on every PR. Official installers are published on [desktop-v0.1.0-rc7](https://github.com/open-x-agents/openDigitalMate/releases/tag/desktop-v0.1.0-rc7). How `v*` and `desktop-v*` differ: [release.md](release.md).

## Layout

| Path | Role |
| --- | --- |
| `packages/dsh-muse-ui/` | Muse shell (Today · Future · Memories · Sources · Settings) |
| `src/i18n/` | en/zh chrome |
| `src/web/api.js` | Router / standalone HTTP |
| `src/web/dsh-host-routes.js` | Routes on the dsh process |
| `src/web/action-effects.js` | Confirmed-send outcome sync |
| `src/digest/` | Snapshot / build / runner / bot routing |
| `desktop/` | Electron shell and pack scripts |
| `docs/design/` | Product narrative art |

## Contributing

1. Branch from `main` — never push directly to `main`
2. Keep tests green: `npm test`
3. Open a PR with `Fixes #N`, a `Ran:` section, and the tip sha
4. Merge only when the owner says so

If you change `index.js` or `src/host/**`, either update [architecture.md](architecture.md) or write `Docs-not-needed: …` in the PR body (pr-guard rule).
