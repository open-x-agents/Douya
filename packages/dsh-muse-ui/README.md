# dsh-muse-ui

Muse (豆芽) shell as a DeepSeek Harness client plugin.

Replaces the stock dsh web shell and serves Muse at `/api/opendigitalmate/app`. Talks to the `opendigitalmate` host plugin’s `/api/opendigitalmate/*` APIs.

## Product shape

| Page | Role |
| --- | --- |
| **Today** | Current affairs — finish something, state writes back |
| **Memories / Recall** | Readable recalls & achievements (official MCP Memory) |
| **Sources / Settings** | Connect apps, keys, language, digest prefs |
| **Future / 未来** | Long-term plans from interests — consent first; propose, then accept |

Shared memory under everything: Muse UI ↔ Chief/bots ↔ MCP Memory ↔ Sources.

## Install (odm profile)

```bash
# from a checkout of Douya, or after publishing:
dsh plugin --profile odm add link:/path/to/Douya/packages/dsh-muse-ui
# package.json dsh.profile.bundles should list "dsh-muse-ui"
# keep "opendigitalmate" for the API/digest host
```

Restart dsh. Opening the token URL should land on Muse, not the stock shell.

## Layout

| Path | Role |
| --- | --- |
| `client.js` | Redirect stock shell → `/api/opendigitalmate/app` |
| `index.js` | Serve Muse HTML, `ui-renderer.js`, brand logos |
| `static/` | Muse assets (EN/中文 i18n in the page) |
| `memory-present.js` | Strip machine markup → human title + sentences for Recall tiles |
| `static-serve.js` | Shared reads/responses for the host half + optional standalone import |
| `cordis.patch.yml` | Mount plugin + disable stock `ui-*` modules |
