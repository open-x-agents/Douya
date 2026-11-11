# Long-term memory (OpenViking)

Douya stores memories on a local [OpenViking](https://docs.openviking.net/en/agent-integrations/17-dsh) server (`viking://~/memories`). The dsh `odm` profile uses [`@openviking/dsh-memory-plugin`](https://www.npmjs.com/package/@openviking/dsh-memory-plugin) (~0.5.33) for auto-recall, session capture, and `mcp__openviking__*` tools. The Memories / Recall page, Chief digest, and Future’s grounding read the same server, achievements first. Forget uses `DELETE /api/v1/fs` (same as MCP `forget`) and also deletes photos stored for that memory.

Pack-time layout of the bundled runtime: [`desktop/resources/openviking/README.md`](../desktop/resources/openviking/README.md). Installer behavior and paths: [install.md](install.md).

## What is bundled, and what is not

Desktop installers include OpenViking 0.5.4, relocatable CPython, `llama-cpp-python`, and the local `bge-small-zh-v1.5-f16` GGUF (sha256 `ab9b81d9cd329c712eee379cf0068eabe6a5e2a01d0def61535eba9384085e2c`). A new app-local `ov.conf` can point at that file so **semantic auto-recall** works without a cloud embedding key and without Ollama. The embedding is Chinese-optimized; English is weaker.

A VLM / chat model is **not** shipped. Chat still needs a supported provider in Settings. Memory extraction and summaries need a VLM in `ov.conf` if you want them. Listing and forgetting memories still work over the filesystem API without a VLM. The app is not promised to work fully offline.

The app does not rebuild existing vectors. Changing embedding model or dimension can make old vector collections incompatible; reindex only if you choose to, by hand. There is no automatic or in-app destructive migration.

## If you already have OpenViking

An existing `~/.openviking/ov.conf` is never rewritten, even when it has no embedding model. The desktop app will reuse a healthy server already on `127.0.0.1:1933` and will not stop a server it did not start. `~/.openviking/ovcli.conf` is written only when that file is missing.

Your existing workspace is not copied into the app-local `userData/openviking/data` directory. Leave the home config in place if you want to keep using that memory store.

## Source-run (`npm start`)

The installers already include the server — skip this section if you are using the packaged Mac, Windows, or Linux app.

```bash
# needs uv; the OpenViking wizard configures models — see the upstream quickstart
uv tool install openviking --upgrade
openviking-server init
openviking-server doctor
openviking-server
# → http://127.0.0.1:1933   curl http://127.0.0.1:1933/health
```

CLI connection (`ovcli.conf`), only if you do not already have one:

```bash
mkdir -p ~/.openviking
cat > ~/.openviking/ovcli.conf <<'JSON'
{ "url": "http://127.0.0.1:1933" }
JSON
```

Remote / managed: set `api_key` (and optional `account` / `user`), or export `OPENVIKING_URL` + `OPENVIKING_API_KEY`.

`scripts/start-dsh.mjs` tries to add `@openviking/dsh-memory-plugin@0.5.33` to the **odm** dsh profile when it is missing (`dsh plugin --profile odm add @openviking/dsh-memory-plugin@0.5.33`). Remove legacy `dsh-memory` from that profile once OpenViking is healthy.

While the server is down, Muse can fall back to the old SQLite `memory.db` for the Glimpse list only. Chat auto-recall needs the server. For a source-run server, semantic auto-recall needs a working embedding — the same local GGUF via `openviking[local-embed]`, Ollama, or a cloud key. `openviking-server doctor` may still warn that a VLM is missing.

## Recall page

Memories render as a short title plus plain sentences (no `viking://` URIs or marker tokens in the tile). Open a tile to read the whole memory. **Add photo** (png / jpeg / gif / webp, ≤ 5 MB) stores the image in OpenViking under `viking://resources/recall/…` and appends a markdown image to the memory, so chat sees the same link. The host only proxies `GET|POST /api/opendigitalmate/memories/image` for those recall resources.
