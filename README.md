# openDigitalMate

### Douya / 豆芽 — a Muse-style coworker that lives in your browser

[![License](https://img.shields.io/badge/license-Apache--2.0-0B3D2E?style=flat-square)](./LICENSE)
[![Node](https://img.shields.io/badge/node-ESM-1B6B4A?style=flat-square)](#requirements)
[![dsh](https://img.shields.io/badge/host-dsh%20odm%20profile-0E4D8C?style=flat-square)](https://github.com/deepseek-ai/dsh)
[![UI](https://img.shields.io/badge/UI-EN%20%2F%20中文-5B21B6?style=flat-square)](#language)

<p align="center">
  <img src="docs/design/three-pages.jpg" alt="Douya — Future · Today · Memories" width="920" />
</p>

One product. Three pages. Shared memory underneath.

| **Future** | **Today** | **Memories** |
| --- | --- | --- |
| Long-term plans grown from your interests — fitness, study, craft. Propose first; **consent before work**. | Current affairs from mail, PRs, Slack, calendar. Finish something and the state writes back everywhere. | Readable memories & achievements — human sentences, photos welcome. Achievements surface first. |

**Shipped today:** Today, Sources, Future / 未来 (propose, accept, then step or archive), Settings, Memories / Recall (readable tiles + photos), dock chat with Chief, Confirm-gated sends.

```
  Muse UI  ──▶  Chief / source bots  ──▶  OpenViking  ──▶  Sources
  (Today ·     (merge, rank,          (shared            (Gmail · Slack ·
   Memories ·   plan, chat)            memory)             GitHub · Calendar)
   …Future)
```

Less is more · bilingual EN / 中文 · ship via PR into `main` (never push `main` directly).

**Repo:** [open-x-agents/openDigitalMate](https://github.com/open-x-agents/openDigitalMate) · **License:** Apache-2.0

---

## Surfaces

| Surface | What it does |
| --- | --- |
| **Today** | Hero (“what now”), timetable, digest cards with prep, “what got done” tuck, real completion feedback |
| **Memories** (回忆 / Recall) | Readable tiles with photos — achievements first; open one to read it all or add a photo; same `viking://~/memories` store |
| **Pending confirm** | Outbound mail / comments / archives leave only after you click Confirm |
| **Dock chat** | Talk with Douya (Chief). Confirmed sends echo into card chat + general chat |
| **Sources** | Connect GitHub, Gmail, Slack, Calendar, … via Composio |
| **Desktop UX** | Hover/swipe actions, IME-safe shortcuts (`J` `K` `E` `C` `S` `?`), two-column zoom |

Local-only: binds to `127.0.0.1`.

---

## Requirements

- Node.js (ESM)
- [`dsh`](https://github.com/deepseek-ai/dsh) on `PATH`, with an `odm` profile that includes ds-bot + this host plugin + `dsh-muse-ui`
- API keys: an LLM provider (DeepSeek recommended) + [Composio](https://app.composio.dev)

---

## Quick start

```bash
npm install
npm start
# → node scripts/start-dsh.mjs → dsh --profile odm --port 7777
```

The process writes a login URL (with token) to `.odm-data/dsh-web.url`. **Open that token URL** — bare `http://127.0.0.1:7777` returns 401.

```bash
open "$(cat .odm-data/dsh-web.url)"          # macOS
# xdg-open "$(cat .odm-data/dsh-web.url)"   # Linux
```

> Do not commit or paste the token URL into issues or chat logs.

On macOS you can put that behind a system-wide hotkey — see [docs/mac-shortcut.md](docs/mac-shortcut.md).

### Configure AI + Composio

1. **Settings** → pick provider (e.g. DeepSeek), paste key, Save
2. Paste **Composio** key, Save, connect GitHub / Gmail / Slack / Calendar
3. **Today** → **Refresh now**

Keys also work from `.env` (`DEEPSEEK_API_KEY` / `COMPOSIO_API_KEY`) or `.odm-data/config.json` (gitignored). DeepSeek needs a real key — OpenAI-only setups make Chief say “No model is available”.

### Language

Default UI is **English**. Switch to 中文 in Settings or the sidebar control (`localStorage` key `odm.lang`). Digest card *bodies* stay as the bots wrote them.

---

## Desktop app

A thin Electron shell for **macOS** and **Windows** in [`desktop/`](desktop/) (own `package.json`, so the root install stays small). It opens Douya in its own window: if a server already answers on `127.0.0.1:7777` with a working token it reuses it, otherwise it runs `scripts/start-dsh.mjs` for you and stops it on quit.

```bash
npm run desktop:dev          # run from this checkout
npm run desktop:build:mac    # → desktop/dist/*.dmg (arm64 + x64, ad-hoc signed)
npm run desktop:build:win    # → desktop/dist/*.exe (NSIS; build on Windows or CI)
```

| Setting | Default |
| --- | --- |
| `ODM_ROOT` — repo folder | this checkout, then `~/Documents/git/openDigitalMate`; else it asks once and remembers |
| `DSH_BIN` — dsh binary | `$DSH_BIN`, then `~/Documents/git/dsh-rc5/bin/dsh`, then `dsh` on `PATH` |
| `ODM_PORT` | `7777` |

Installers are not notarized. First launch on macOS: right-click **Douya.app → Open** (or `xattr -dr com.apple.quarantine /Applications/Douya.app`). On Windows, SmartScreen shows **More info → Run anyway**. CI builds both on demand: the `desktop` workflow (manual, or a `desktop-v*` tag).

---

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Muse UI    │ ◀── │  Chief / bots    │ ◀── │  Sources     │
│  dsh-muse-ui│     │  merge · chat    │     │  Composio    │
└──────┬──────┘     └────────┬─────────┘     └──────────────┘
       │                     │
       │              ┌──────▼──────┐
       └─────────────▶│ OpenViking  │  shared store
                      │ memories    │  viking://~/memories
                      └─────────────┘
```

- **Muse UI** (`packages/dsh-muse-ui`) — desktop-first shell: Future, Today, Memories, Sources, Settings.
- **Chief / source bots** — channel bots propose when accounts are ACTIVE and snapshots are non-empty; Chief merges, ranks, and owns dock chat. Empty snapshots skip the bot. Calendar is aux fetch only.
- **OpenViking** — durable memory for chat recall, Memories glimpse, and the memories Future plans are grounded in.
- **Sources** — live connectors via Composio; bounded YouTube subscription and recent-content scans, with explicit unsupported/error rows. See [scan coverage and limits](docs/sources/connected-scans.md). Nothing outbound without Confirm.

### Bot routing — who does what

| When | Who | Why |
| --- | --- | --- |
| ACTIVE Composio account for Gmail / GitHub / Slack **and** live items | **Source bot** | Owns that channel’s candidate cards |
| Snapshot empty (all done / nothing new) | **Skip** source bot | No wasted LLM turn; strip shows skipped |
| Calendar connected | **Aux fetch** only | Feeds hero + timetable; no source bot |
| Account connected but not ACTIVE | Strip **failed** | Reconnect in Sources |
| ≥1 candidate from source bots | **Chief** merge | Dedupe, rank, headline, timeline |
| Zero candidates after source passes | **Skip Chief** | Default empty plan; still refresh hero/timetable |

Source bots never chat with you. Chief never re-fetches a channel during merge. Dock chat always goes to Chief.

---

## Future — long-term plans

Muse’s **Future / 未来** page turns real interests into a goal, a quoted reason it fits,
step progress, and one concrete action for this week. Ask Chief to plan with you:
`odm_future_get` reads plans + OpenViking filesystem memories (no semantic embedding
required); `odm_future_update` proposes, accepts/creates, edits, checks/undoes a step,
or archives. Suggestions stay inactive until you accept on the page or explicitly agree
in chat. If interests are missing, Douya asks rather than assuming fitness or study goals.

The next step on an active plan has **Do this with Douya / 和豆芽一起做**: it opens chat
with a short natural sentence about the step. Plan/step ids and tool instructions go as
hidden context (not shown in the transcript). Douya proposes concrete moves with
its existing tools (GitHub lookup, drafts, a timetable block via **Schedule it / 排进时间表**).
Anything outbound stays a Confirm card. When the step is done, Douya calls
`odm_future_update op=step done=true` with a one-line `evidence` (e.g. the PR link) and an
optional `nextStep`; the card shows the proof, the new progress, and what is up next.
The checkbox remains as a manual fallback.

Plans and progress live in `futurePlans` in the existing host `state.json`
(`$DSH_HOME/opendigitalmate/state.json`, or the configured host home), independently
of digest cards; restart and re-digest preserve them. No extra service, scheduler, or
OpenViking writes. Chrome is EN/ZH; plan text stays in the language you used.

On the page a plan starts from a real memory (回忆) or an interest you say out loud: propose
first, work only after you agree. Tick a step off, undo it, add the next one, or archive (归档)
the plan — progress survives the next digest.

## Long-term memory

Douya uses **[OpenViking](https://docs.openviking.net/en/agent-integrations/17-dsh)** via [`@openviking/dsh-memory-plugin`](https://www.npmjs.com/package/@openviking/dsh-memory-plugin) (~0.5.33): auto-recall, session capture, and `mcp__openviking__*` tools in chat. **Memories** glimpse + Chief digest read the same server (`viking://~/memories`), ranked achievement-first. Forget uses the server `DELETE /api/v1/fs` (same as MCP `forget`).

### 1. OpenViking server (minimal local)

```bash
# needs uv + embedding/VLM models configured by the wizard — see OpenViking quickstart
uv tool install openviking --upgrade
openviking-server init
openviking-server doctor
openviking-server
# → http://127.0.0.1:1933   curl http://127.0.0.1:1933/health
```

### 2. CLI connection (`ovcli.conf`)

```bash
npm install -g @openviking/cli
# or write the file directly for local no-auth mode:
mkdir -p ~/.openviking
cat > ~/.openviking/ovcli.conf <<'JSON'
{ "url": "http://127.0.0.1:1933" }
JSON
```

Remote / managed: set `api_key` (and optional `account` / `user`), or export `OPENVIKING_URL` + `OPENVIKING_API_KEY`.

### 3. dsh odm profile plugin

```bash
dsh plugin --profile odm add @openviking/dsh-memory-plugin@0.5.33
# package.json dsh.profile.bundles should list "@openviking/dsh-memory-plugin"
# optional cordis.patch.yml knobs:
# - id: openviking-memory-runtime
#   config: { recallMaxTokens: 2000, scoreThreshold: 0.35, captureToolResults: true }
```

Remove legacy `dsh-memory` from the profile once OpenViking is healthy. While the server is down, Muse still falls back to the old SQLite `memory.db` for Glimpse only (chat auto-recall needs the server).

**Recall page (in `dsh-muse-ui`).** Memories read as a short title plus plain sentences — no `viking://` URIs, marker tokens or markdown (`packages/dsh-muse-ui/memory-present.js`, served to the page as `/api/opendigitalmate/memory-present.js`). Open a tile to read the whole memory; **Add photo** (png / jpeg / gif / webp, ≤ 5 MB) stores the image **in OpenViking** as a resource under `viking://resources/recall/<memory>/` (memories reject binary writes) and appends `![caption](viking://resources/recall/…)` to the memory, so chat sees the same link. The host only adds `GET|POST /api/opendigitalmate/memories/image` (proxy restricted to `viking://resources/recall/`); forgetting a memory deletes its photos too.

`openviking-server doctor` may warn that embedding / VLM are missing. **Memories list + forget** still work over the filesystem API; semantic auto-recall / search need a working embedding (local GGUF via `openviking[local-embed]`, Ollama, or a cloud key).

---

## Muse UI plugin

The shell is a separate dsh client plugin: [`dsh-muse-ui`](./packages/dsh-muse-ui). The host package keeps APIs / digests / bots; the UI plugin replaces the stock shell and serves Muse at `/api/opendigitalmate/app`.

```bash
# from this checkout (Mac / Linux):
dsh plugin --profile odm add link:$(pwd)/packages/dsh-muse-ui
# package.json dsh.profile.bundles should list both:
#   "opendigitalmate"
#   "dsh-muse-ui"
```

Restart dsh after adding. Without `dsh-muse-ui`, the stock dsh shell stays; host APIs still work.

---

## Digests & actions

1. Source bots propose → Chief merges into Today (legacy pipeline is fallback).
2. Cards carry prepared steps (open, snooze, ask Douya, or a write).
3. A write creates a **pending** action. Confirm runs via Composio; Cancel drops; Undo when the provider allows.
4. On success: item marked done, may tuck into “What got done today”, and a `✓ Sent · HH:MM` line lands in card + general chat.

Optional schedule: `DIGEST_SCHEDULE=08:00`, `ENABLE_DIGEST=true`.

### Site blocks

Some sites — Cloudflare-fronted ones in particular — answer automated or personal-assistant traffic with an intercept page instead of the content. When that happens Douya says one plain sentence — “This site blocked this request; I won't try to get around it.” — on the card brief or as the first line in chat, and that is all it does about it.

It does not get around the block:

- no different domain,
- no mirror or reader proxy (such as `r.jina.ai`),
- no different User-Agent,
- no `bash` + `curl` retry.

The intercept page's HTML is not repeated and the body is not guessed; if you need the content, open the link and paste the points back.

This is inferred from the intercept page: it says this one request was blocked, not what the site's policy is.

---

## Development

```bash
npm test
```

| Path | Role |
| --- | --- |
| `packages/dsh-muse-ui/` | Muse shell (Today · Memories · Sources · Settings) |
| `src/i18n/` | en/zh chrome |
| `src/web/api.js` | Router / standalone HTTP |
| `src/web/dsh-host-routes.js` | Routes on the dsh process |
| `src/web/action-effects.js` | Confirmed-send outcome sync |
| `src/digest/` | Snapshot / build / runner / bot routing |
| `docs/design/` | Product narrative art (Future · Today · Memories) |

Restart after pulls: `npm start` or `scripts/.odm-restart.sh`.

---

## Security

- **Localhost only** — other machines cannot open the UI
- Never commit `.env`, `.odm-data/`, or the token URL file
- Outbound actions require an explicit Confirm click

---

## Status

**Shipped:** multi-bot digests with skip-empty routing, desktop Muse UX, pending-confirm sends, outcome sync, EN/中文 chrome, OpenViking memory + Memories/Recall (readable tiles + photos), Muse UI as `dsh-muse-ui`, Sources logos & Composio catalog, consent-first Future plans (#137).

**Evolving:** denser mobile polish, richer source coverage.

---

## Contributing

1. Branch from `main` — never push directly to `main`
2. Keep tests green: `npm test`
3. Open a PR with `Fixes #N`, a `Ran:` section, and the tip sha
4. Merge only when the owner says so

## License

Apache-2.0
