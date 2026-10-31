# 群聊 Stop 后已落日志的接力（S1–S8）

用户在群 Session 上 Stop 时，房间日志里已经有的接力不再留在 inbox，也不在这次中止收尾期间再开一轮。`source.kind === 'user'` 的 composer 队列留着。不改 harness 的 `keepInbox`。

| ID | 场景 | 期望 |
| --- | --- | --- |
| S1 | 迟到的确认已经写入日志（`source.logged` 为序号），然后 Stop | 日志仍是这一行；群 next-turn 不再留这条接力；没有新的 `group_relay` |
| S2 | 迟到回复 `@` 了提问的人，然后 Stop | 正文只在日志里出现一次；提问的人不会被拉起；接力不进队列 |
| S3 | followup 落在 cancel 之后、idle 之前 | 仍然只写一行日志；没有卡住的 inbox 行；不会再开一轮 |
| S4 | composer 里还有 `kind: 'user'` 的一行 | Stop 之后这行还在 |
| S5 | 全部停止时，某个成员在收尾过程中才说完 | 只记一次；不再打开房间 |
| S6 | 没有 Stop | 日志不重复写；`askedBy` 仍然得到一轮 |
| S7 | bob 的私聊 `ask_user` | 卡片不动 |
| S8 | 一轮进行中用户插进来的话 | 仍然只排一次；`drainRoomInbox` 仍只认 `source.kind === 'user'`，bot 接力不排 |

纯函数和源码锁定：`node --test acceptance-cases/group-stop-relay/group-stop-relay.test.js`（不 import `@deepseek-ai`）。
