# LLM / Chat setup (dsh Muse)

For install and first-run, start at the root [README](../README.md). This page is only the model and config files.

Chat goes through **ds-bot Chief** inside `dsh --profile odm`, not the old standalone `scripts/server.js` ask loop.

## What must be set

1. **Provider key in dsh's credential store** (`$DSH_HOME/.credentials.yaml`, mode `0600`)
   - The odm DeepSeek profile resolves `OPENAI_API_KEY`; DeepSeek's native ref is `DEEPSEEK_API_KEY`. The wizard and Settings write both.
   - Muse digest LLM also uses `OPENAI_API_KEY` + `OPENAI_BASE_URL` (OpenAI-compatible)
   - Writing only `.odm-data/config.json` or `process.env` after dsh has started is not enough: dsh snapshots the launch environment and ignores later `process.env` changes.
2. **Default model** in `$DSH_HOME/settings.yaml` (`agent-default-model`, usually `deepseek` / `deepseek-flash`). `deepseek-flash` is the current DeepSeek API id (DeepSeek-V4.1-Flash). `deepseek-chat` is a retired alias.
3. **Login cookie**: open the `?token=…` URL from `.odm-data/dsh-web.url` (plain `http://127.0.0.1:7777` → 401)

`npm start` (`scripts/start-dsh.mjs`) and **配置 / the setup wizard** (`POST /api/llm/config`) call `syncLlmToDsh`, which writes the key into `.credentials.yaml` (watched and hot-reloaded, so a new key takes effect without a restart) and refreshes `settings.yaml`. A custom OpenAI-compatible base URL is written as an `llm-pi-ai` provider route, merged into any existing providers (a blank line in the block is fine). Switching back to official DeepSeek removes a stale `deepseek` route so the odm profile wins. An inline empty `refs: {}` in `.credentials.yaml` still receives the key.

## Fresh DeepSeek + Composio

```bash
npm install
npm start
open "$(cat .odm-data/dsh-web.url)"
# First run: the setup wizard asks for the model and an optional Composio project key
# (or 配置 → DeepSeek + API Key → 保存 → 测试连接, then Composio)
# 今天页对话框发一句「你好」
```

If chat still says nothing: the bubble should name the reason (a missing key points at [设置](#setup)). Confirm `$DSH_HOME/.credentials.yaml` has a `refs.OPENAI_API_KEY` entry, or re-save the model in 配置 / the setup wizard.

## Config file shape

`.odm-data/config.json`:

```json
{
  "llm": {
    "provider": "deepseek",
    "apiKey": "sk-…",
    "model": "deepseek-flash",
    "baseURL": "https://api.deepseek.com/v1"
  },
  "composioApiKey": "…",
  "composioEntityId": "default"
}
```

## Standalone server.js

`npm run start:standalone` / `scripts/server.js` is the older Muse-only path. Prefer `npm start` for real Chief chat.
