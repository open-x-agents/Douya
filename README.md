# opendigitalmate

飞书里的数字同事，基于 **ds-bot**（`Fei2411/DeepSeek-Bot` 的 DSH 插件）开发：接日报、盯日程、卡片可点，配一个面板。

## 现在有什么（v0.1.0，可跑通）

| 能力 | 状态 | 在哪里 |
| --- | --- | --- |
| 飞书接入 | 复用 ds-bot 的长连接通道（`core/src/host/feishu-inbound.js` + `feishu-sdk.js`），本包只负责发卡片 | `src/host/feishu.js` |
| 日报 | 按成员汇总当天日程、已完成、明天计划，组装成飞书交互卡片 | `src/host/report.js`、`src/host/cards.js` |
| 日程提醒 | 从日历事件算出「会议前 N 分钟」，到点推送，失败重试 | `src/host/reminders.js`、`index.js` 的 `tick()` |
| 可交互 | 卡片按钮回调：推迟 10 分钟 / 已完成 / 改时间 / 补充日报 | `src/host/cards.js`、`index.js` 的 `onCardAction()` |
| 面板 | 单页：提交率、还没交的人、近期日程、投递记录 | `src/client/panel.html`、`src/host/panel.js` |

单元测试全绿（`node --test test/*.test.js 'acceptance-cases/**/*.test.js'`），覆盖日报组装、提醒规划、卡片结构、按钮解析、面板快照、存储、插件接线、群聊忙时 steer 验收（G1–G6）、忙时连续接收与定稿验收（L1–L7）、工作线索引验收（W1–W8）、入站路由验收（R1–R16）、同 bot 跨房间投递验收（C1–C5），以及同房间多条工作线完成投影验收（D1–D8）。

## 跑起来

```sh
node --test test/*.test.js 'acceptance-cases/**/*.test.js'   # 全部测试，不需要网络和 key
node scripts/demo.mjs          # 打印一张日报卡和一张提醒卡（不发出去）
```

装进 DSH 之后（和 ds-bot 一样按插件挂载）。本地 Web 不要只加这一段：profile 的 bundles 还得含 `ds-bot`，并且 `vendor/ds-bot` 里要有 `deep-view`。完整步骤见下面的「本地 DSH Web（Bot 模式）」。

```yaml
# cordis 补丁里加一行
- insert:
    - id: opendigitalmate
      name: opendigitalmate
```

插件读的配置：

| 配置 | 说明 |
| --- | --- |
| `credentials()` | 返回 `{ appId, appSecret }`；不传就走 `createFeishuSender` 的默认读取 |
| `calendar()` | 返回该成员的事件数组 `{ id, summary, start, end, location, owner }`，由调用方接飞书日历 |
| `sendCard({ receiveId, card })` | 覆盖默认的飞书发送（测试里注入桩） |
| `ownerOpenId` | 没人认领的提醒发给谁 |
| `leadMinutes` | 提前几分钟提醒，默认 10 |

## 本地 DSH Web（Bot 模式）

开发机上用 `scripts/setup-opendigitalmate-web.sh` 把本仓库挂进 DeepSeek Harness 的 Web profile。它只检查和补齐挂载，不改插件运行时。

固定布局（目录名可以不是 `ds_dev`，上下级关系要一致）：

```
<ROOT>/                          # 例如 ~/Documents/ds_dev
  dsh-web.sh
  deepseek-harness/
  tools/bin/pnpm                 # bash dsh-dev.sh setup 之后才有
  data/web/harness/profiles/web/ # 本脚本写入
  openDigitalMate/               # 本仓库，与 deepseek-harness 并列
    scripts/setup-opendigitalmate-web.sh
    vendor/ds-bot/
```

本仓库的上一级就是 `<ROOT>`。仓库不在那个目录里时，先 `export DSH_DEV_ROOT=<ROOT>`（含 `dsh-web.sh` 的那一层）。被 link 的是你正在跑脚本的这个仓库。

```sh
bash scripts/setup-opendigitalmate-web.sh check   # 只看缺什么
bash scripts/setup-opendigitalmate-web.sh setup   # 补齐 profile、cordis insert、deep-view
bash scripts/setup-opendigitalmate-web.sh start   # 检查通过后转调 bash dsh-web.sh start
```

脚本不代替 harness 自身的构建。先在 `<ROOT>` 准备好 `deepseek-harness` 和 `dsh-web.sh`（`dsh-dev.sh setup`、`dsh-web.sh build`）。它补上以前容易漏、会导致「不是 Bot 界面」或 `ds-bot failed to import` 的几步：

1. profile 的 `bundles` 含 `ds-bot`（只有 `opendigitalmate` 会变成非 Bot 界面）
2. dependencies 用 `link:` 指向本仓库的 `vendor/ds-bot` 和仓库根
3. `cordis.patch.yml` insert `opendigitalmate`（已有的 LLM / UI 配置保留，只追加）
4. 在 `vendor/ds-bot` 里 `npm install --omit=dev`，装上 `deep-view`

在 macOS 上跑，不要用 sudo，需要 Node.js >= 24.9。`setup` 会重写 `profiles/web/package.json`。

## 两个刻意的设计

**提醒的 key 是「事件 + 到点时刻」**，不是事件 id。所以「推迟 10 分钟」是一次新的投递，而不是把已经发过的标记改掉；原提醒不被修改。

**晚到的 tick 也要发**。会议还没开始时，即使提醒的预定时刻已经过去，也立刻发出去——漏掉一分钟不该等于漏掉这场会。

## 目录

```
index.js             插件入口：apply/createRuntime、tick、卡片回调、定时器
src/host/            纯逻辑：report / reminders / cards / panel / store / feishu
src/client/panel.html 面板单页（无构建步骤，直接由插件托管）
test/                node:test，110 条
scripts/demo.mjs     一次性的可视化输出
scripts/setup-opendigitalmate-web.sh  本地 DSH Web（Bot 模式）check / setup / start
docs/architecture.md 架构、数据形状、与 ds-bot 的边界
docs/labels.md       标签流程：谁能把一张单变成「可开工」
```

## 还没做

- 飞书应用的 app_id/app_secret 与权限（`im:message`、`calendar:calendar`、卡片回调地址）需要有人去开放平台建应用
- 日历数据源：现在是注入的 `calendar()`，要接 `calendar.v4.calendar_event.list` 并处理成员 OAuth
- 日报的「收集」环节：现在是 `recordReport()` 接口，还没有「在飞书里点开表单填写」的卡片流
- 部署：Dockerfile 还没有

## 对话层：聚合输入与跨时间认话题（v0.2）

| 能力 | 在哪里 | 规则 |
| --- | --- | --- |
| 聚合输入 | `src/host/buffer.js` | 同一个人在同一个会话里连发几条 → 合并成一轮。窗口 3 秒，每来一条窗口往后滑；总上限 20 秒，超过就先把已说的发出去；重复的同一句只留一条；两个人同时说话不会并成一条 |
| 跨时间认话题 | `src/host/threads.js` | 中文按二字词切、英文按单词切，算重合度，再按「上次说话到现在」的时间折半衰减（半衰期 72 小时）。过了阈值就并进旧话题，没过就开新话题——所以隔一周回来说「上次那个日报」，仍然对得上 |
| 话题维护 | 同上 | `touchThread` 加词、更新时间；`pruneThreads` 只留最近 50 个、30 天没动的丢掉 |

这两个模块都是纯函数 + 注入时钟，测试里有假定时器，所以「等到 3 秒」和「隔一周」都不用真的等。
