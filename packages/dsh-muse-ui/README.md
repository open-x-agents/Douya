# dsh-muse-ui

Muse (豆芽) Today UI as a DeepSeek Harness client plugin. Replaces the stock dsh web shell and serves the Muse page at `/api/opendigitalmate/app`. Talks to the `opendigitalmate` host plugin’s `/api/opendigitalmate/*` APIs.

## Install (odm profile)

```bash
# from a checkout of openDigitalMate, or after publishing:
dsh plugin --profile odm add link:/path/to/openDigitalMate/packages/dsh-muse-ui
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
| `static-serve.js` | Shared reads/responses for the host half + optional standalone import |
| `cordis.patch.yml` | Mount plugin + disable stock `ui-*` modules |
