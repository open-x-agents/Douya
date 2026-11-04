# LLM / Chat setup (dsh Muse)

Chat goes through **ds-bot Chief** inside `dsh --profile odm`, not the old standalone `scripts/server.js` ask loop.

## What must be set

1. **Provider key in the dsh process**
   - DeepSeek → `DEEPSEEK_API_KEY`
   - Muse digest LLM also uses `OPENAI_API_KEY` + `OPENAI_BASE_URL` (OpenAI-compatible)
2. **Default model** in `$DSH_HOME/settings.yaml` (`agent-default-model`, usually `deepseek` / `deepseek-chat`)
3. **Login cookie**: open the `?token=…` URL from `.odm-data/dsh-web.url` (plain `http://127.0.0.1:7777` → 401)

`npm start` (`scripts/start-dsh.mjs`) reads `.odm-data/config.json`, calls `applyLlmEnv` (exports both keys for DeepSeek), and ensures `settings.yaml`. Saving **配置 → AI 模型** also applies env live in the same process so you usually do not need a restart.

## Fresh DeepSeek + Composio

```bash
npm install
npm start
open "$(cat .odm-data/dsh-web.url)"
# 配置 → DeepSeek + API Key → 保存 → 测试连接
# 配置 → Composio → 保存并连接信源
# 今天页对话框发一句「你好」
```

If chat still says nothing: check the bubble for `没有可用的模型` / `No model is available` / `登录已失效`; confirm `echo ${DEEPSEEK_API_KEY:+set}` after a restart, or re-save the model in 配置.

## Config file shape

`.odm-data/config.json`:

```json
{
  "llm": {
    "provider": "deepseek",
    "apiKey": "sk-…",
    "model": "deepseek-chat",
    "baseURL": "https://api.deepseek.com/v1"
  },
  "composioApiKey": "…",
  "composioEntityId": "default"
}
```

## Standalone server.js

`npm run start:standalone` / `scripts/server.js` is the older Muse-only path. Prefer `npm start` for real Chief chat.
