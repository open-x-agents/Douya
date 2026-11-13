# 飞书侧契约 v0.1

> 撰写：Douya（刘红升2）。落在 main 时由 lead 加了下面这节「服务端读回」。
> 适用：飞书企业自建应用，单租户内部使用。

## 服务端读回（2026-10-30，与已实现代码对照）

scope、事件、卡片字段、更新策略都可以照做，但有四处与已经跑通的代码不同，谁改谁写清楚：

| # | 契约写法 | 现在的实现 | 处理 |
| --- | --- | --- | --- |
| 1 | 卡片回调走 `card.action.trigger` 事件、「同一条长连接，不依赖请求网址」 | 回调是 HTTP：`POST /api/opendigitalmate/card`，插件自己挂的路由 | **待验证**。飞书的卡片回传交互通常要单独配「消息卡片请求网址」，没有真应用点一次之前，不按「内网就行」排部署。 |
| 2 | 卡片统一 schema 2.0 + `behaviors[].callback` | 现在发经典卡片（`config`/`header`/`elements` + `action.value`） | schema 2.0 迁移列为 M2 的一项，迁移时按第 3 节的三张模板重写 `src/host/cards.js`，不另写一版。 |
| 3 | `value` 只放 `report_id`/`remind_id`/`version`，操作人取 `operator.user_id` | `value` 为 `{k, id, op}`，操作人取 `operator.open_id` | 以已实现为准补一条：`id` 是业务标识，`op` 是动作；推迟十分钟靠「事件id@到点时刻」做投递 key，所以 value 里不能只放 id。 |
| 4 | 提醒提前量固定 10 分钟，「稍后 5 分钟」 | 默认 10 分钟，稍后 10 分钟 | 按第 6 节第 3 条改成可配 5/10/15/30，默认 10。 |

其余不动：scope 最小集、`im.message.receive_v1` 与 `card.action.trigger` 的订阅、指令集、分段卡片模板、action 命名的「域.动作」形式、30 分钟与 5 次的原地更新上限、`(user_id, date, type)` 去重。

---


> 归属：Douya（刘红升2）。服务端（Danyang's Douya Bot）按此实现，改动走 PR。
> 适用：飞书企业自建应用，单租户内部使用，长连接（WebSocket）优先，公网回调作为备选。

## 0. 应用形态

- 应用类型：**企业自建应用**（非商店应用），单租户。
- 事件接收：**长连接**（`lark-oapi` / `@larksuiteoapi/node-sdk` 的 `WSClient`）。好处是不用公网域名、内网/Docker 都能跑。若后续要接公网，再切 HTTP 回调，事件体一致。
- 卡片回调：走 `card.action.trigger` 事件（同一条长连接），不依赖「消息卡片请求网址」。
- 机器人能力同时挂：私聊（日报/提醒）+ 群聊（@机器人 查询）。

## 1. 权限 scope 清单

开放平台「开发配置 → 权限管理」逐条勾选。**以控制台当前命名为准**，括号内是搜索关键词。

| 用途 | scope | 搜索关键词 | 类型 |
|---|---|---|---|
| 以应用身份发消息 | `im:message:send_as_bot` | send_as_bot | 必需 |
| 读取/发送单聊群聊消息 | `im:message` | im:message | 必需 |
| 获取群信息、拉群成员 | `im:chat:readonly` | chat:readonly | 必需 |
| 上传图片/文件（卡片封面、附件） | `im:resource` | im:resource | 可选 |
| 读取用户基础信息（姓名、部门、工号） | `contact:user.base:readonly` | user.base | 必需 |
| 按邮箱/手机号换 user_id | `contact:user.id:readonly` | user.id | 必需 |
| 读日历与日程 | `calendar:calendar:readonly` | calendar | 必需 |
| 写日历（改时间用） | `calendar:calendar` | calendar:calendar | 阶段④ |
| 多维表格（日报落库备选） | `bitable:app` | bitable | 可选 |

不需要：`im:message.group_at_msg`（旧版）、任何「获取全部通讯录」类高敏权限。

### 开通后的三步
1. 权限勾完 → **创建版本并发布**（企业内部应用需管理员审核，自己就是管理员可直接通过）。
2. 「凭证与基础信息」拿 `App ID` / `App Secret`。
3. 「事件与回调 → 事件配置」选**长连接**，添加事件：`im.message.receive_v1`、`card.action.trigger`。

> 凭证不入库、不写日志。环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，本地走 `.env`（.gitignore），线上走部署环境变量。

## 2. 事件与订阅

| 事件 | 版本 | 用途 | 处理要求 |
|---|---|---|---|
| `im.message.receive_v1` | v2 | 私聊/群里 @ 机器人的指令 | 2s 内 ack，重活丢队列 |
| `card.action.trigger` | v2 | 卡片按钮点击 | 3s 内必须返回（否则客户端 toast 超时） |

去重要点：`event_id` 落 Redis/SQLite 存 24h，重复投递直接返回 200。

指令集（`im.message.receive_v1` 文本匹配，容忍前后空格）：

| 指令 | 行为 |
|---|---|
| `/日报` | 立即推一张今日日报卡（补发） |
| `/日报 昨天` | 推昨日汇总（只读） |
| `/日程` | 推今日日程列表卡 |
| `/提醒 15` | 把个人提醒提前量设为 15 分钟 |
| `/帮助` | 功能卡 |

群里只响应 @机器人 的消息；私聊全量响应。

## 3. 卡片 JSON 模板

统一用 **卡片 JSON 2.0**（`"schema": "2.0"`），`config.update_multi: true` 允许局部更新。
按钮统一挂 `behaviors: [{type: "callback", value: {...}}]`，不使用旧的 `action` 字段。

### 3.1 日报卡（`report.daily`）

```json
{
  "schema": "2.0",
  "config": { "update_multi": true, "wide_screen_mode": true },
  "header": {
    "template": "blue",
    "title": { "tag": "plain_text", "content": "{{date}} 日报 · {{name}}" }
  },
  "body": {
    "elements": [
      { "tag": "markdown", "content": "**今日日程**\n{{agenda_md}}" },
      { "tag": "hr" },
      { "tag": "markdown", "content": "**待办进展**\n{{todo_md}}" },
      { "tag": "hr" },
      { "tag": "markdown", "content": "**明日计划**\n{{plan_md}}" },
      {
        "tag": "column_set",
        "flex_mode": "flow",
        "columns": [
          {
            "tag": "column",
            "width": "auto",
            "elements": [
              {
                "tag": "button",
                "text": { "tag": "plain_text", "content": "确认提交" },
                "type": "primary",
                "behaviors": [
                  {
                    "type": "callback",
                    "value": {
                      "action": "report.submit",
                      "report_id": "{{report_id}}",
                      "version": 1
                    }
                  }
                ]
              }
            ]
          },
          {
            "tag": "column",
            "width": "auto",
            "elements": [
              {
                "tag": "button",
                "text": { "tag": "plain_text", "content": "改一改" },
                "behaviors": [
                  { "type": "callback", "value": { "action": "report.edit", "report_id": "{{report_id}}" } }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
}
```

提交后原地更新：header 变 `green`，标题追加「已提交 12:03」，按钮列整体替换成一行 `plain_text`（卡片文字）。**同一张卡最多更新 5 次**，超了就发新卡，避免长卡片累积 diff 变慢。

### 3.2 日程提醒卡（`reminder.event`）

```json
{
  "schema": "2.0",
  "config": { "update_multi": true },
  "header": {
    "template": "orange",
    "title": { "tag": "plain_text", "content": "{{minutes}} 分钟后：{{summary}}" }
  },
  "body": {
    "elements": [
      { "tag": "markdown", "content": "🕐 {{start}} – {{end}}\n📍 {{location}}\n👥 {{attendees_md}}" },
      {
        "tag": "column_set",
        "flex_mode": "flow",
        "columns": [
          { "tag": "column", "width": "auto", "elements": [ { "tag": "button", "text": { "tag": "plain_text", "content": "稍后 5 分钟" }, "behaviors": [ { "type": "callback", "value": { "action": "reminder.snooze", "event_id": "{{event_id}}", "remind_id": "{{remind_id}}", "minutes": 5 } } ] } ] },
          { "tag": "column", "width": "auto", "elements": [ { "tag": "button", "text": { "tag": "plain_text", "content": "已完成" }, "type": "primary", "behaviors": [ { "type": "callback", "value": { "action": "reminder.done", "event_id": "{{event_id}}", "remind_id": "{{remind_id}}" } } ] } ] },
          { "tag": "column", "width": "auto", "elements": [ { "tag": "button", "text": { "tag": "plain_text", "content": "改时间" }, "behaviors": [ { "type": "callback", "value": { "action": "reminder.reschedule", "event_id": "{{event_id}}", "remind_id": "{{remind_id}}" } } ] } ] }
        ]
      }
    ]
  }
}
```

`reminder.reschedule` 先返回 toast「已打开时间选择」，再推一张带 `picker_datetime` 的二次卡片；选完走 `reminder.reschedule.confirm`。这样避免在主卡上放时间组件（手机端太挤）。

### 3.3 设置卡（`settings.show`）

「提醒提前量」用 `select_static`（5/10/15/30 分钟）+ 「日报推送时间」用 `picker_time`，选完直接 `settings.update`，原卡局部刷新。

## 4. 按钮 action 命名

`<域>.<动作>`，全小写点分，域和动作都不带下划线；多词用 camelCase：

| action | 位置 | 参数 | 幂等 |
|---|---|---|---|
| `report.submit` | 日报卡 | `report_id`, `version` | 是（同 version 重复点=成功） |
| `report.edit` | 日报卡 | `report_id` | 是 |
| `report.skip` | 日报卡 | `report_id`, `reason` | 是 |
| `reminder.snooze` | 提醒卡 | `remind_id`, `minutes` | 否（每次生成新 remind 记录） |
| `reminder.done` | 提醒卡 | `remind_id` | 是 |
| `reminder.reschedule` | 提醒卡 | `remind_id` | 是（只打开二级卡） |
| `reminder.reschedule.confirm` | 二级卡 | `remind_id`, `new_start` | 是 |
| `settings.show` | 指令 | `user_id` | 是 |
| `settings.update` | 设置卡 | `key`, `value` | 是 |

规则：
- `value` 里只放**标识 + 版本**，不放业务数据（避免卡片过期数据覆盖库里新数据）。
- `operator.user_id` 从回调的 `operator` 取，**不信任 value 里的 user_id**。
- 回调返回体统一：`{"toast": {"type": "success|error|info", "content": "..."}, "card": {"type": "raw", "data": {...}}}`；`toast.content` ≤ 20 字。

## 5. 卡片原地更新策略

1. **首选局部更新**：`PATCH /open-apis/im/v1/messages/{message_id}`，body `{"content": "<card json string>"}`，需要卡片 `config.update_multi: true`。
2. **时限**：消息发出后 **30 分钟内**可更新；超时直接发新消息并在文首加「（接上条）」。
3. **并发**：同一 `message_id` 的更新用服务端队列串行化，带 `version` 字段，旧 version 到达则丢弃。
4. **callback 同步返回**：能立刻算完（提交、已完成、改设置）就在 callback 响应里直接回 `card`，一次往返搞定；要查库/调外部接口（改日历时间）就先回 toast，异步 PATCH。
5. **失败兜底**：PATCH 失败（`99991663` message not found / `230002` 权限）→ 发新消息，记录 `msg_update_failed` 指标。
6. **发送去重**：定时任务用 `(user_id, date, type)` 唯一键，重启不重复推。

## 6. 待服务端确认的三点

1. `message_id` 与 `remind_id` 的映射表由谁落库（建议服务端 `reminders` 表加 `card_message_id`）。
2. 日报卡 `agenda_md` / `todo_md` / `plan_md` 的 markdown 由服务端拼装，长度上限各 800 字符，超出截断加「…」。
3. 提醒提前量默认 10 分钟，用户可改 5/10/15/30；改时间后旧提醒任务要取消，别双推。

## 变更记录

- v0.1 2026-10-30 初版：scope、事件、三张卡片、action 命名、更新策略。
