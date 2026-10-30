# 同 bot 跨房间投递（C1–C5）

继续或 steer 另一间房里的工作线时，模型回合仍在那条线自己的 `sessionId` 上。到达的房间只追加这一句用户话和这次回复，并把它的 `lastRoomId` 改成这间房。房间 A 的旧句子留在 A，不进 B 的 `room.log`，也不进其他成员的 `roomPrompt`。

工作线索引仍不保存消息正文。bot 自己的 `MEMORY.md` 还是按 bot 一份，`team/MEMORY.md` 留在原地，这次投递不改它。

| ID | 场景 | 期望 |
| --- | --- | --- |
| C1 | 房间 A 打开 S1，房间 B 继续 S1 | 回合在 S1 的 `sessionId`；B 只看到这次问答；同一个 bot 仍是一份 own `MEMORY.md` |
| C2 | 房间 B 里一个对不上 S1 的新话题 | 不往 S1 的会话 append 或 steer |
| C3 | 另一个 bot 的 `getFullThread` / `listByBot` | 看不到 S1 |
| C4 | 继续之后，B 里其他成员的 `roomPrompt` | prompt 和 `room.log` 没有 S1 的旧句子，只有这次新写的 |
| C5 | 继续前后 | `team/MEMORY.md` 还在，内容不被这次改写 |

`node --test acceptance-cases/work-line-cross-room/cross-room.test.js`

路由的先后顺序不在这里改。不把 S1 的旧消息投影进 B 的时间线。不重排完成记录。
