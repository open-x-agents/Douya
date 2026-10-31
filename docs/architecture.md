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

report 的形状：`{ date, memberId, memberName, schedule[], done[], plan[], notes, stats{meetings, meetingMinutes, done, planned} }`。

## 三条流程

**提醒**：`calendar()` 给事件 → `planFor()` 算 `fireAt = start - leadMinutes` → 每 60 秒 `tick()` 取 `due()` → 发卡片 → 成功才写进 `sent`。失败留在未发状态，下一次 tick 重试，投递记录进 `deliveries`。

**日报**：`recordReport()` 存一条 → `dailyReportCard()` 出卡片 → `sendReportCard()` 推给本人或群。面板按 `memberId:date` 统计提交率。

**交互**：飞书把按钮回调 POST 到 `/api/opendigitalmate/card` → `readAction()` 只接受自己发的卡片（`k` ∈ {report, reminder}，`op` ∈ 已知 5 个）→ 改一条记录 → 返回 toast。

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

## 与 ds-bot 的边界

- 用 ds-bot 的 `ctx.connection.fetch.register` 挂路由，用 `ctx.effect` 管定时器和注销——插件卸载即清理。
- 面板两条 Fetch 路由都在 `/api/...` 下：`PANEL_ROUTE=/api/opendigitalmate`（JSON 快照）、`PANEL_PAGE_ROUTE=/api/opendigitalmate/page`（HTML）。
- 不碰 ds-bot 的 Bot / 会话 / 群逻辑；要「让 Bot 说话」时，后续接 `deliver` 即可，那是下一版的事。
- 群聊与工作线在 ds-bot（vendored）里怎么实现——组件与归属、落盘数据、主要流程、stop/late/inbox——见 [group-work-lines.md](group-work-lines.md)。
- 所有业务模块不 import ds-bot，单测不需要 DSH 也不需要网络。

## 没解决的问题

1. 日历数据源没接：`calendar()` 目前是注入点，要接 `calendar.v4.calendar_event.list`，并处理成员 OAuth 与刷新。
2. 日报的填写入口还没做成卡片表单，只有 `recordReport()` 接口。
3. 卡片回调的验签（`X-Lark-Signature` / `encrypt_key`）还没做——上线前必须补，否则任何人都能打这个地址。
4. 多租户、多应用没做，先按单租户内部用。
