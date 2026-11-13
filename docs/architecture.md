# 架构

豆芽（Douya）不是另起一个服务，而是 **ds-bot 的一个插件**（插件 id 仍是 `opendigitalmate`，以免已有安装升级失败）：ds-bot 负责机器人、会话、模型和存储，这里只加「飞书这个入口」和「日历 / 日报这个业务」。

## 位置

```
DSH（DeepSeek Harness）
└── ds-bot 插件（Bot 团队：roster / turns / groups / connectors）
    └── opendigitalmate 插件（豆芽宿主，id 未改）
        ├── 飞书卡片发送        src/host/feishu.js
        ├── 日报组装 + 卡片      src/host/report.js, cards.js
        ├── 日程提醒规划 + 投递  src/host/reminders.js, index.js
        ├── 面板接口 + 页面      src/host/panel.js, src/host/panel.html
        ├── 面板坏状态（纯函数） src/host/panel-states.js
        └── 状态                 <DSH_HOME>/opendigitalmate/state.json
```

若设置了 `ODM_DATA_DIR`（桌面安装包会把它指到可写的 userData 目录），插件的状态和 `config.json` 写在那里，而不是 `<DSH_HOME>/opendigitalmate`。源码目录里直接 `npm start`、未设该变量时，路径不变。

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
| `duty` | `{ text, by, at } \| null` —— 今天页最上面那一句常驻的「仍归你管」，只有一句，后写覆盖前写；不是卡片、不进 digest、不受布局筛选影响；`by` 是 `user` 或 `bot`，点 ✓ 后清空并写进 `completions`（`cardId: duty`） |

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

## 事与证据账本（#9）

`src/core/` 是「事」的结构与证据账本，纯模块 + 单机存储层：它不联网、不读环境变量，也不 import 进 `index.js`（这一层先作为被 #10 调用的库存在）。形状定义一处：信源适配器只往里写，面板只从里面读。

### 目录与文件

默认数据目录是相对进程 cwd 的 `data/`（已进 `.gitignore`，运行时数据不进仓库），三个路径都能由 `dir` 注入，测试永远传 `mkdtemp()` 出来的临时目录：

| 文件 | 内容 | 写法 |
| --- | --- | --- |
| `data/events.json` | 事：`{ "revision": n, "events": [...] }` | 可重写，原子写 |
| `data/ledger.jsonl` | 证据：一行一条记录 | 只追加，永不删改 |
| `data/store.lock` | 跨进程锁 | 谁持有谁删 |

四个模块各管一件事：`src/core/event.js`（纯模型：枚举、校验、UTC 归一、唯一本地化出口、`mergeEvent`）、`src/core/atomic.js`（原子写 / 追加 / 锁 / 进程内串行）、`src/core/store.js`（`events.json` 读写）、`src/core/ledger.js`（`ledger.jsonl` 追加与 `explain`）。`src/core/store.js` 与 `src/host/store.js` 是两个东西：前者读不出来就报 `E_CORRUPT_EVENTS`；后者读到坏 JSON 静默回落空状态，那是给旧 `state.json` 的。不要合并，也不要互相 import。

### 事（Event）的形状

必填 `id, kind, title, state, sources`；可选 `due_at, due_kind, who, project, closure, conflicts, confidence`，以及任何其它字段（原样保留，给 #13 用）。

```json
{
  "id": "evt_demo_quote",
  "kind": "message",
  "title": "报价单发给张伟",
  "state": "open",
  "due_at": "2026-10-30T02:00:00.000Z",
  "due_kind": "hard",
  "sources": [
    { "type": "feishu_msg", "ref": "feishu_msg:chat/oc_demo/msg_2114",
      "at": "2026-10-29T13:14:00.000Z", "read_scope": "body",
      "excerpt": "报价单今天能给吗？能给的话我下午就签。",
      "excerpt_hash": "sha256:…" }
  ],
  "closure": null
}
```

- `EVENT_KINDS = calendar / email / doc / pr / issue / message / task`；`EVENT_STATES = open / closed / waiting_other / unknown`。
- source `type` 是固定枚举 `gcal / gmail / feishu_doc / feishu_cal / feishu_msg / github` 加一条 `/^composio:[a-z][a-z0-9_]*$/` 模式（`isSourceType()` 是唯一判定）。
- `ref = <type>:<external>`，前缀必须等于 `type`：`gcal:event/<id>`、`gmail:thread/<id>`、`feishu_msg:chat/<chatId>/<msgId>`、`composio:gcal:event/<externalId>`。
- `excerptHash(text)` = `'sha256:' + sha256(String(text).trim())`；`excerpt` 与 `excerpt_hash` 至少给一个，两个都在时必须相等。
- 邮件正文不留存：`type: 'gmail'` 且 `read_scope: 'body'` 的 source 算完 hash 就丢掉 `excerpt`，只留 `excerpt_hash`；主题（`metadata`）照常保留，聊天 / 日程 / 文档的正文保留。
- 反例一律抛 `EventInvariantError`，带 `.code`、`.why`、`.path`；校验顺序固定（id → title → kind → state → sources → 逐个 source → 重复 ref → due_at → closure），所以反例测试能断言确定的 code。

### 证据账本（ledger.jsonl）

`src/core/ledger.js` 一行一条证据，形状写死七个键，不多不少：

```json
{"seq":1,"event_id":"evt_demo_quote","field":"title",
 "source_ref":"feishu_msg:chat/oc_demo/msg_2114",
 "at":"2026-10-29T13:14:00.000Z","excerpt_hash":"sha256:…",
 "recorded_at":"2026-10-30T09:00:00.000Z"}
```

- `at` 是信源自己的原始瞬时，`recorded_at` 是写进账本的时刻；两者都存 canonical UTC。
- `field` 是这条证据支撑的断言名（`/^[a-z][a-z0-9_]{0,31}$/`，本单用 `title`；#13 的冲突 / 金额可用 `due_at` / `conflict`）。
- 导出只有 `assertionRecords`、`parseLedger`、`explainFrom`、`appendEvidence`、`explain` 五个，**没有任何 update / delete / rewrite**：文件里不出现 `writeFile` / `rename` / `unlink` / `truncate` / `rm(`。
- `appendEvidence({ dir, eventId, field, sources })` 在锁内读全表，`(event_id, field, source_ref, excerpt_hash)` 已存在就跳过（幂等，重跑不翻倍），`seq = max(seq)+1` 递增，新记录一次追加，返回 `{ appended, skipped }`。
- `parseLedger(text)` 忽略空行；末尾没有换行的半行（写者崩溃的尾巴）跳过并计入 `skippedTail`；**中间**某行坏掉或 `seq` 重复是 `E_CORRUPT_LEDGER` 并带行号。`explain({ dir, eventId })` 不拿锁，按 `seq` 升序返回，未知事件返回 `[]`，不编造证据。
- 账本**只存 hash、不存引文**：渲染要引原文时，由适配器按 `ref` 重新取并比对 hash（#10 / #15）。

### 四条不变量

1. **至少一条 source**：空 `sources` 构造不出来（`E_NO_SOURCE`）。
2. **关掉必须有出处**：`state === 'closed'` 时 `closure.evidence_ref` 必填，且必须是该事件自己的某条 `sources[].ref`（`E_CLOSED_NO_EVIDENCE` / `E_CLOSED_EVIDENCE_UNKNOWN`）。
3. **`due_at` 一律存 UTC**：见下一节。
4. **一事多源不拆卡**：一件事出现在多个信源 = 一条事件、多条 sources，绝不两张卡。`mergeEvent(kept, incoming)` 要求同 `id` 或至少一条 `ref` 相同（否则 `E_MERGE_UNRELATED`）；同一 `ref` 但 `excerpt_hash` / `at` 不同是 `E_SOURCE_CONFLICT`（不静默二选一）；`upsertEvent()` 与已有事件共享 `ref` 或同 `id` 就合并进那一条，同时命中两条是 `E_AMBIGUOUS_MERGE`。标题相似**不构成**合并理由。

### UTC 与本地化出口

canonical UTC 形状是 `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`，`due_at` / `source.at` / `closure.at` / 账本 `at`、`recorded_at` 全部按它存。

- `toUtcInstant(value, { timeZone })`：带 offset 或 `Z` 的 ISO 字符串归一成 UTC（`2026-10-29T21:14:00+08:00` → `2026-10-29T13:14:00.000Z`）；`{ dateTime: 'YYYY-MM-DD HH:mm[:ss]', timeZone }` 按 IANA 时区换算（含 DST 边界；墙上时刻在该时区不存在也报错）；只有日期、或有时刻却没有时区 → `E_NOT_UTC`（全天日程 `due_at` 放 `null`，不猜）。
- 渲染只有两个出口，都在 `src/core/event.js`：`localizeInstant(iso, { timeZone })` → `'YYYY-MM-DD HH:mm'`；`localizeDueAt(event, options)`（`due_at === null` 时返回 `null`）。`src/core` + `src/host` 里唯一允许出现 `Intl.DateTimeFormat` / `toLocaleString` / `getHours` / `getMinutes` / `getTimezoneOffset` 的位置就是这里，有测试按同一组锚定正则扫描钉住。
- 不传 `timeZone` 时用进程时区，所以 `TZ=UTC` 与 `TZ=Asia/Shanghai` 跑同一时刻会得到两个正确但不同的字符串。

### 锁与原子写

`src/core/atomic.js` 是所有写入的唯一通道：进程内先按 `path.resolve(dir)` 串行（模块级 Promise 链），再拿跨进程锁 `store.lock`（`open(lock, 'wx')`；`EEXIST` 时每 25ms 重试，超过 `timeoutMs`（默认 10s）抛 `LockTimeoutError`；锁超过 `staleMs`（默认 30s）视为死锁，rename 走旧的再删，**不删别人的锁**），任务结束（成功或抛错）都在 `finally` 里删自己的锁。

- `atomicWriteJson`：`mkdir` → 写 `<path>.<uuid>.tmp`（两空格缩进 + 末尾换行）→ `rename`，成功后目录里不留 `*.tmp`。
- `appendJsonLines`：`open('a')` → 每条一行 → `fsync` → `close`；一次调用写的多行在锁内一次写完，最坏丢最后一条而不是坏掉前面的行。
- 账本先写、事件后写时崩溃 → 有证据没有卡；重跑 ingest 时幂等追加会跳过、`upsert` 会补回卡，不删任何东西。

## 信源适配器（#10）

`src/sources/` 是「从外面读进来」的那一层：契约、GitHub 适配器、摄取各一个文件，外加一个能真跑的探针。都是库，`index.js` 不 import（接早报属 #14 / #15）。

### 契约

`src/sources/contract.js` 只写形状、错误分类和文案，不联网、不写盘、不读环境变量。

- 一个 Source 恰好五个只读成员：`id`、`readScope`、`auth()`、`list(since, cursor?)`、`get(ref)`。接口层没有 create / update / comment / delete / write / post / patch / put / merge / close / label / assign；`assertSource()` 会把后来长出来的写方法当场拒掉（`E_SOURCE_WRITE_METHOD`），缺成员是 `E_SOURCE_SHAPE`。
- `auth()` 同步、不联网：没有 token 就是 `{ ok: false, reason: 'missing' }`。
- `list()` 返回 `{ events, next?, partial? }`：`next` 是不透明游标（下一页的完整 URL），`partial` 是带内缺口，不是异常。
- 错误六类 `auth / rate_limit / partial / timeout / http / blocked`，`SourceError.code = E_SOURCE_<KIND>`，带 `.reason / .status / .retryAfterMs / .url`。`blocked` 是站点 WAF 挡住了这次抓取，不是权限或限流，也不代表站点政策。
- ref 词表：`github:<issue|pr>/<owner>/<name>/<number>`，外部部分的字符集与 `src/core/event.js` 的 `EXTERNAL_REF` 一致（不含 `#`）。带仓名不是装饰：两个仓都有 10 号，不带仓名账本里就会撞成一条。`eventIdForRef()` 给 `evt_` + sha1(硬键) 前 10 位。
- 缺口文案只有一处 `describeSourceGaps()`（`GitHub 凭据失效了`、`GitHub 限流，30 秒后再取`、`GitHub 超时，这一份缺了`、`GitHub 挡住了这次访问，我不会绕过它。` …），测试逐字断言；拦截那一句由 `src/sources/blocked.js` 的 `blockedNote()` 给出，不在别处另写一遍。

### GitHub 适配器

`src/sources/github.js` 的 `createGithubSource({ token, fetch, apiBase, maxPages, maxObjects, sleep, now })`；token 只从调用方传入，本层不读环境变量。

- 请求层不接受 method 参数，写死 GET —— 只读是代码形状，不是自觉。
- 读八条路径：`/user`；分给我的（`/issues?filter=assigned&state=all&since=…`，跨仓）；等我 review 的、我开的 PR（两条 search）；PR 的 head；tip 的 check-runs；最新一条评论；`get(ref)`。
- CI 只认 check run，不认 combined status：同一 sha 的 `/status` 可以是 `pending`、`total_count: 0`，读它会把绿的 tip 误报成未完成。汇总规则：任一未完成 → `pending`；有 failure / cancelled / timed_out / action_required → `failure`；全 success → `success`；一条都没有 → `none`。
- 分页：`Link: rel="next"` 的完整 URL 就是游标；`maxPages=5`、`maxObjects=60`，撞上限往 `partial` 里放 `page-cap` / `object-cap`，不静默截断。
- 错误分类：`cf-mitigated` 头先判（`block / challenge / managed` → `blocked`，不重试，位置在 401/403 之前）；401 → `auth/expired`；403 且限流打光 → `rate_limit`；其它 403 → `auth/scope`；429 → `rate_limit`（带 `retryAfterMs`）；网络 / abort / 5xx 重试 3 次（250 → 500 → 1000 ms）后 → `timeout`；其它非 2xx → `http`；子请求坏了是带内 `partial`，那份 PR 还在。

### 摄取

`src/sources/ingest.js` 的 `ingestSource({ source, dir, since, now, overlapMs, windowMs, store })`：观察 → `upsertEvent()` + `appendEvidence()`。一个对象的 ref 不变，所以重跑只会合并、不会翻倍。

- since 的来法：参数 > `<dir>/sources/github.json` 的 since > now − 24h。
- `SourceError`（含 `blocked`）不抛：`complete: false`、`missing` 一条或几条、`gap_text` 有话说。早报据此标「缺源」，而不是变成空白；非 `SourceError` 的编程错误照常抛。
- 返回值形状固定：`{ source, complete, missing, gap_text, since, until, cursor, fetched, created, merged, appended, skipped, events }`。
- 不做合并规则 / 去重 / 冲突（#13）、不排序展示、不写文案。

### 水位

`<dir>/sources/github.json`：`{ id, since, until, cursor, complete, at }`，用 `src/core/atomic.js` 的 `atomicWriteJson()` 写在 `withDataLock(dir, …)` 里。

- 只有「读完了」（`complete: true`、没有 `next`、没有缺口）才前进到 `until − overlapMs`（默认 1 小时）。GitHub 的 `since` 是 `updated_at` 闭区间、search 的 `updated:` 只有天粒度，这 1 小时重叠就是用来兜边界的。
- 失败（`SourceError` / partial）一律不动水位：下一次重跑同一窗口，幂等保证重跑不翻倍。

### 证据

会变的东西只进只追加的账本，每个对象最多四条：`title`、`state`、`ci`（PR 且读到 check run）、`comment`（读到最新一条）。事件里的 source 用不可变的 `created_at` + 身份串 `<repo> <object> #<number>` —— `mergeEvent()` 对同一 ref 的 `at` / `excerpt_hash` 不一致会抛 `E_SOURCE_CONFLICT`，把标题 / 状态塞进事件 source，第二天对象一改评论就写不进去。关掉的对象带 `closure = { by: 'github', at: closed_at || updated_at, evidence_ref: ref }`。

### 探针

`scripts/source-probe.mjs`：拿真 token 跑一次 `ingestSource()`，把这次读到什么打到 stdout；缺源写在 `missing / gap_text` 里，不靠退出码。

```sh
node scripts/source-probe.mjs --repo open-x-agents/Douya            # 默认 now-24h、系统临时目录
node scripts/source-probe.mjs --since 24h --dir /tmp/probe --json            # 机器读的形状
node scripts/source-probe.mjs --fixture test/fixtures/github/ok --dir /tmp/p  # 离线重放，不联网
```

- 打的字段：`since` / `until`、`fetched / created / merged / appended / skipped`、`complete / missing / gap_text`、水位与账本的文件路径；`--json` 是同一个对象。
- 退出码只有两种：0 = 跑完了（完整、或缺源但说清了缺什么），1 = 真错误（参数、夹具、写盘）。缺一份源不是命令失败。
- 不写仓库里的 `data/`：没有 `--dir` 就落到系统临时目录。`--repo` 是写进账本的 allowlist（收窄写入范围，不省请求），水位仍跟着 `github` 这一源走。
- `--fixture` 用 `test/fixtures/github/` 的假 fetch 重放，走的是**同一套**适配器与摄取，所以离线也能验输出形状。

## 四条流程

**提醒**：`calendar()` 给事件 → `planFor()` 算 `fireAt = start - leadMinutes` → `tick()` 取 `due()` → 发卡片 → 成功才写进 `sent`。失败留在未发状态，下一次 tick 重试，投递记录进 `deliveries`。定时器只在最近一个 `fireAt` 醒来，不是每分钟轮询。

每次 `tick()` 也把这次日历读到什么写进 `state.sources.feishu_cal`：返回非数组、`null` 或抛错 = 没连上，页面据此降级，而不是画成「今天没有会」。

**日报**：`recordReport()` 存一条 → `dailyReportCard()` 出卡片 → `sendReportCard()` 推给本人或群。面板按 `memberId:date` 统计提交率。日键取**本地日**（`localDay(now, timeZone)`），上海凌晨的早报不会落到昨天。

**交互**：飞书把按钮回调 POST 到 `/api/opendigitalmate/card` → `readAction()` 只接受自己发的卡片（`k` ∈ {report, reminder}，`op` ∈ 已知 5 个）→ 改一条记录 → 返回 toast。

**面板**：`/api/opendigitalmate/page` 读 `src/host/panel.html` 外壳，把 `<!--panel:body-->` 换成服务端渲染的七幕页面；页面不带脚本、不带外链、不发任何请求，只读本机 `state.json`，不写飞书 / 日历 / 文档。

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

**冲突并列与显示名（S5）。** 两个 app 对同一件事给出不同的 `due_at` 或 `state` 时，两个值都留着：
`src/host/conflicts.js` 的 `conflictsOf(event)` 是纯函数，只在渲染时从 `event.sources[]` 派生
`[{ field, values: [{ value, source, ref, at }], chosen: { value, source, ref, why } | null }]`——
不读时钟 / 盘 / 网，不新增聚合层，也不改 `buildEvent()`（它仍然只写「各源都同意才取值」）。
同一字段的非空值去重后不足 2 个就不算冲突。`values` 的排序写死三条：`due_kind === 'hard'` 的源在前 →
`at` 更早的在前（`at` 是这条证据被看见的时刻，不是它说的时间；没有时间戳的排最后）→ `ref` 字典序小者在前。
`due_at` 的 `chosen` 按同一顺序取第一条，`why` 是最后生效的那条规则的原话：`日程是硬时间` /
`时间更早的那条` / `先按来源名`；`state` 冲突的 `chosen` 恒为 `null`——说法相反就记未知，不投票。
卡片上两个时间都写：`viewEvent()` 带 `conflicts`，`renderItemCard()` 的 `.due` 行在冲突时写成
`本地 16:00（谷歌日历） / 15:30（邮件）`，其后再一行 `采信 16:00（谷歌日历）：日程是硬时间`；
只有被采信的那个时间出现在卡片上，就是这条做错了。

显示名只做一次性接线：`panel.js` 的 `sourceLabel` 是 `SOURCE_NAMES[type] ?? labelOf(type) ?? type`，
`ask.js` 的 `sourceLabel` 在 `composio:` 分支里同样先查 `labelOf()`。之后加一个 app 只加注册表一行的
`label`，`src/host/**` 里不出现任何 app 名（写死的中文名只在注册表里）。

## Web 卡片看板与问答（src/web，#17）

`npm start`（`scripts/server.js`）起一个独立 HTTP 服务（默认 7777），托管 Muse Today（`dsh-muse-ui` 插件的 static；standalone 经 `dsh-muse-ui/static-serve` 引入）（今天 / 信源状态 / 配置）。它和插件共用 `createRuntime` 与 `src/host/store.js`，但看板自己的逻辑都在 `src/web/`，不进 `src/host/`——`src/host` 仍然不出现具体 app 名、不自己格式化时间（`test/composio/add-app.test.js`、`test/event.test.js` 守着）。

| 文件 | 职责 |
|---|---|
| `src/web/api.js` | HTTP 路由（`/api/today`、`/api/digest/generate`、`/api/chat`、`/api/sources`、`/api/config/*`、`/api/composio/*`）；`mountApiRoutes(server, router, { extraRoutes })` 先分发 ds-bot 形状的路由（`installPanel` 注册的 `/api/opendigitalmate*` 原样可用） |
| `src/web/aggregation.js` | 汇聚流水线：拉取（GitHub / Gmail / Slack / 日历，经 Composio）→ 归一 → 去重（按完整 URL）→ 按项目 / 发件人 / 频道聚类 → 分类 → 卡片；英文标题 + 中文摘要、每卡 3 个追问由模型生成，数字只来自真实数据 |
| `src/web/composio.js`、`agent-tools.js`、`chat-groups.js` | Composio v3 客户端；只读工具（PR / issue / 邮件 / Slack 搜索 / 日历）及其预聚合分组 |
| `src/web/dsbot-chat.js` | 独立服务器（`npm start`）里的 ds-bot 回退：经 DSH `/api/bot` 把消息发给 ds-bot Chief（`send`），再读回 `chat` 页；Muse 的对话与历史都走进程内（`muse-chat-core.js` 直接读 Chief 的 Session，不读日志文件） |
| `src/web/dsbot-tools.js` | 把 Composio / identity / today / `ask.js` cite 注册成 ds-bot 可调用的 `odm_*` 工具 |
| `src/web/bot-chat.js` | 废弃 shim，指向 `dsbot-chat.js` |
| `src/web/llm-client.js`、`config-store.js`、`profile.js` | 模型客户端、`config.json`（默认 `.odm-data/`，或 `ODM_DATA_DIR` / `<DSH_HOME>/opendigitalmate`）、显示名（运行时从 GitHub 身份推出，不写死） |

### 问答：Bot 对话 + 先找依据再答

`npm start`（`scripts/start-dsh.mjs`）同时拉起：① `dsh --profile odm`（真实 ds-bot + ODM 工具，默认 :7788）；② Muse 看板（:7777）。对话框只跟 ds-bot Chief 说话；`ask.js` 仅作为 `odm_ask_cite` 工具，不再当聊天后端。

涉及邮件 / PR / Slack / 日历的事实时，Bot 先调用 `askWithEvidence()`：

1. 证据：今天的卡片（每张卡一条、卡里每个链接一条，`ref` 是真实链接），加上问题点名的信源的实时只读拉取（邮件 / PR / issue / Slack），各自成组；问题点名了某个信源时只用那个信源，实时结果顶替旧卡片。卡片追问只用这张卡的证据。
2. 候选：用 `ask.js` 的 `rankSources()` 排出前 6 条。
3. 起草：配置的模型只看这些候选，输出 `{claims:[{text, ref}]}`；模型不可用时退回「引用候选自己的摘要」，不产生新措辞。
4. 判定：把草稿当 `model` 交给 `askQuestion()`——ref 不在证据里、或时间 / 数字 / 金额不在被引信源原文里的 claim 一律丢掉，一条不剩就拒答。没有任何候选时不调模型。
5. 回给界面：答案、引用（链接 + 来源名）、被引分组的聚合卡片。

`ask.js` 本身没改，它的测试也没改。自制的 ask-bridge / bot-chat 问答层已删除。

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

## Muse 作为 dsh 主前端

豆芽以 Host + Web client 双面插件挂进 `dsh --profile odm`（宿主插件 id 仍是 `opendigitalmate`）：

- Host `cordis.patch.yml` 只插入 `opendigitalmate`
- Muse UI 插件 `dsh-muse-ui`：`dsh.client` 把 `/` 重定向到 `/api/opendigitalmate/app`，并 `disable` 库存 `ui-layout` / `ui-sidebar` / `ui-conversation`
- Host 在同一进程注册 Muse HTML 与全部 `/api/*`；对话走进程内 `sessionController`（ds-bot Chief）
- 卡片完成写入 `state.completions` 持久账本；digest 合并带 `{ digest: true }`，不抹掉 done/dismissed
- 今天页最上面那一行是 `state.duty` 的一句常驻话，不是卡片：刷新、重新汇聚和布局筛选都不动它，点 ✓ 才进 `completions`，撤销再放回来

启动：`npm start` → 单进程 `dsh --profile odm --port 7777`。登录后打开 Muse。
