# 群聊忙时插话（G1–G6）

本目录只覆盖「这个房间里恰好一条成员会话正在跑，用户没有显式新开、点名或排队」时并入当前轮。没有第二条消息存储，也没有工作线索引。

| ID | 场景 | 期望 |
| --- | --- | --- |
| G1 | 宿主 composer（不是 `channel.send`）在成员生成中发送 `DEMO_STEER_OK`，回合尚未让位 | 并入当前轮；没有新的 `group_relay`；不调度 `joined` 补答。`busyEnter=steer` 把探针插进房间 inbox 的 next-step，`user/message` 要等房间下一步才到；在 `agent/inbox/spliced`（next-step）时就 steer，迟到的同一条 `user/message` 不再排队 |
| G2 | 同上，但槽位已是 `working`（`ROOM_WORK_GRACE_MS` 之后旧逻辑会清掉 draft） | 仍 steer；draft 继续接在同一气泡；不 `postToRoom` 开新轮 |
| G3 | 显式 queue，以及显式新开、点名、非纯文本 | 不 steer；可以排队 / 新轮 |
| G4 | 私聊忙时 steer | 仍是 `UserMessageCell` 的 `kind === 'steering'`，不走群路径 |
| G5 | 群 draft 的 text-delta | 仍是一个流式气泡；正文写入 `replies` 后 draft 消失 |
| G6 | `channel.send` 与 composer | 都走同一个 `steerTarget`；composer 是 #18 的路径。`channel.send` 在 prompt 前同步 steer；composer 在 next-step splice 时走同一决定 |

纯函数测试：`node --test acceptance-cases/group-steer/group-steer.test.js`（不 import `@deepseek-ai`）。

3082 桌面截图（生成中发探针、进入 working 后再发）不在本环境里。合入 main 前由人在桌面跑 eval_bot，确认定稿后不再单独冒出一条只含探针的气泡。
