# openDigitalMate

### Douya / 豆芽 — a Muse-style coworker that lives in your browser

[![License](https://img.shields.io/badge/license-Apache--2.0-0B3D2E?style=flat-square)](./LICENSE)
[![Node](https://img.shields.io/badge/node-ESM-1B6B4A?style=flat-square)](#requirements)
[![dsh](https://img.shields.io/badge/host-dsh%20odm%20profile-0E4D8C?style=flat-square)](https://github.com/deepseek-ai/dsh)
[![UI](https://img.shields.io/badge/UI-EN%20%2F%20中文-5B21B6?style=flat-square)](#language)

Not a dashboard. Douya pulls live work from tools you already use, turns it into **Today** cards, and helps you finish — with every outbound send gated behind Confirm.

```
  ┌─────────────┐     ┌──────────────┐     ┌────────────┐
  │ Source bots │ ──▶ │ Chief merge  │ ──▶ │ Today page │
  │ Gmail/GH/Sl │     │ rank + plan  │     │ act + chat │
  └─────────────┘     └──────────────┘     └────────────┘
         ▲                   ▲
         │                   │
   Composio live        OpenViking recall
```

**Repo:** [open-x-agents/openDigitalMate](https://github.com/open-x-agents/openDigitalMate) · **License:** Apache-2.0

---

## What you get

| Surface | What it does |
| --- | --- |
| **Today** | Hero (“what now”), timetable, digest cards with prep, “what got done” tuck |
| **Pending confirm** | Outbound mail / comments / archives only leave after you click Confirm |
| **Dock chat** | Talk with Douya (Chief). Confirmed sends echo into card chat + general chat |
| **Sources** | Connect GitHub, Gmail, Slack, Calendar, … via Composio |
| **Memories** | Glimpse of durable recalls — achievements & decisions first |
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

## Bot routing — who does what

Dock chat is always **Chief**. Digest work is split:

| When | Who | Why |
| --- | --- | --- |
| ACTIVE Composio account for Gmail / GitHub / Slack **and** live items | **Source bot** | Owns that channel’s candidate cards |
| Snapshot empty (all done / nothing new) | **Skip** source bot | No wasted LLM turn; strip shows skipped |
| Calendar connected | **Aux fetch** only | Feeds hero + timetable; no source bot |
| Account connected but not ACTIVE | Strip **failed** | Reconnect in Sources |
| ≥1 candidate from source bots | **Chief** merge | Dedupe, rank, headline, timeline |
| Zero candidates after source passes | **Skip Chief** | Default empty plan; still refresh hero/timetable |

Source bots never chat with you. Chief never re-fetches a channel during merge.

---

## Future — long-term plans

Muse’s **Future / 未来** page turns real interests into a goal, a quoted reason it fits,
step progress, and one concrete action for this week. Ask Chief to plan with you:
`odm_future_get` reads plans + OpenViking filesystem memories (no semantic embedding
required); `odm_future_update` proposes, accepts/creates, edits, checks/undoes a step,
or archives. Suggestions stay inactive until you accept on the page or explicitly agree
in chat. If interests are missing, Douya asks rather than assuming fitness or study goals.

Plans and progress live in `futurePlans` in the existing host `state.json`
(`$DSH_HOME/opendigitalmate/state.json`, or the configured host home), independently
of digest cards; restart and re-digest preserve them. No extra service, scheduler, or
OpenViking writes. Chrome is EN/ZH; plan text stays in the language you used.

未来页：从真实回忆或你亲口说的兴趣出发；先提建议，同意后再开始。
可以勾选、撤销、继续加下一步、归档，进度不会被下次汇聚覆盖。

## Long-term memory

Douya uses **[OpenViking](https://docs.openviking.net/en/agent-integrations/17-dsh)** via [`@openviking/dsh-memory-plugin`](https://www.npmjs.com/package/@openviking/dsh-memory-plugin) (~0.5.33): auto-recall, session capture, and `mcp__openviking__*` tools in chat. **Memories** glimpse + Chief digest read the same server (`viking://~/memories`), ranked achievement-first (experiences / events / decisions above routine prefs). Forget uses the server `DELETE /api/v1/fs` (same as MCP `forget`).

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

`openviking-server doctor` may warn that embedding / VLM are missing. **Memories list + forget** still work over the filesystem API; semantic auto-recall / search need a working embedding (local GGUF via `openviking[local-embed]`, Ollama, or a cloud key).

---


## Muse UI plugin

The Today page is a separate dsh client plugin: [`dsh-muse-ui`](./packages/dsh-muse-ui) (same spirit as OpenViking memory). The host package keeps APIs / digests / bots; the UI plugin replaces the stock shell and serves Muse at `/api/opendigitalmate/app`.

```bash
# from this checkout (Mac / Linux):
dsh plugin --profile odm add link:$(pwd)/packages/dsh-muse-ui
# package.json dsh.profile.bundles should list both:
#   "opendigitalmate"
#   "dsh-muse-ui"
```

Restart dsh after adding. Without `dsh-muse-ui`, the stock dsh shell stays; host APIs still work.

## Digests & actions

1. Source bots propose → Chief merges into Today (legacy pipeline is fallback).  
2. Cards carry prepared steps (open, snooze, ask Douya, or a write).  
3. A write creates a **pending** action. Confirm runs via Composio; Cancel drops; Undo when the provider allows.  
4. On success: item marked done, may tuck into “What got done today”, and a `✓ Sent · HH:MM` line lands in card + general chat.

Optional schedule: `DIGEST_SCHEDULE=08:00`, `ENABLE_DIGEST=true`.

---

## Development

```bash
npm test
```

| Path | Role |
| --- | --- |
| `packages/dsh-muse-ui/` | Muse Today UI (dsh client plugin) |
| `src/i18n/` | en/zh chrome |
| `src/web/api.js` | Router / standalone HTTP |
| `src/web/dsh-host-routes.js` | Routes on the dsh process |
| `src/web/action-effects.js` | Confirmed-send outcome sync |
| `src/digest/` | Snapshot / build / runner / bot routing |

Restart after pulls: `npm start` or `scripts/.odm-restart.sh`.

---

## Security

- **Localhost only** — other machines cannot open the UI  
- Never commit `.env`, `.odm-data/`, or the token URL file  
- Outbound actions require an explicit Confirm click  

---

## Status

**Shipped:** multi-bot digests with skip-empty routing, desktop UX, pending-confirm sends, outcome sync, EN/中文 chrome, OpenViking memory, Muse UI as `dsh-muse-ui`, Sources logos & Composio catalog.

**Evolving:** denser mobile polish, richer source coverage.

---

## Contributing

1. Fork and branch from `main`  
2. Keep tests green: `npm test`  
3. Open a PR with a clear English description  

## License

Apache-2.0
