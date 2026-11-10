This folder is filled at pack time by `desktop/scripts/bundle-openviking.mjs`.

CI (and a local `npm run bundle:ov` in `desktop/`) downloads a relocatable
CPython from python-build-standalone and installs `openviking` into `py/` + `lib/`.
Those directories are gitignored. The Electron app starts this runtime when
nothing healthy is already listening on `127.0.0.1:1933`.

OpenViking is licensed AGPL-3.0 by Volcano Engine; this bundle does not include
an embedding or VLM model.
