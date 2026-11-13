# Install the desktop app

Douya / 豆芽 is a desktop personal assistant for Windows, macOS, and Linux: an Electron shell around a local dsh server. This page is the packaged app: download, first launch, signing, and where data lives. To run from a git checkout only, see [develop.md](develop.md) and the root [README](../README.md#develop).

## Which release to download

Use the **[latest desktop release](https://github.com/open-x-agents/Douya/releases/latest)** (**[desktop-v0.1.0](https://github.com/open-x-agents/Douya/releases/tag/desktop-v0.1.0)**). Verify downloads with [SHA256SUMS](https://github.com/open-x-agents/Douya/releases/download/desktop-v0.1.0/SHA256SUMS) on that same release.

The earlier source-only tag **[v0.1.0](https://github.com/open-x-agents/Douya/releases/tag/v0.1.0)** (2026-10-30) has no installers.

## Packages

| Platform | Arch | Download |
| --- | --- | --- |
| Windows | x64 | [Douya-0.1.0-win-x64-Setup.exe](https://github.com/open-x-agents/Douya/releases/download/desktop-v0.1.0/Douya-0.1.0-win-x64-Setup.exe) and the public [Douya-0.1.0-win-x64-selfsigned.cer](https://github.com/open-x-agents/Douya/releases/download/desktop-v0.1.0/Douya-0.1.0-win-x64-selfsigned.cer) |
| macOS | arm64 (Apple Silicon) | [Douya-0.1.0-mac-arm64.dmg](https://github.com/open-x-agents/Douya/releases/download/desktop-v0.1.0/Douya-0.1.0-mac-arm64.dmg) |
| macOS | x64 (Intel) | [Douya-0.1.0-mac-x64.dmg](https://github.com/open-x-agents/Douya/releases/download/desktop-v0.1.0/Douya-0.1.0-mac-x64.dmg) |
| Linux | x64 | [Douya-0.1.0-linux-x64.AppImage](https://github.com/open-x-agents/Douya/releases/download/desktop-v0.1.0/Douya-0.1.0-linux-x64.AppImage) **or** [douya-desktop_0.1.0_amd64.deb](https://github.com/open-x-agents/Douya/releases/download/desktop-v0.1.0/douya-desktop_0.1.0_amd64.deb) |
| Linux | arm64 | [Douya-0.1.0-linux-arm64.AppImage](https://github.com/open-x-agents/Douya/releases/download/desktop-v0.1.0/Douya-0.1.0-linux-arm64.AppImage) **or** [douya-desktop_0.1.0_arm64.deb](https://github.com/open-x-agents/Douya/releases/download/desktop-v0.1.0/douya-desktop_0.1.0_arm64.deb) |

On Linux, the AppImage and the `.deb` are **alternatives**. Install one, not both. Prefer the `.deb` on Ubuntu/Debian; use the AppImage on other distributions. Pick the file that matches your CPU.

```bash
chmod +x Douya-0.1.0-linux-x64.AppImage
./Douya-0.1.0-linux-x64.AppImage

# Ubuntu / Debian, instead of the AppImage:
sudo dpkg -i douya-desktop_0.1.0_amd64.deb
```

The AppImage needs `libfuse.so.2` (FUSE) to run in place. If the loader errors with `dlopen(): error loading libfuse.so.2`, either install that library or run `./Douya-0.1.0-linux-x64.AppImage --appimage-extract-and-run`. Do **not** pass `--no-sandbox`.

These packages were built on GitHub-hosted runners (macOS arm64 and x64, Windows x64, Ubuntu x64 and arm64). That is not a claim of universal OS compatibility.

## Signing and first launch

Installers are not warning-free, and they are not notarized.

- **macOS** is ad-hoc signed. First launch: right-click **Douya.app → Open**, or run `xattr -dr com.apple.quarantine /Applications/Douya.app`.
- **Windows** is signed with a per-build self-signed certificate. The `.cer` on the release is the **public** cert (the private key never shipped). SmartScreen: More info → Run anyway.
- **Linux** packages are unsigned.

## What the machine must already have

The packaged app is self-contained for startup: it ships the Douya server (`scripts/`, `src/`, `packages/`, `vendor/`), production `node_modules`, and **[dsh](https://github.com/deepseek-ai/dsh)** (`@deepseek-ai/dsh`) inside `resources/app-runtime`. You do **not** need a git checkout, a Node.js install, or a separate dsh. There is no folder picker on a normal first launch.

- On boot, `resolveRepoRoot` prefers the bundled `app-runtime` (before a remembered path, which may be leftover from an older build). The checkout folder picker is only a last-resort fallback if that tree is missing.
- **dsh** is started from `app-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`, using a **vanilla Node 24.22.1** binary also shipped in `app-runtime/node`. (dsh’s native loader rejects Electron 45.2.3’s Node fingerprint; `ELECTRON_RUN_AS_NODE` is only a last-resort fallback.) A user `node` on `PATH` is not required. The dsh picker from earlier builds is kept only as a last-resort fallback.
- Runtime data is **not** written into the install folder (that path is read-only under Program Files). The app sets `ODM_DATA_DIR` and `DSH_HOME` to writable folders under userData, provisions the `odm` profile from the bundle, and reads the login token from `ODM_DATA_DIR/dsh-web.url`.

You also need a **chat model provider** (for example DeepSeek). Connect sources through Composio only if you want them. See the root README’s [First launch](../README.md#first-launch).

On a first launch where no chat model is saved, a **setup wizard** opens and asks only for the model API and, optionally, a Composio project API key. Composio can be skipped. The same wizard is also in Settings. Keys are written to `ODM_DATA_DIR/config.json` (under userData in the packaged app; `.odm-data/config.json` in a source checkout), the same file Settings already uses, and synced into `$DSH_HOME/.credentials.yaml` so dsh can use them without a restart.

## Bundled memory runtime

Each installer includes the official MCP Memory server [`@modelcontextprotocol/server-memory@2.1.1`](https://www.npmjs.com/package/@modelcontextprotocol/server-memory) (MIT; pure Node; no embeddings). dsh launches it with the bundled Node via `dsh-mcp-client`; tools appear as `mcp__memory__*`. The knowledge-graph JSONL is `$ODM_DATA_DIR/memory.jsonl` (under userData in the packaged app). There is no Python, llama.cpp, or GGUF in the package, and nothing is written under `resources/`.

This is **not** a bundled chat model. Chat still needs a supported provider (the first-run wizard). Memory needs no embedding key and no Ollama. More: [memory.md](memory.md).

Chat keeps waiting while a Muse turn is still working, instead of reporting no reply after a short wall-clock timeout. A turn that stays marked `running` can keep you waiting; that is not a guarantee every hang is detected.

## Where config and data live

Two trees matter, and the app does **not** automatically copy or reindex one into the other.

**1. Writable app data** — in the packaged app this is all under userData (never under `resources/app-runtime`, which is read-only on Windows):

| Path | Typical location (packaged) | Source checkout |
| --- | --- | --- |
| `ODM_DATA_DIR` | `userData/odm-data` | `<repo>/.odm-data` |
| `DSH_HOME` | `userData/dsh-odm` | `<repo>/.dsh-odm` |

- `ODM_DATA_DIR/dsh-web.url` — login token URL (do not commit or paste it)
- `ODM_DATA_DIR/config.json` — AI / Composio keys
- `$DSH_HOME/.credentials.yaml` — the model key as dsh's credentials service reads it (`OPENAI_API_KEY`, and `DEEPSEEK_API_KEY` for DeepSeek)
- Host state: `$DSH_HOME/opendigitalmate/state.json` when `ODM_DATA_DIR` is unset; the packaged app writes state next to `config.json` in `ODM_DATA_DIR`

**2. The Electron app userData** (`productName` is Douya):

| OS | Typical userData |
| --- | --- |
| macOS | `~/Library/Application Support/Douya` |
| Windows | `%APPDATA%\Douya` |
| Linux | `~/.config/Douya` |

There you will find `settings.json` (window bounds, and any last-resort remembered paths), `odm-data/` (including `memory.jsonl`, the MCP Memory graph), and `dsh-odm/`. Logs: `~/Library/Logs/Douya` on macOS, or `logs` under userData on Windows and Linux.

**Memory file:** `$ODM_DATA_DIR/memory.jsonl` (override with `MEMORY_FILE_PATH`).

Updates: install the newer `desktop-v*` package over the previous one. Config and memory stay in the locations above unless you delete them yourself.
