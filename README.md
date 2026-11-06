# openDigitalMate (Douya / 豆芽)

A Muse-style **coworker** personal assistant that runs locally in your browser — not a dashboard.

Douya pulls live work from the tools you already use (GitHub, Gmail, Slack, Calendar, …), turns it into actionable cards for **Today**, and helps you finish things: PR briefs, reply drafts, a timetable hero, and concrete next steps. Outbound mail / comments / archives only go out after you confirm.

- **Repo:** https://github.com/open-x-agents/openDigitalMate
- **License:** Apache-2.0

## What you get

- **Today** — hero (“what to do now”), timetable, digest cards with prep, and a “what got done today” tuck for cleared work
- **Pending confirm** — every outbound send is a pending action; nothing leaves until you click Confirm
- **Dock chat** — talk with Douya (Chief + per-source ds-bot bots); confirmed sends show up in card chat and the general chat
- **Desktop-first UX** — hover / swipe quick actions, IME-safe shortcuts (`J` `K` `E` `C` `S` `?`), two-column zoom
- **English / 中文 UI** — chrome follows the language switch (Settings or the sidebar control). Digest card *bodies* stay as the bots produced them
- **Local-only** — listens on `127.0.0.1` only

## Requirements

- Node.js (ESM)
- [dsh](https://github.com/deepseek-ai/dsh) on your `PATH`, with an `odm` profile that includes ds-bot + this plugin
- API keys: an LLM provider (DeepSeek recommended) and [Composio](https://app.composio.dev) for live sources

## Quick start

```bash
npm install
npm start
# = node scripts/start-dsh.mjs → dsh --profile odm --port 7777
```

The process writes a login URL (with token) to `.odm-data/dsh-web.url`. **Open that token URL** — bare `http://127.0.0.1:7777` returns 401.

```bash
open "$(cat .odm-data/dsh-web.url)"          # macOS
# xdg-open "$(cat .odm-data/dsh-web.url)"   # Linux
```

Do not commit or paste the token URL into issues or chat logs.

### Configure AI + Composio

1. Open **Settings** in the sidebar
2. **AI model** — pick a provider (e.g. DeepSeek), paste the API key, choose a model, Save (optional: Test connection)
3. **Composio** — paste the API key, Save, then connect GitHub / Gmail / Slack / Calendar
4. Back on **Today**, click **Refresh now** to run a digest

You can also copy `.env.example` → `.env` and set `DEEPSEEK_API_KEY` / `COMPOSIO_API_KEY`. Keys saved in Settings live in `.odm-data/config.json` (gitignored); `start-dsh` exports them for Chief. DeepSeek needs a real key — OpenAI-only setups make Chief say “No model is available”.

### Language

Default UI language is **English**. Switch to 中文 from Settings or the compact control under the sidebar nav. Preference is stored in `localStorage` (`odm.lang`).

## How digests and actions work

1. **Per-source bots** gather candidates; **Chief** merges them into Today cards (legacy pipeline is a fallback).
2. Cards carry prepared steps (open, snooze, ask Douya, or a write action).
3. A write creates a **pending** action card. Confirm runs it via Composio; Cancel drops it; Undo reverses when the provider allows.
4. On success, Douya marks the item done, may tuck a cleared card into “What got done today”, and appends a system line (e.g. “Sent · HH:MM”) in the card chat and general chat so nothing still says “not sent yet”.

Schedule (optional): `DIGEST_SCHEDULE=08:00` (24h `HH:MM`), `ENABLE_DIGEST=true`.

## Development

```bash
npm test
# node --test 'test/**/*.test.js' 'acceptance-cases/**/*.test.js'
```

Useful entry points:

| Path | Role |
| --- | --- |
| `src/client/index.html` | Muse Today UI |
| `src/i18n/` | en/zh chrome catalogs + helpers |
| `src/web/api.js` | Router / standalone HTTP |
| `src/web/dsh-host-routes.js` | Routes on the dsh process |
| `src/web/action-effects.js` | Confirmed-send outcome propagation |
| `src/web/card-prep.js` | Hero + prepared steps |
| `src/digest/` | Snapshot / build / runner |

Restart after pulls: `npm start` or your usual `scripts/.odm-restart.sh`.

## Security

- Bound to **localhost** only — other machines cannot open your UI
- **Never commit** `.env`, `.odm-data/`, or the token URL file
- Outbound actions require an explicit Confirm click

## Status

Shipped and in active use locally: multi-bot digests, desktop UX, pending-confirm sends, outcome sync across chats, English/中文 chrome.

Still evolving: denser mobile layout polish, richer source coverage, and digest quality.

## Contributing

1. Fork and branch from `main`
2. Keep tests green: `npm test`
3. Open a PR with a clear English description of the change

## License

Apache-2.0
