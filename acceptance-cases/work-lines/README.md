# 工作线索引（W1–W8）

一条工作线是一条已经存在的 DSH 会话。索引只保存 id、bot、session、房间线索和归档段的 session id。消息正文仍在会话日志里。bot 的 `MEMORY.md` 仍是该 bot 一份，`team/MEMORY.md` 路径不变。

| ID | 场景 | 期望 |
| --- | --- | --- |
| W1 | `getFullThread(id)` | 消息来自该会话的事件，不是索引上的副本 |
| W2 | 同一个 bot 两条线 | `sessionId` 不同；own `MEMORY.md` 仍按 bot id 一份 |
| W3 | 写入后再 `ensureLegacy` | 同一个 session 仍是同一个 line id |
| W4 | 线上有已归档 segment | 全文包含归档段；交接笔记不进索引 |
| W5 | 状态里还没有 `workLines` | 映射前 `room.sessions[botId]` 仍可投递；映射后私聊一条、每个成员会话一条 |
| W6 | 私聊和群会话都有 `live.turn` | `listByBot` 上两条都 busy；busy 不写入索引 |
| W7 | 一次 `turn/end`，同一 exchangeId 再来一次 | 回到 idle，不写 `closedAt`；完成事件只有一条 |
| W8 | 中途重启后续跑 | 会话再次 running 时仍 busy；`interrupted` / `disposed` 不发完成事件 |

`node --test acceptance-cases/work-lines/work-lines.test.js`

不实现入站路由、跨房间投影、完成重排。不改 #18 的 steer 判定。
