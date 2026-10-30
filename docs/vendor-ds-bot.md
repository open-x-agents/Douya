# Vendored ds-bot (`vendor/ds-bot`)

## Why

`openDigitalMate` is a Feishu plugin that historically depended on `ds-bot` as a peer.
Issue [#3](https://github.com/open-x-agents/openDigitalMate/issues/3) needs fixes inside
ds-bot itself (group chat live streaming + plugin `send` mode `queue|steer`). Per product
direction, those fixes land **in this repository**, not in the private `niuypei/DS-Bot` fork.

## Layout

```
vendor/ds-bot/          full ds-bot package (runnable; `link:`-able)
  VENDOR_FROM           source SHA (f823773) and policy note
  src/host/…            channel / groups / feed / turns …
  src/client/…          GroupMessage / GroupReplies …
  src/shared/           send-mode.js, room-draft.js (issue #3 helpers)
  client.js             built browser bundle (`npm run build`)
  test/                 existing ds-bot tests + issue #3 unit tests
```

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

Or publish/version the vendored package as `ds-bot@0.2.5` from this tree. Peer dependency
on the root package is `ds-bot >= 0.2.5`.

## Issue #3 patch summary

1. **Send mode** — `channel.js` `send` accepts `queue|steer` (from voice / New Chat /
   `team-actions.send`). When omitted and the Session is `running`, default is **steer**.
2. **Group live draft** — `agent/assistant-stream` text-delta for a speaking room member
   fills `round.draft`; `room-progress` returns it; `GroupReplies` renders a streaming
   `GroupMessage`. On post, draft is cleared / deduped so the final bubble is not doubled.
3. **DM streaming** — `AssistantCell` path unchanged.
4. **Bot↔Bot hidden turns** — still excluded (not `speaking` in a room round; feed still
   skips `exchangeTurns`).
