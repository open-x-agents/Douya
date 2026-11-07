# Connected-source scans

Connection is not the same as scanning. Gmail, GitHub and Slack retain their source bots; Calendar feeds the timetable. Other verified read recipes produce one compact FYI card per toolkit, without an additional LLM turn. Unsupported and failed connections remain visible in the last-aggregation table.

## Limits and accuracy

- Recent means the last 48 hours; entries without a usable timestamp or HTTP(S) deep link are omitted, never dated as “now”.
- Generic reads sample one page (20 items). Asana and ClickUp discover only the first accessible workspace; Calendly discovers the current user. This is a bounded sample, not a claim of exhaustive coverage.
- Generic recipes have a 10-second total deadline including discovery; late discovery cannot start another request. Auxiliary fetches run at most three toolkits at a time.
- YouTube reads one page of ten subscriptions and one page of twenty activities per channel, at most three channels concurrently, with an eight-second deadline per request. Only upload activities in the last 48 hours become videos; IDs are deduplicated. The status note marks truncated scans.
- Permission, quota, malformed-response and timeout failures are errors, not an empty successful scan. No write actions are used.
- Existing provider scopes may not permit a read even after connecting. This change does not expand permissions.

## Verified action contracts

Action names and input parameter names were checked against the public Composio toolkit markdown documentation (November 7, 2026). These are mocked regression tests, not live-account acceptance checks.

| Toolkit | Read action | Contract |
|---|---|---|
| youtube | `YOUTUBE_LIST_USER_SUBSCRIPTIONS`, `YOUTUBE_GET_CHANNEL_ACTIVITIES` | [YouTube](https://docs.composio.dev/toolkits/youtube.md) |
| asana | `ASANA_SEARCH_TASKS_IN_WORKSPACE` | [asana](https://docs.composio.dev/toolkits/asana.md) |
| clickup | `CLICKUP_GET_FILTERED_TEAM_TASKS` | [clickup](https://docs.composio.dev/toolkits/clickup.md) |
| calendly | `CALENDLY_LIST_EVENTS` | [calendly](https://docs.composio.dev/toolkits/calendly.md) |
| notion | `NOTION_SEARCH_NOTION_PAGE` | [notion](https://docs.composio.dev/toolkits/notion.md) |
| linear | `LINEAR_LIST_LINEAR_ISSUES` | [linear](https://docs.composio.dev/toolkits/linear.md) |
| jira | `JIRA_SEARCH_FOR_ISSUES_USING_JQL_GET` | [jira](https://docs.composio.dev/toolkits/jira.md) |
| gitlab | `GITLAB_LIST_ISSUES` | [gitlab](https://docs.composio.dev/toolkits/gitlab.md) |
| googledrive | `GOOGLEDRIVE_LIST_FILES` | [googledrive](https://docs.composio.dev/toolkits/googledrive.md) |
| googledocs | `GOOGLEDOCS_SEARCH_DOCUMENTS` | [googledocs](https://docs.composio.dev/toolkits/googledocs.md) |
| googlesheets | `GOOGLESHEETS_SEARCH_SPREADSHEETS` | [googlesheets](https://docs.composio.dev/toolkits/googlesheets.md) |
| outlook | `OUTLOOK_LIST_MESSAGES` | [outlook](https://docs.composio.dev/toolkits/outlook.md) |
| microsoft_teams | `MICROSOFT_TEAMS_LIST_CHAT` | [microsoft_teams](https://docs.composio.dev/toolkits/microsoft_teams.md) |
| reddit | `REDDIT_LIST_INBOX_MESSAGES` | [reddit](https://docs.composio.dev/toolkits/reddit.md) |
| twitter | `TWITTER_USER_HOME_TIMELINE_BY_USER_ID` | [twitter](https://docs.composio.dev/toolkits/twitter.md) |
| strava | `STRAVA_LIST_ATHLETE_ACTIVITIES` | [strava](https://docs.composio.dev/toolkits/strava.md) |
| spotify | `SPOTIFY_GET_RECENTLY_PLAYED_TRACKS` | [spotify](https://docs.composio.dev/toolkits/spotify.md) |
| one_drive | `ONE_DRIVE_GET_RECENT_ITEMS` | [one_drive](https://docs.composio.dev/toolkits/one_drive.md) |
| coda | `CODA_LIST_AVAILABLE_DOCS` | [coda](https://docs.composio.dev/toolkits/coda.md) |
| box | `BOX_LIST_RECENTLY_ACCESSED_ITEMS` | [box](https://docs.composio.dev/toolkits/box.md) |
| onenote | `ONENOTE_GET_RECENT_NOTEBOOKS` | [onenote](https://docs.composio.dev/toolkits/onenote.md) |
| zoom | `ZOOM_LIST_MEETINGS` | [zoom](https://docs.composio.dev/toolkits/zoom.md) |
| confluence | `CONFLUENCE_SEARCH_CONTENT` | [confluence](https://docs.composio.dev/toolkits/confluence.md) |
| todoist | `TODOIST_LIST_ACTIVITIES` | [todoist](https://docs.composio.dev/toolkits/todoist.md) |
| trello | `TRELLO_GET_SEARCH` | [trello](https://docs.composio.dev/toolkits/trello.md) |
| miro | `MIRO_GET_BOARDS` | [miro](https://docs.composio.dev/toolkits/miro.md) |
| instagram | `INSTAGRAM_GET_USER_MEDIA` | [instagram](https://docs.composio.dev/toolkits/instagram.md) |
| googletasks | `GOOGLETASKS_LIST_ALL_TASKS` | [googletasks](https://docs.composio.dev/toolkits/googletasks.md) |

Discovery uses `ASANA_GET_MULTIPLE_WORKSPACES`, `CLICKUP_AUTHORIZATION_GET_WORK_SPACE_LIST`, and `CALENDLY_GET_USER`, from the same toolkit references.

## Connected but not scanned

The recipe table intentionally does not mistake organization/member/file-directory listings for recent content. The following catalog entries need a narrower scope or a different ingestion path; they show an explicit not-scanned row instead of silently disappearing:

- **discord:** OAuth toolkit has no message-history read action.
- **telegram:** Chat ID required; polling bot updates could interfere with webhook delivery.
- **whatsapp:** Inbound messages require webhook delivery.
- **linkedin:** No account-wide recent feed action.
- **figma:** Team or file ID required.
- **airtable:** Base, table and timestamp-field configuration required.
- **dropbox:** Folder scope and real shared links required.
- **hubspot:** Portal-specific record deep links required.
- **monday:** Board scope required.
- **basecamp:** Account scope required.
- **hackernews:** Search query required; not a personal subscription feed.

Any newly connected toolkit with no verified recipe gets the same visible status. Add recipes only after checking the provider contract, response timestamp and real deep-link fields.
