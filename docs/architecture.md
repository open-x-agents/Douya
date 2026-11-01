# 架构

opendigitalmate 不是另起一个服务，而是 **ds-bot 的一个插件**：ds-bot 负责机器人、会话、模型和存储，这里只加「飞书这个入口」和「日历 / 日报这个业务」。

## 位置

```
DSH（DeepSeek Harness）
└── ds-bot 插件（Bot 团队：roster / turns / groups / connectors）
    └── opendigitalmate 插件（本项目）
        ├── 飞书卡片发送        src/host/feishu.js
        ├── 日报组装 + 卡片      src/host/report.js, cards.js
        ├── 日程提醒规划 + 投递  src/host/reminders.js, index.js
        ├── 面板接口 + 页面      src/host/panel.js, src/client/panel.html
        ├── 面板坏状态（纯函数） src/host/panel-states.js
        └── 状态                 <DSH_HOME>/opendigitalmate/state.json
```

飞书的**入口**已经存在：FlyBot 的 `core/src/host/feishu-inbound.js`（长连接、事件去重环、连接状态）和 `feishu-sdk.js`（`@larksuiteoapi/node-sdk` 的适配）。本项目不重复实现入站，只补出站：发卡片、更新卡片、收按钮回调。

## 数据形状

`state.json`（原子写：临时文件 + rename）：

| 键 | 内容 |
| --- | --- |
| `members` | `{ [id]: { id, name, active } }` |
| `reports` | `{ "memberId:YYYY-MM-DD": report }` |
| `sent` | `{ "eventId@fireAt": ISO }` —— 已投递的提醒 |
| `manual` | 推迟后重新入队的提醒 |
| `done` | `{ eventId: ISO }` |
| `upcoming` | 最近一次 tick 算出的计划（面板读它） |
| `deliveries` | 最近 200 条投递结果，成功和失败都在 |
| `days` | `{ "YYYY-MM-DD": day }` —— 按**本地日**（不是 UTC 日）的一天；面板读 `state.days[today]` |
| `sources` | `{ [源]: { connected, last_read_at, detail, error } }` —— 每个信源最后读到了什么；`connected` 三态：`true` 读了、`false` 没连上、`null`/缺失 = 还不知道 |
| `week` | `[{ day, closed, dropped }]` —— 周结算用的每日减法，只放真有记录的本地日 |
| `prefs` | `{ brevity{level, since_day}, weekend_send }` —— 长短与周末偏好；`state.prefs` 改一次立刻生效 |

day 的形状（本仓库的中间契约；#9 合入后由事件派生，只改 `panelData()` 的映射，渲染函数不动）：

```json
{
  "day": "2026-10-30",
  "time_zone": "Asia/Shanghai",
  "conclusion": "一句话结论；缺失/没读到就写「还没读到今天的结论」，不编",
  "meeting_hours": 3,
  "events": [{
    "id": "evt_1", "kind": "thread", "title": "...", "state": "open | closed | waiting_other | unknown",
    "due_at": "UTC 时刻或 null", "due_kind": "hard | soft | null",
    "who": { "people": ["..."], "waiting_on": "name | null" },
    "sources": [{ "ref": "...", "source": "gcal | gmail | feishu_doc | feishu_cal | feishu_msg | github", "at": "...", "excerpt": "..." }],
    "defer": null, "closure": { "by": "...", "at": "...", "evidence_ref": "..." }
  }],
  "materials": {}
}
```

面板只读 `state.days` / `state.sources` / `state.week` / `state.prefs`，不生产事：`panelData()` 把 store 里没有的字段一律标成 `null`（页面上写「未知」），从不补 0；`days[today]` 不存在或既无结论又无事时画空日（「今天没有必须今天的事」），首屏没有数字节点；当天存在但关掉 0 件时显示真的 `0`。事卡的 `sources` 里有一条落在 `sources.<源>.connected !== true`，这张卡就画虚线琥珀边，并写「<源>没连上，这条只有<其它>依据」；没有活源时写「这条没有依据」。抬头写同一件事：`已读：…；未连：…；未读到：… 的状态`。

report 的形状：`{ date, memberId, memberName, schedule[], done[], plan[], notes, stats{meetings, meetingMinutes, done, planned} }`。

## 四条流程

**提醒**：`calendar()` 给事件 → `planFor()` 算 `fireAt = start - leadMinutes` → `tick()` 取 `due()` → 发卡片 → 成功才写进 `sent`。失败留在未发状态，下一次 tick 重试，投递记录进 `deliveries`。定时器只在最近一个 `fireAt` 醒来，不是每分钟轮询。

每次 `tick()` 也把这次日历读到什么写进 `state.sources.feishu_cal`：返回非数组、`null` 或抛错 = 没连上，页面据此降级，而不是画成「今天没有会」。

**日报**：`recordReport()` 存一条 → `dailyReportCard()` 出卡片 → `sendReportCard()` 推给本人或群。面板按 `memberId:date` 统计提交率。日键取**本地日**（`localDay(now, timeZone)`），上海凌晨的早报不会落到昨天。

**交互**：飞书把按钮回调 POST 到 `/api/opendigitalmate/card` → `readAction()` 只接受自己发的卡片（`k` ∈ {report, reminder}，`op` ∈ 已知 5 个）→ 改一条记录 → 返回 toast。

**面板**：`/api/opendigitalmate/page` 读 `src/client/panel.html` 外壳，把 `<!--panel:body-->` 换成服务端渲染的七幕页面；页面不带脚本、不带外链、不发任何请求，只读本机 `state.json`，不写飞书 / 日历 / 文档。

## 归一化与去重（#13）

同一件事出现在三个信源里，仍然是一条事、一张卡、多条证据。归并在内存里做，规则说了算，模型不参与合并。

| 键 | 规则 | 结果 |
| --- | --- | --- |
| 硬键 | 外部 ID：`gcal:event/<id>`、`gmail:thread/<id>`、`doc:<token>`、`github:pr\|issue/<n>`；没有外部 ID 就没有硬键 | 一定合并，confidence 0.95 |
| 强软键 | 归一化标题相同（去扩展名、`_vN` / ` vN`、大小写与标点）+ 项目相同 + 人物有交集 + 两两间隔 ≤48h | 合并，confidence 0.8 |
| 弱软键 | 只有标题相同 | **不合并**：两张卡各自带 `maybe_same`，confidence 0.5 |

- `confidence < 0.6` 不合并：合错了会丢证据，多一张卡只是多看一行。
- 事件形状：`{ id, kind, title, state, due_at, due_kind, who, project, sources[], confidence, maybe_same[] }`。`id = 'evt_' + sha1(组内最早硬键，无硬键则 标题@项目).slice(0,10)`；归并前先按 `at`、`ref` 排序，所以输入顺序不影响 id、排序与数字。
- `sources[]` 每条是一次观察：`{ ref, source, at, due_at, due_kind, amount, state, excerpt }`。
- 一个字段各源都给且一致才取那个值；不一致就落 `unknown` / `null` —— `null` 不是 0，并列的值留给冲突层（#13 后续切片）。
- `kind` 由信源决定：有日历是 `meeting`，否则有云文档是 `document`，否则 `thread`。
- `subtractStats(events, { day, tz })` 的 `closed` / `dropped` / `waiting` 由事件重算；`day` 走 `Intl.DateTimeFormat('en-CA', { timeZone: tz })`，不读进程 `TZ`。`dropped` 认 `defer`，`closed` 的「关掉必须有出处」随 #13 第 3 步收紧。
- 只读边界：`src/host/normalize.js` 不联网、不写盘、不读环境变量；夹具在 `test/fixtures/`，用例在 `test/normalize.test.js`。

## 面板坏状态（#15）

`src/host/panel-states.js` 是一层纯函数：事件 + `state.sources` 进，卡片片段出；不读时钟、不读盘、不联网。七幕页面本身归 #33，这里只定「坏掉的时候画成什么样」。

| 状态 | 判定 | 画法 |
| --- | --- | --- |
| 缺源 | `state.sources[name].connected !== true` | 事卡虚线琥珀边（`SRCLESS_STYLE = border:1px dashed #c8862a`）+「<源>没连上，这条只有<活源>依据」 |
| 读失败 | `connected === true` 且记录里带错误（`last_error`；tick 写的是 `error`，`sourceHealth()` 两个字段都认） | 红色实线（`READFAIL_STYLE`，`#c0392b`），**不是**琥珀；红只给「连上了但读失败」 |
| 部分失败 | 有一件事的全部源都没取到 | 页面 banner「N 项未取到」（`bannerText()` / `renderBanner()`）；同页其余事照常出 |
| 一件活源都没有 | 全部源都是死源 / 读失败 / 没有源 | 固定句式「这条我答不了，缺的是 X。」；不给动作按钮 |

- 首屏的三种空态文案必须分开：空日（「今天没有必须今天的事」）、周末（「周末不打扰，今天不推」，偏好开 `weekend_send` 时写「周末也照常发」）、第一天（「这是第一天，还没有基线」）。空日不画数字节点（`data-numbers` 计数为 0）。
- 「太长了」由 `state.prefs.brevity.since_day` 决定：`since_day <= 当天` 时 `badStates().brief === true`。首屏按偏好变短、并在卡末回一行「已按你说的改了」的排版归 #15 的下一刀（`renderDay`），这一刀只出判定。
- 数字与结论只认重算值：`closed` 是 0 就打印 `0`，不写「未知」；`renderNumbers()` 的三个数字带口径（件在手 / 会议 / 件在等别人），`renderConclusion()` 写「今天关掉 N 件，M 件在等别人」。
- 每条卡片断言都带 `data-evidence="<ref>"`，`ref` 是来源自己的 id，形如 `<source>:<id>`（`gmail:thread/9`、`feishu_cal:event/77`、`github:pr/42`）；承载证据的 `<details class="evi" id="ev-<eventId>">` 可点开后追到同一条事件的 `sources[]`。一张卡最多一个 `data-act`。
- 夹具：`test/fixtures/panel-five.json` 一份 `base_events`（8 条，覆盖 open / waiting_other / 改过时间 / 已关）+ `normal / empty / srcless / partial / weekend` 五场景 + 一个 brevity 对照日；用例在 `test/panel-states.test.js`。

## Composio 多 app（#32）

一个数字同事同时接多个 app（首批 `gmail`、`googlecalendar`、`notion`、`slack`）。骨架是
`src/sources/composio/registry.js` 的一张表：**一个 app 一行**，`{ toolkit, label, adapter, actions[], readScope }`。
加一个 app 只许改三处——注册表一行、`src/sources/composio/<app>.js` 一个适配器、
`test/composio/<app>.contract.test.js` 一份契约测试；`report.js` / `cards.js` / 面板不改（要改它们，就说明这张表没做对）。
`labelOf()` 从这里出中文名，面板不认具体的 app 名。

**只读白名单。** 每行 `actions[]` 只放读动作。只读判定**只看 tag**：`tags` 含 `readOnlyHint` 且
`is_deprecated !== true` 才算读，名字不算——`GOOGLECALENDAR_CALENDAR_LIST_INSERT` 名字像读、实际是写，
`LINEAR_CREATE_LINEAR_ISSUE_DETAILS` 名字像写、实际是读。快照在 `src/sources/composio/capabilities.js`：
`at` 是取得时间，`visible` / `read_only_tagged` 是当次 `/tools` 的实数，撞 `limit` 记 `capped: true`
（slack 今天 100 是截断）；不存 `tools_count`（那是 toolkit 版本总数，gmail 61，不是可用动作数）。
`isReadOnly()` 只认名单，**不在名单里一律判假**（fail-closed，不猜名字）。
`assertReadOnlyRegistry()` 在 `createRuntime()` 返回之前跑：任一行任一动作不是读动作或不在快照里就同步抛
`E_WRITE_ACTION`——**启动失败**，不是一条告警。`node scripts/composio-check.mjs [--registry <file>]` 是同一个校验的 CLI 形态。

**按人授权（S2）。** 每个 app × 每个人一个 connected account，状态 `ok | missing | expired | ambiguous | scope`；
解析键是 `(toolkit, userId)`，账号表必须用复数参数 `toolkit_slugs` / `user_ids` 取（单数参数会被静默忽略，
「按人」会悄悄变成「按所有人」）。`src/sources/composio/accounts.js` 是纯函数（账号表由调用方传，不联网）：
`resolveAccount(accounts, { toolkit, userId })` 给出 `{ state, reason, account_id }`——恰好 1 个 ACTIVE 是 `ok`；
没给 `userId` 是 `missing`/`no-person`，这个人名下没有账号是 `missing`/`no-account`（有账号但还没连好的
`INITIALIZING` 也算这里）；只有 EXPIRED 是 `expired`/`expired`；同一 (toolkit,user) 有 2 个以上 ACTIVE 是
`ambiguous`、`account_id` 恒为 `null`，**绝不允许静默挑一个**。`authOf()` 把它折成适配器契约要的 `{ ok, reason }`
（`reason` 用 `state` 的值，`ambiguous` 也是合法的 reason）。`scope` 不由账号表判：账号是好的、只是子请求被 403
`insufficientPermissions` 拒了，由 `authReasonOf(error)` 得出——那是少了权限，不是 `missing`。
掉一个 app 时该源进 `unread_sources`，早报照出并点名缺的是哪个 app。

**控制面（S3）。** `src/sources/composio/api.js` 是 v3 控制面的纯传输层：`listTools` / `listAccounts` /
`proxyGet` / `executeTool`，不认识任何 app 的字段，key 只从调用方传入（不进日志、不进仓库、不进错误消息）。
账号表只用复数参数 `toolkit_slugs` + `user_ids` 取（单数参数会被服务端静默忽略、回全部 30 条），
传单数 `toolkitSlug` / `userId` 或只给 app 不给「人」都在发请求之前抛 `E_ACCOUNT_QUERY`。对第三方的读请求
一律 `POST /tools/execute/proxy` 且 body 里 `method: 'GET'`——第三方永远只收到 GET；除 `/tools/execute/`
之外一个 POST 都没有。`callError()` 把 401 / 403 / 404 / 429 / 5xx 分类成 `{ kind, status, reason }`：
403 + `insufficientPermissions` 记 `scope`，限流记 `rate_limit`（`retry_after_ms` 挂在错误上），
5xx 记 `server`，请求没发出去记 `network`——不把「限流」和「服务器坏了」混成同一条，调用方才好决定
是重试、等一会儿，还是让该源 partial。

**多源同时在线（S4 起）。** 每个 app 单独一个 3 秒预算，超时只让该源 `partial`（记 `latency_ms`），
其它 app 照常进早报。每条 fact 的证据 ref 固定为 `composio:<toolkit>:<object>/<record_id>`，
面板上的 `data-evidence` 原样指向输入里存在的记录。

**冲突（S5 起）。** 两个 app 对同一件事给出不同时间时，`conflicts` 并列两个值并写明采信哪条
（`日程是硬时间` → 取日历那条），卡片上两个时间都写。

## 与 ds-bot 的边界

- 用 ds-bot 的 `ctx.connection.fetch.register` 挂路由，用 `ctx.effect` 管定时器和注销——插件卸载即清理。
- 面板三条 Fetch 路由都在 `/api/...` 下：`PANEL_ROUTE=/api/opendigitalmate`（GET，JSON 快照）、`PANEL_PAGE_ROUTE=/api/opendigitalmate/page`（GET，服务端渲染的 HTML）、`CARD_ROUTE=/api/opendigitalmate/card`（POST，飞书按钮回调）。第②幕落地的 `POST /api/opendigitalmate/action` 与本条无关地共用同一无鉴权暴露面（和 `/card` 一样，上线前必须补验签，见「没解决的问题」）。
- 不碰 ds-bot 的 Bot / 会话 / 群逻辑；要「让 Bot 说话」时，后续接 `deliver` 即可，那是下一版的事。
- 所有业务模块不 import ds-bot，单测不需要 DSH 也不需要网络。

## 没解决的问题

1. 日历数据源没接：`calendar()` 目前是注入点，要接 `calendar.v4.calendar_event.list`，并处理成员 OAuth 与刷新。
2. 日报的填写入口还没做成卡片表单，只有 `recordReport()` 接口。
3. 卡片回调的验签（`X-Lark-Signature` / `encrypt_key`）还没做——上线前必须补，否则任何人都能打这个地址；面板的 `POST /api/opendigitalmate/action` 一旦落地同属这个缺口。
4. 多租户、多应用没做，先按单租户内部用。
