# 群聊询问与引用（G1–G10）

Web 群聊里，入站路由需要选工作线时要留下一张可确认的卡，并且用户原句进 `room.log`。迟回复引用的是这句用户原句，不是后来的机器人行。机器人的气泡不能画成用户的原问题。

`effectsOf` 的 `writeLog` 和 `copyTranscript` 仍是 false。这一句由 `applyRouteDecision` 写入当前房间；hold 和确认不再追加；另一间房的旧句子不复制。确认走原来的发送口，选项 id 不是用户句子。

| ID | 场景 | 期望 |
| --- | --- | --- |
| G1 | `@Chief`，Chief 有两条忙线，文档与这句话不重叠 | ask；选项都是 Chief 的线；不投递；`room.log` 多这一句 User |
| G2 | 卡片还在时发一句对不上的话 | hold；卡片不变；这句不进日志 |
| G3 | 用选项 id 确认 | 落盘清掉卡片之后才 steer；投递的是原句；id 不进日志 |
| G4 | 最后一行是机器人，然后 create | 新线的 `quote.seq` 是新的 User 行，不是机器人的 seq，也不是 0。`ensureLegacy` 不给机器人 seq 盖引用，清掉已经指到机器人行的引用，留下指到 User 行的引用 |
| G5 | continue 到一条引用着机器人 seq 的线 | 引用改到这句 User；下一句再 continue 只追加日志，不改引用 |
| G6 | 引用 seq 是 alice 的机器人行，完成事件上有用户原句 | 引用行是用户原句且 `who` 为 User；没有用户原句时不画引用；用户原句优先于截短的 `quoteText` |
| G7 | 一个格子里只有 alice 的评分，没有这条工作线的锚 | bob 的完成不进这个格子。有 bob 的 `working` 行才留下。两条 `working` 仍按 `completedAt` 排 |
| G8 | 迟回复的引用 | 用户 seq 取到原句；机器人 seq 不是原句。`groups.js` 用 `lateCite`，`acceptRoomSteer` 把 `quoteText` 交给投递，投递源带上 `quoteText` |
| G9 | 跨房间 continue | 当前房间只多这一句 User；另一间房不变；旧句子不出现在这里 |
| G10 | Web 客户端 | 状态仍发布 `pendingRoutes`。房间 dock 读这张卡。`completion-quote` 只有 `who === 'User'` 才用 `bt-urow`。迟回复用带字的引用。路由器仍没有 `ask_user` 和定时器 |

`node --test acceptance-cases/group-ask-quote/group-ask-quote.test.js`

不 import `@deepseek-ai`。不改打分阈值，不调用 `ask_user`，不加定时器。
