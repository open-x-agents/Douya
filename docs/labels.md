# 标签流程

标签是流程的入口，不是备注。谁能把一个 issue 变成「可开工」，谁就能让它被自动化动起来 —— 所以每个标签都写明了谁可以打。

这套规则从 FlyBot 的交付流程搬来，去掉了一个在这里跑不起来的部件（见文末「没有搬过来的」）。

## 四组标签

**类型（type，恰好一个）**：`bug`、`enhancement`、`documentation`、`accessibility`。

**范围（area，一到多个）**：

| 标签 | 范围 |
| --- | --- |
| `area:source` | 信源适配器、归一化与去重、证据账本（GitHub / Composio / 飞书） |
| `area:panel` | 每日面板与页面，按 `design/demo.html` |
| `area:chat` | 对话、子会话、入站路由与编排 |
| `area:scheduler` | 调度器、时延预算、桌面通知 |
| `area:testing` | 测试分层、CI、发布前验证 |
| `area:release` | 发布、版本、CHANGELOG |
| `area:docs` | 文档与设计记录 |
| `area:security` | 密钥、权限、只读边界 |

**状态（state，至多一个）**：`needs-info`、`needs-human`、`agent-ready`、`agent-working`、`agent-pr`、`hold`。

**性质（kind）**：`umbrella` —— 伞单/追踪单，**永不** `agent-ready`；它靠子单推进。

## 谁能打哪个

| 标签 | 谁打 | 说明 |
| --- | --- | --- |
| type、area | 提单的人；triage 可纠正 | 只影响检索，不影响开工 |
| `needs-info`、`needs-human`、`agent-ready` | 只有 triage | 这三个是开工闸门，只能由做出判断的那一步打，并在评论里写判断依据 |
| `agent-working`、`agent-pr` | 只有动手的 Bot | 开工时自己打 `agent-working`，开 PR 时自己打 `agent-pr`，不代打 |
| `hold` | 只有本人 | 人打人解；自动化看到 `hold` 一律不碰，也**不许**自己摘掉 |
| `umbrella` | 提单的人 | 标了就不再单独开工 |

## 状态怎么走

```
（新单） ──triage──> needs-info  ──补齐──┐
              └───> needs-human ──本人拍板──┤
                                            ├──> agent-ready ──动手的 Bot──> agent-working ──开 PR──> agent-pr ──合入──> 关闭
                                            │
                              hold（本人）───┴──> 任何时候压住，摘掉才恢复
```

`agent-ready` 的三个条件，缺一个就只能 `needs-info` 或 `needs-human`，并在评论里写清楚卡在哪：

1. 设计冲突全部有结论（本人设计规则、已记录的决定、RFC/决策单、其他开放 issue 与 PR），且没有留给本人的开放问题。
2. 预期行为和改动范围是明确的 —— 一条验收标准对应一个切片。
3. 不是 `hold`、不是伞单/追踪单。

## 只在 `agent-ready` 上动手

自动化只做 `agent-ready` 的单。没到 `agent-ready` 就写代码，等于用代码替本人做设计决定。

一条 issue 一个 PR：PR 体里写 `Fixes #N`，并打 `agent-pr`。

## 每一步的写都署名

所有 Bot 共用一个 GitHub 账号（`Birfy`），所以归属只存在于文字里：每一次改动状态的动作（评论、PR 体、issue 体）第一行写 `Written-by: <Bot 名>`。

结论（`Verdict:`）是唯一例外：第一行是结论本身，`Written-by:` 放第二行。

## 没有搬过来的：`risk:T*`

FlyBot 的 `risk:T0`–`T3` 由一个轮询的 controller **按 diff 算**，Bot 不许手打。这里没有那个 controller，所以没有这组标签 —— 手打的 `risk:T*` 只是又一个没人验证的说法。等这里的风险分级由 CI 从 diff 算出来再补，补的时候规则照搬：只有算出来的那份算数，标签只作展示。

## 现在的盘面

- type / area / umbrella 已经打到所有开放 issue 上。
- `#33` 是 `agent-working`：正在做第一个切片。
- `needs-info` / `needs-human` / `agent-ready` 由 triage 那一步逐个判，不批量刷。
