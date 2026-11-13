# Douya

**Douya / 豆芽** is a desktop personal assistant for Windows, macOS, and Linux.

[Website](https://open-x-agents.github.io/Douya/) · [Download](https://github.com/open-x-agents/Douya/releases/latest) · [Docs](docs/README.md)

<p align="center">
  <img src="site/img/today.jpg" alt="Douya Today — a morning digest with a planned next step, finished work, and chat" width="920" />
</p>

It sits on your desktop and brings today’s mail, GitHub, Slack, and calendar onto one page. You can talk to it, keep a local memory, and grow longer-term plans — with your consent before anything goes outbound.

The UI is bilingual, English and 中文. A chat model provider is required; the app is not fully offline. Connecting Gmail, GitHub, Slack, or calendar uses [Composio](https://app.composio.dev) and is optional.

## Download

Current desktop packages: **[desktop-v0.1.0](https://github.com/open-x-agents/Douya/releases/tag/desktop-v0.1.0)** ([Latest](https://github.com/open-x-agents/Douya/releases/latest)). Checksums: [SHA256SUMS](https://github.com/open-x-agents/Douya/releases/download/desktop-v0.1.0/SHA256SUMS).

| Platform | File |
| --- | --- |
| Windows x64 | [Douya-0.1.0-win-x64-Setup.exe](https://github.com/open-x-agents/Douya/releases/download/desktop-v0.1.0/Douya-0.1.0-win-x64-Setup.exe) · [self-signed .cer](https://github.com/open-x-agents/Douya/releases/download/desktop-v0.1.0/Douya-0.1.0-win-x64-selfsigned.cer) (public cert only) |
| macOS Apple Silicon | [Douya-0.1.0-mac-arm64.dmg](https://github.com/open-x-agents/Douya/releases/download/desktop-v0.1.0/Douya-0.1.0-mac-arm64.dmg) |
| macOS Intel | [Douya-0.1.0-mac-x64.dmg](https://github.com/open-x-agents/Douya/releases/download/desktop-v0.1.0/Douya-0.1.0-mac-x64.dmg) |
| Linux x64 | [AppImage](https://github.com/open-x-agents/Douya/releases/download/desktop-v0.1.0/Douya-0.1.0-linux-x64.AppImage) or [`.deb`](https://github.com/open-x-agents/Douya/releases/download/desktop-v0.1.0/douya-desktop_0.1.0_amd64.deb) |
| Linux arm64 | [AppImage](https://github.com/open-x-agents/Douya/releases/download/desktop-v0.1.0/Douya-0.1.0-linux-arm64.AppImage) or [`.deb`](https://github.com/open-x-agents/Douya/releases/download/desktop-v0.1.0/douya-desktop_0.1.0_arm64.deb) |

The installer already includes the Douya server and [dsh](https://github.com/deepseek-ai/dsh). You do not need a git checkout, a Node.js install, or a separate dsh. On first launch it writes data under the app’s user directory and opens a short setup wizard.

Installers are not warning-free. macOS is ad-hoc signed and not notarized (right-click **Douya.app → Open**, or `xattr -dr com.apple.quarantine /Applications/Douya.app`). Windows is self-signed (SmartScreen: More info → Run anyway). Linux packages are unsigned. On Linux pick **one** format: `.deb` on Ubuntu/Debian, AppImage elsewhere (`chmod +x` first; needs `libfuse.so.2`, or `--appimage-extract-and-run`). Do not pass `--no-sandbox`. Details: [docs/install.md](docs/install.md).

## First launch

### Configure AI + Composio

A two-step wizard opens if no chat model is saved yet (it is also in Settings):

1. **Model API** — pick a provider (DeepSeek is the default), paste a key, Save, optionally Test connection. This is required for chat.
2. **Composio** (optional, can skip) — paste a **project** API key from the [Composio dashboard](https://platform.composio.dev) (Settings → Project Settings → API Keys). Then connect GitHub, Gmail, Slack, or Calendar on **Sources**, only the apps you want.

Outbound mail, comments, and archives stay pending until you click **Confirm**.

## What you can do

| | |
| --- | --- |
| **Today** | Aggregates mail, GitHub, Slack, and calendar into a daily page: a suggested next step, a timetable, digest cards, and what already got done. |
| **Chat** | Talk with Douya from the dock or a card. Prepared outbound actions wait for an explicit Confirm. |
| **Recall** | Local long-term memory via the official [`@modelcontextprotocol/server-memory`](https://www.npmjs.com/package/@modelcontextprotocol/server-memory) server (a JSONL knowledge graph on disk, no embeddings). Chat tools are `mcp__memory__*`. Achievements surface first. Forget removes an observation or an entity. Photo attachments are not supported. |
| **Future** | Propose a plan from a memory or a stated interest; you accept before work starts. Tick a step, or complete one with Douya. Progress survives a restart. |

The UI binds to `127.0.0.1`. More: [docs/memory.md](docs/memory.md), [docs/sources/connected-scans.md](docs/sources/connected-scans.md), [docs/LLM_SETUP.md](docs/LLM_SETUP.md).

## Privacy

Your data stays on this machine, under the app’s user directory — on macOS `~/Library/Application Support/Douya`, on Windows `%APPDATA%\Douya`, on Linux `~/.config/Douya`. That includes `odm-data/` (config and `memory.jsonl`) and `dsh-odm/` (the local runtime home). Nothing is written into the install folder.

Chat and many features still call the model provider you configured. Connected sources go through Composio, and nothing is sent outbound until you consent. The UI is localhost-only.

## Develop

```bash
npm install
npm start
# → node scripts/start-dsh.mjs → dsh --profile odm --port 7777
```

The process writes a login URL (with token) to `.odm-data/dsh-web.url`. Open that token URL — bare `http://127.0.0.1:7777` returns 401.

> Do not commit or paste the token URL.
>
> On macOS you can put that behind a system-wide hotkey — see [docs/mac-shortcut.md](docs/mac-shortcut.md).

```bash
open "$(cat .odm-data/dsh-web.url)"          # macOS
# xdg-open "$(cat .odm-data/dsh-web.url)"   # Linux
```

`npm test` runs the suite. Branch from `main`, keep tests green, and open a PR (`Fixes #N`, a `Ran:` section, the tip sha). Never push `main` directly. Further notes: [docs/develop.md](docs/develop.md), [docs/testing.md](docs/testing.md), [docs/architecture.md](docs/architecture.md).

## License

The root and desktop `package.json` files list `license` as `Apache-2.0`. This tree does not add a separate license grant file. Bundled runtimes keep their upstream terms: `@modelcontextprotocol/server-memory` is MIT. Repo: [open-x-agents/Douya](https://github.com/open-x-agents/Douya).
