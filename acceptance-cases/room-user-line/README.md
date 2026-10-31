# 已进日志的用户行不再排队、也不再写第二行（U1–U11）

本目录是第一刀（issue #60）。要证明的一件事：一条用户消息只要它的那一行已经写进房间日志，就不再以 `source.kind === 'user'` 留在该群 Session 的 inbox（`next-step` / `next-turn`），也不会在下一次唤醒时再写一行。

现场（issue 正文）：`room.log` seq 1–6 是用户的六条消息，同一个会话的 `inbox.next-step` 里仍是同样六条。两份持久数据同时存在，界面把 inbox 里的行画成结尾的待发气泡，于是历史重复。

本刀**只按 `inboxId` 匹配**，不做文本/顺序回退（两条同文本真消息里会误删一条，U5 是这条的负例）；不碰 #59 的 halt 机制（不 import `room-halt.js`），不碰 `groups.js` 的 `session/event`，不改 DSH 客户端。Stop 时的清理是第二刀（`turns.js` 的 `turn/end` + U12/U13），不在本目录。

## 用例

`node --test acceptance-cases/room-user-line/room-user-line.test.js`（纯模块 + 真 `install(turns.js)` + 真 `applyRouteDecision`；不 import `@deepseek-ai`，不联网）

| ID | 场景 | 期望 |
| --- | --- | --- |
| U1 | `userLineFor(id, text)` | 有真 id 时行带 `inboxId`；id 为空时没有这个字段。`extra` 里的 files 仍在 |
| U2 | `loggedUserIds` / `isUserLineLogged` | 只收 `who === 'User'`、`kind` 为空、带字符串 `inboxId` 的行；Bot 行、notice 行、没有 id 的旧行都不算 |
| U3 | issue 现场：六行 pending + 六条带 id 的日志行 | `userRowsToDrop` 得到六个 id |
| U4 | 日志里没有对应 id 的 composer 行 | 留在 inbox；`dropUserRows` 返回 0（Stop 不吞输入） |
| U5 | 同一句输入两次、不同 id，只有一条在日志 | 只摘那一条，另一条留着 |
| U6 | `dropUserRows` | 返回真正摘掉的条数；`nextStep` 剩余顺序不变；inbox 没有 `remove` 时返回 0 不抛 |
| U7 | 真 install：splice 一条 id 已在 `room.log` 上的消息 | 一个 tick 后该 id 被 `inbox.remove`；`rt.roomInbox` 没有多东西；没有走路由 |
| U8 | 真 install：同一 id 先 splice 再 `user/message` | `rt.roomInbox.get('r1') === undefined`；`steered` / `delivered` 不增；不路由（改动前：会排进 relay，再落一行） |
| U9 | 真 install：路由命中且假 `applyRouteDecision` 把带 id 的行写进日志 | 一个 tick 后该 id 被摘；`message.inboxId` 传到路由。路由是 `hold`（不写日志）时**不摘**（改动前：路由后从不摘） |
| U10 | 真 `applyRouteDecision` + 假 `appendRoomLine` | 第一行带 `inboxId === 'm1'`；同 id + 另一句文本再跑长度不变；末行换成 Bot 行 + 同 id 长度也不变（改动前：每次都追加） |
| U11 | 源码锁 | `groups.js` 的 relay 用户行用 `userLineFor(post.inboxId, …)`、`rt.appendRoomLine` 保留 `line.inboxId`、drain 传 `inboxId: line.id`；`turns.js` 的 `queued` 带 id、路由分支传 `inboxId: data.id` 并用 `isUserLineLogged(room.log, data.id)` 复核；`route-inbound.js` 的 `logInboundSentence` 收第四参并按 id 复用 seq；`room-user-line.js` 不 import `@deepseek-ai`、不碰 `room-halt` |

## 反向证明（仓库纪律 2）

- 把 `isUserLineLogged` 改成恒 `false` → U2/U7/U8/U9 变红（准入闸与路由后摘行都关掉）。
- 删掉 `logInboundSentence` 里按 id 复用 seq 的三行 → U10 变红。
- 两处改回后 `node --test acceptance-cases/room-user-line/room-user-line.test.js` 11/11 全绿，全套 242/242 全绿。

## 取舍

被摘掉的行如果从未被 claim，聊天区里用户那条 pending 气泡会消失，话只留在房间日志（`read_group_chat` 和所有成员仍看得到）。这是「每条只出现一次」的代价；客户端侧的补法另开切片。

本刀之前就已经卡住、日志行没有 `inboxId` 的会话不会被自动清理（只按 id，不做文本回退）；用户重开会话或手删 inbox 行即可，见 out of scope。
