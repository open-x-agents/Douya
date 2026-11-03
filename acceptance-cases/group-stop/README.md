# 群「停止全部」之后清空群 Session 的 relay 队列（S1–S5a）

用户按下群里的「停止全部工作」（`stop-room-work`）之后，这个群 Session 的 inbox 里不许再留着会开新一轮的 relay。UI 的「排队/等待」读的就是这份投影，所以 relay 不走，界面就一直挂着。

每一次「发进群里」都会往群 Session 塞一条 relay（`postToRoom`）。停止只做两件事：拿到正在跑的轮就 `cancel()`（清的是**那一刻**的 inbox），然后逐个成员 `stopMemberWork()`——而停止通知自己又 `postToRoom` 回一条 relay。房间本来空闲时 `cancel()` 根本不会发生。之后没有任何一步清群 Session 的 inbox，于是那条 relay 一直躺着。

这一刀（PR 1）只做「停止即清队列」：`dropRoomRelays` 按 `relayMessages` 挑出本房间的 relay，`role: 'post'` 且 `logged === undefined` 的先把正文补进日志（`postLine`），再逐条 `inbox.remove`。停止之后**才**到的成员发言仍会入队——那是 PR 2（停后 log-only）的事。

| ID | 场景 | 期望 |
| --- | --- | --- |
| S1 | `relayMessages` 扫 `nextTurn` 与 `nextStep` | 只挑本房间 `form: 'relay'` 且 `role ∈ {post, kickoff, resume}`；用户消息、其它房间的 relay、`form` 不是 `relay` 的 bot 消息都不选 |
| S2 | `relayText` | 去掉开头的 `[Group post from X]` 行；没有头时原样返回 |
| S4 | `postLine` | `done/stopped/resumed(again→cut)` 是 kind 行、正文空；文本帖返回 `{who, botId, text}` 且不重复带头；`failed` 与「空正文 + 无 files + 非事件」不写行 |
| S5a | `groups.js` 接线 | 存在 `async function dropRoomRelays(room)`，其体内用 `relayMessages`/`postLine` 补日志并 `inbox.remove`；`stopRoomWork` 体内 `await dropRoomRelays(room)` |

`node --test acceptance-cases/group-stop/group-stop.test.js`

行为用例（A1/A4）在 `vendor/ds-bot/test/group-stop.test.js`，要有 harness 的环境才跑得起来。
