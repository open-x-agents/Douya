# Long-term memory (official MCP Memory)

Douya stores memories in a local knowledge graph managed by the official [`@modelcontextprotocol/server-memory`](https://www.npmjs.com/package/@modelcontextprotocol/server-memory) **2.1.1** server (pure Node, JSONL on disk, no embeddings, `engines.node` ≥ 24). The dsh `odm` profile registers it through [`@deepseek-ai/dsh-mcp-client`](https://www.npmjs.com/package/@deepseek-ai/dsh-mcp-client) as stdio MCP, so chat tools appear as `mcp__memory__create_entities`, `mcp__memory__add_observations`, `mcp__memory__search_nodes`, `mcp__memory__read_graph`, `mcp__memory__open_nodes`, and the matching delete tools. The Memories / Recall page, Chief digest, and Future’s grounding read the same JSONL file directly (achievements first). Forget removes one observation, or a whole entity and its relations, with an atomic write.

The graph file is `MEMORY_FILE_PATH`, defaulting to `$ODM_DATA_DIR/memory.jsonl` — a writable data directory (`userData/odm-data` in the packaged app, `.odm-data` for `npm start`). It is never written under `resources/` or Program Files. Search is case-insensitive substring matching over entity names, types, and observations, not semantic retrieval.

Installer and data-dir paths: [install.md](install.md).

## What is bundled, and what is not

Desktop installers include `@modelcontextprotocol/server-memory@2.1.1` next to the bundled official Node **24.22.1**. dsh starts the server with that Node; there is no `npx`, no network at runtime, and no Python, CPython, llama.cpp, or GGUF model. Chat still needs a supported provider in Settings (the first-run wizard). The app is not promised to work fully offline — only memory storage is local and model-free.

Attaching photos to a memory is no longer supported (that feature existed only on OpenViking). The Recall page hides those controls.

## Existing OpenViking memories are not migrated

Memories that lived in an OpenViking workspace (`viking://~/memories`, `userData/openviking/data`, or `~/.openviking`) are **not migrated**. A one-time export is possible by hand but is out of scope here. After this change the app does not start OpenViking, does not read `ov.conf`, and does not talk to port 1933.

## Source-run (`npm start`)

The packaged app already includes the server and Node — skip this section if you are using the installer.

`scripts/start-dsh.mjs` looks for `@modelcontextprotocol/server-memory` under the checkout’s `node_modules` (or a staged `app-runtime`) and writes a `dsh-mcp-client` entry into the `odm` profile’s `cordis.patch.yml`. Install the package once if it is missing:

```bash
npm install @modelcontextprotocol/server-memory@2.1.1
```

Set `MEMORY_FILE_PATH` only if you want a file other than `.odm-data/memory.jsonl`. A missing file is an empty library; it is created on the first successful write.

While the JSONL cannot be read, Muse can fall back to the old SQLite `memory.db` for the Glimpse list only. Chat auto-recall needs the MCP server’s tools.

## Recall page

Memories render as a short title plus plain sentences: each observation on an entity is one tile, with the entity name as the heading and any relations as extra context. Achievements and other high-signal types surface first; everyday preferences stay quieter. If the file cannot be read, Recall shows an unavailable state, not a zero count. A truly empty graph still shows 0. Forget asks for confirmation, then deletes that observation (or the whole entity if it was the last fact).
