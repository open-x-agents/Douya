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
