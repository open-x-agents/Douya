# Install the desktop app

Douya / 豆芽 is an Electron shell around a local dsh server. This page is the packaged app: download, first launch, signing, and where data lives. To run from a git checkout only, see [develop.md](develop.md) and the root [README](../README.md#run-from-source).

## Which release to download

Use **[desktop-v0.1.0-rc7](https://github.com/open-x-agents/openDigitalMate/releases/tag/desktop-v0.1.0-rc7)** (prerelease, commit `92d751b034ccb19b556afbf2a8ff9ee5c2f6d5aa`).

GitHub’s **[Latest](https://github.com/open-x-agents/openDigitalMate/releases/latest)** release is **[v0.1.0](https://github.com/open-x-agents/openDigitalMate/releases/tag/v0.1.0)** (2026-10-30). That is the last stable `v*` source/tag from the daily `release.yml` workflow. It does **not** contain Windows, macOS, or Linux installers. Do not treat Latest as the desktop app.

Verify downloads with [SHA256SUMS](https://github.com/open-x-agents/openDigitalMate/releases/download/desktop-v0.1.0-rc7/SHA256SUMS) on that same prerelease.

## Packages

| Platform | Arch | Download |
| --- | --- | --- |
| Windows | x64 | [Douya-0.1.0-win-x64-Setup.exe](https://github.com/open-x-agents/openDigitalMate/releases/download/desktop-v0.1.0-rc7/Douya-0.1.0-win-x64-Setup.exe) and the public [Douya-0.1.0-win-x64-selfsigned.cer](https://github.com/open-x-agents/openDigitalMate/releases/download/desktop-v0.1.0-rc7/Douya-0.1.0-win-x64-selfsigned.cer) |
| macOS | arm64 (Apple Silicon) | [Douya-0.1.0-mac-arm64.dmg](https://github.com/open-x-agents/openDigitalMate/releases/download/desktop-v0.1.0-rc7/Douya-0.1.0-mac-arm64.dmg) |
| macOS | x64 (Intel) | [Douya-0.1.0-mac-x64.dmg](https://github.com/open-x-agents/openDigitalMate/releases/download/desktop-v0.1.0-rc7/Douya-0.1.0-mac-x64.dmg) |
| Linux | x64 | [Douya-0.1.0-linux-x64.AppImage](https://github.com/open-x-agents/openDigitalMate/releases/download/desktop-v0.1.0-rc7/Douya-0.1.0-linux-x64.AppImage) **or** [douya-desktop_0.1.0_amd64.deb](https://github.com/open-x-agents/openDigitalMate/releases/download/desktop-v0.1.0-rc7/douya-desktop_0.1.0_amd64.deb) |
| Linux | arm64 | [Douya-0.1.0-linux-arm64.AppImage](https://github.com/open-x-agents/openDigitalMate/releases/download/desktop-v0.1.0-rc7/Douya-0.1.0-linux-arm64.AppImage) **or** [douya-desktop_0.1.0_arm64.deb](https://github.com/open-x-agents/openDigitalMate/releases/download/desktop-v0.1.0-rc7/douya-desktop_0.1.0_arm64.deb) |

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

The Electron window is only a shell, not a self-contained server.

- A **checkout of this repo is always required.** `boot()` calls `pickRepoRoot()` and quits if it cannot find a folder that contains `scripts/start-dsh.mjs` (`isRepoRoot`). It checks `ODM_ROOT`, a remembered path in userData `settings.json`, `~/Documents/git/openDigitalMate`, then `~/openDigitalMate`; otherwise it asks once and remembers. Even when it reuses an already-running server, it still reads the login token from `<repo>/.odm-data/dsh-web.url`.
- **[dsh](https://github.com/deepseek-ai/dsh) is required to start the server.** If `127.0.0.1:7777` already has a working token, the app reuses that process. Otherwise it runs `scripts/start-dsh.mjs` from the checkout (`desktop/src/main.js` `startServer`) and stops only that child on quit. The start script spawns `dsh --profile odm --no-open --port …`. The shell sets `DSH_BIN` from `$DSH_BIN`, a remembered path, or `~/Documents/git/dsh-rc5/bin/dsh` when that file exists; then `dsh` on `PATH`. If none of those exist, the app asks once for the dsh executable and remembers it, instead of starting a server that would exit before it is ready.
- **A separate Node.js install is not required.** `startServer` prefers `node` on `PATH` (plus the login-shell PATH so GUI launches can see it). If none is found, it runs the start script with Electron’s bundled Node (`process.execPath` and `ELECTRON_RUN_AS_NODE=1`). `start-dsh.mjs` may still call `npm install` only when `vendor/ds-bot` is missing `deep-view`.

You also need a **chat model provider** (for example DeepSeek) in Settings. Connect sources through Composio only if you want them. See the root README’s [Configure AI + Composio](../README.md#configure-ai--composio).

## Bundled memory runtime

Each installer includes OpenViking **0.5.4**, relocatable CPython 3.13.18, `llama-cpp-python` 0.3.36, and the official `bge-small-zh-v1.5-f16` GGUF (MIT, 512-d, sha256 `ab9b81d9cd329c712eee379cf0068eabe6a5e2a01d0def61535eba9384085e2c`). The OpenViking runtime is AGPL-3.0 (upstream).

If `127.0.0.1:1933/health` is already healthy, the app reuses that server and does not stop it on quit. Otherwise it starts the bundled server, points a **new** app-local config at the shipped GGUF, and stops only the process it started. Semantic auto-recall can then work offline with **no cloud key and no Ollama**. The model is Chinese-optimized; English is weaker.

This is **not** a bundled chat or VLM model. Chat still needs a supported provider. Memory extraction and summaries need a VLM in `ov.conf` if you want them. The whole app is not promised to work offline.

This rc keeps waiting while a Muse turn is still working, instead of reporting no reply after a short wall-clock timeout. A turn that stays marked `running` can keep you waiting; that is not a guarantee every hang is detected.

You do not need to install `uv` or `openviking` separately for the packaged app. More: [memory.md](memory.md).

## Where config and data live

Two trees matter, and the app does **not** automatically copy or reindex one into the other.

**1. The repo checkout** (source-run and packaged app share this once the app has found the folder):

- `.odm-data/dsh-web.url` — login token URL (do not commit or paste it)
- `.odm-data/config.json` — optional AI / Composio keys
- Future plans and host state: `$DSH_HOME/opendigitalmate/state.json` (or the configured dsh host home)

**2. The Electron app userData** (`productName` is Douya):

| OS | Typical userData |
| --- | --- |
| macOS | `~/Library/Application Support/Douya` |
| Windows | `%APPDATA%\Douya` |
| Linux | `~/.config/Douya` |

There you will find `settings.json` (remembered repo path, window bounds) and, when the app starts its own OpenViking, `openviking/ov.conf` plus `openviking/data`. Logs: `~/Library/Logs/Douya` on macOS, or `logs` under userData on Windows and Linux.

**OpenViking config choice** (the app never overwrites a home config):

- If `~/.openviking/ov.conf` already exists, that file and its workspace are used as-is, even if they do not name the bundled GGUF.
- Otherwise the app writes `userData/openviking/ov.conf` (and `userData/openviking/data`) and can point a new or embedding-less app-local conf at the shipped GGUF.
- `~/.openviking/ovcli.conf` is created only when missing, so the memory plugin can reach `http://127.0.0.1:1933`. An existing `ovcli.conf` is left alone.

A source-run server you already set up under `~/.openviking` is therefore kept. A brand-new packaged install without that home file uses the app-local data directory — that is a **different** workspace, not a silent migration. The app does not rebuild existing vectors and does not ship a destructive reindex or wipe command. Do not run `ov reindex … --force` unless you have decided to.

Updates: install the newer `desktop-v*` package over the previous one. Config and memory stay in the locations above unless you delete them yourself.
