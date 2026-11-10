This folder is filled at pack time by `desktop/scripts/bundle-openviking.mjs`.

CI (and a local `npm run bundle:ov` in `desktop/`) downloads a relocatable
CPython from python-build-standalone, installs `openviking` and
`llama-cpp-python` into `py/` + `lib/`, and verifies the official OpenViking
local embedding GGUF (`models/bge-small-zh-v1.5-f16.gguf`, 512-d, MIT,
sourced from Hugging Face `CompendiumLabs/bge-small-zh-v1.5-gguf`, itself a
conversion of `BAAI/bge-small-zh-v1.5`). Those runtime directories and the
model file are gitignored. The Electron app starts this runtime when nothing
healthy is already listening on `127.0.0.1:1933`, and a new app-local `ov.conf`
points `embedding.dense.model_path` at the shipped file so the first launch
does not need the network.

OpenViking is licensed AGPL-3.0 by Volcano Engine. The bundled embedding
weights and `llama-cpp-python` are MIT. A VLM / chat model is not included.
