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

## Patches

This vendored tree carries fixes made in this repository on top of the commit above:

- **#56 — a group-wide stop empties the group Session's inbox of its relays.** New
  `src/host/group-stop.js` (`isRoomRelay` / `relayMessages` / `relayText` / `relayFiles` /
  `postLine`) plus `dropRoomRelays` in `src/host/groups.js`, called at the end of
  `stopRoomWork`. Spec and regression cases: issue #56,
  `acceptance-cases/group-stop/`, `test/group-stop.test.js`.


## Dependencies of the vendored package

`ds-bot` depends on `deep-view`. When a DSH profile uses
`"ds-bot": "link:…/vendor/ds-bot"`, Node resolves that import from the **real**
path of `vendor/ds-bot`, not from the profile's `node_modules`. Listing
`deep-view` only in the profile is not enough on its own.

After clone (and whenever `vendor/ds-bot/node_modules/deep-view` is missing):

```bash
npm install --prefix vendor/ds-bot
```

`npm start` / `scripts/start-dsh.mjs` runs the same install automatically when
the marker package is absent. `vendor/ds-bot/node_modules/` stays gitignored.

Without this step the host logs `bot (ds-bot): failed to import` /
`Cannot find package 'deep-view'` and the live UI is a bare DeepSeek Harness
shell without the ds-bot team chrome.

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
