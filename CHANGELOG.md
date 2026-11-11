# CHANGELOG

This file is written by the daily `v*` workflow (`.github/workflows/release.yml`). The latest stable `v*` tag is [v0.1.0](https://github.com/open-x-agents/openDigitalMate/releases/tag/v0.1.0). Desktop installers are a separate prerelease, **[desktop-v0.1.0-rc7](https://github.com/open-x-agents/openDigitalMate/releases/tag/desktop-v0.1.0-rc7)** — see [docs/release.md](docs/release.md). GitHub “Latest” points at `v0.1.0`, not the desktop packages.

每天一个补丁版本，由 `.github/workflows/release.yml` 发布；条目取自当天的提交标题。

## v0.1.0 — 2026-10-30

- ci: daily release workflow — test gate, patch bump, tag, release
- fix(#7): group text-delta live + PANEL_PAGE_ROUTE under /api (#8)
- fix(#3): default Web composer busyEnter to steer
- fix(#3): channel send defaults to steer while Session is running
- chore: vendor full ds-bot package at f823773
- docs(design): open the dock on load and make its input usable
- docs(design): pin the composer to the window footer in the chat demo
- docs(design): add the chat.html design prototype page
- docs(design): add the demo.html design prototype page
- Initialize opendigitalmate on ds-bot
- Initialize opendigitalmate on ds-bot
- Initial commit
