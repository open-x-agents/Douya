# 忙时连续接收（L1–L7）

本目录锁定 issue #3 已经落地的行为：空闲时下一条排队；生成中继续发送并进当前轮（steer），不排到下一轮；显式 queue 仍然排队；私聊 feed 不把 Bot↔Bot 的隐藏回合播给用户；定稿后只留一条正文，尾巴在这条上。

工作线路由仍走原来的门。`channel.send` 先 `routeRoomUser`，没有路由器时才 `decideRoomSteer`。一条忙线的群聊 steer 用 `acceptRoomSteer`，不把 `prompt` 的 mode 写死成 `queue`。

| ID | 场景 | 期望 |
| --- | --- | --- |
| L1 | 空闲私聊 / 空闲群 | `resolveSendMode` 为 `queue`。群里的用户句进房间 inbox，不 steer。成员不在说话槽、也不忙时，房间草稿不接流 |
| L2 | 成员生成中，连续两条不同的 next-step | 两条都 `acceptRoomSteer`；inbox 仍空。另一扇门上的同一句（splice 之后的 `user/message`）不再 steer |
| L3 | 生成中显式 `mode: 'queue'`；空闲默认 | 显式 queue 进 inbox，不 steer。空闲不会变成 steer |
| L4 | `channel.send` 与 composer `busyEnter` | prompt 使用 `resolveSendMode`，不写死 `mode: 'queue'`。补丁是 `busyEnter: steer`。忙默认 steer；显式 queue 优先；空闲显式 steer 仍是 steer；未知的 `followup` 在忙时落到 steer |
| L5 | Bot↔Bot 隐藏回合 | 私聊 feed 不发布 `exchangeTurns` 里的 turn；随后的可见 turn 仍逐段发布。不在 `chatOwners` 的群会话不进这条私聊流。`isHiddenTurn` 与 feed 一致。群里的 `request` / `stopped` 回合 `turnVisibleInGroup` 为假，`assistant-stream` 在 `applyRoomStreamFrame` 之前就返回；房间回合仍为真 |
| L6 | 一次尝试的 text-delta 定稿 | 增量合成一条草稿。提交正文与草稿相同，或提交正文以草稿开头（尾巴在提交行上）时草稿消失，只留这一条。更短的已贴前缀不清掉未贴完的尾巴，下一段增量还接在同一条上。同一尝试的几段拼起来盖住草稿时才清；只剩尾巴的一段不清。`Name：` / `**Name**：` 和首尾空白仍算盖住。后面另一轮的句子不挡住已经盖住的那条。空的 start 种子保留。`kind: 'steering'` / `kind: 'user'` 不清草稿。两次 `start` 各定稿一次，尾巴都在 |
| L7 | 与后来的工作线路由并存 | `channel.send` 里 `routeRoomUser` 在 `resolveSendMode` 之前。没有路由器时，忙中的 splice 仍走 `decideRoomSteer`。路由器返回 `steer` 时只 `applyRouteDecision`，不再 `acceptRoomSteer`。continue / steer 仍不写日志、不复制转录 |

`node --test acceptance-cases/live-receive/live-receive.test.js`

不 import `@deepseek-ai`。`channel.js` 与 `groups.js` 只做源码锁定。
