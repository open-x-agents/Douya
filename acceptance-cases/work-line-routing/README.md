# 入站路由（R1–R16）

房间里的用户消息先决定落在哪一条工作线：`steer`、`continue`、`create`、`ask` 或 `queue`。同一条判定给桌面 composer、`drainRoomInbox` 和 `channel.send` 用。

当前房间里这个 bot 正好有一条忙线，而且用户没有新开、点名或排队时，这条线直接 steer（包括 `DEMO_STEER_OK`、「继续」、「这段改短」）。相关性只用于多条忙线，以及历史线和新建之间。忙本身不是把消息拨过去的理由。

低置信度给出一张路由卡（`pendingRoutes`），不是 `ask_user`，超时也不会发出去。`/api` state 的 `view` 带上 `pendingRoutes`。确认之前不投递，也不写新的 `room.log` 行。确认可以是 `续：` 加标签，或正文里的那条线 id / 会话 id。确认会先落盘清掉卡片，再把原来的用户正文投到那条线上。

桌面 composer 一旦把消息判走，会在房间回合读到这句话之前压住 `group_relay`，所以不会写空 User 行，也不会让管理员多说一轮。`create` 会给新会话套上这个 bot 的模型再投递，用户正文留在会话里，这条线才能变成忙，之后的本地单忙才会 steer。

这条切片只断言选中了哪一条线，不会把另一间房的旧消息抄进当前 `room.log`。

| ID | 场景 | 期望 |
| --- | --- | --- |
| R1 | 当前房间一条忙线；`DEMO_STEER_OK` | steer 这条（#18） |
| R2 | 一条本地忙线未命中，另一条空闲线命中 | continue 那条历史；不 steer |
| R3 | 正文以 `新开` 或 `/new` 开头 | create；不 steer |
| R4 | `续：` 加标签，或卡片上的 id | 那条线；忙则 steer，否则 continue |
| R5 | 显式排队 | followup，`steer: false` |
| R6 | 没有忙线；唯一历史命中 | continue |
| R7 | 没有忙线；没有命中 | create |
| R8 | 两条忙线；只有一条命中开头和草稿 | 只 steer 那一条 |
| R9 | 两条忙线都未中或都命中 | ask；都不 steer |
| R10 | 出示路由卡 | 没有模型回合；`room.log` 不新增；确认前不投递 |
| R11 | 卡片默认高亮 | 最近更新的忙线，否则最近的一条 |
| R12 | 正文有 `@Name`；另有 `message_bot` | `@` 只选定 bot；`message_bot` 不经过路由器 |
| R13 | 一条本地忙线；「继续」或「这段改短」 | steer |
| R14 | 强匹配线的 `lastRoomId` 是另一间房 | continue 那个 id；当前 `room.log` 只多这一句，不出现它的旧消息 |
| R15 | 桌面 composer 进房间会话 | 判定在用户消息和 `drainRoomInbox`，不只在 `channel.send` |
| R16 | 忙线只在另一间房 | 不因为那边在忙就 steer；命中、询问或新建 |

`node --test acceptance-cases/work-line-routing/routing.test.js`

不改 `message_bot` 的 steer。不调用 `ask_user`。不用 `matchThread` 做决定。
