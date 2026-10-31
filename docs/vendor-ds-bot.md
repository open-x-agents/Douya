# Vendored ds-bot (`vendor/ds-bot`)

## Why

`openDigitalMate` is a Feishu plugin that depends on [`ds-bot`](https://github.com/Fei2411/DS-Bot)
as a peer. This repository vendors a full runnable copy of the `ds-bot` package so
in-repo development and review do not require the private `niuypei/DS-Bot` clone.

## Provenance

See `vendor/ds-bot/VENDOR_FROM`:

- Source tree: `/home/box/DS-Bot/ds-bot` (niuypei/DS-Bot, upstream Fei2411/DS-Bot)
- Commit: `f823773b07ec6ca29d60b31c31af30218a68000d`
- Contents: full package (`src/`, `test/`, built `client.js`, etc.); `node_modules` omitted

This migration commit does **not** change ds-bot behavior. Functional fixes land in
follow-up commits on top of this tree.

## How DSH should depend on it

In a DSH profile `package.json`:

```json
{
  "dependencies": {
    "ds-bot": "link:../openDigitalMate/vendor/ds-bot",
    "opendigitalmate": "link:../openDigitalMate"
  }
}
```

Or install/link `vendor/ds-bot` another way that resolves the `ds-bot` package name.
Peer dependency on the root package is `ds-bot >= 0.2.4` (matches the vendored
`package.json` version).

For a local DSH Web profile in Bot mode, use `scripts/setup-opendigitalmate-web.sh`
(`check`, `setup`, `start`) instead of editing the profile by hand. The README
section 「本地 DSH Web（Bot 模式）」 describes the expected `<ROOT>` layout
(`dsh-web.sh` and `deepseek-harness` beside this repo; override with
`DSH_DEV_ROOT`). Three wiring mistakes show up as the wrong UI or an import
failure, and the script checks each of them:

- `bundles` must include `ds-bot`. Insert `opendigitalmate` from
  `cordis.patch.yml`; do not use that plugin as the only bundle.
- `dependencies` must `link:` this checkout's `vendor/ds-bot` and the repo root.
- `vendor/ds-bot` needs its runtime dependency `deep-view` (`npm install --omit=dev`
  in that directory). Without it, ds-bot fails to import.
