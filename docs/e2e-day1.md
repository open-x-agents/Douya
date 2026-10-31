Status: 跑不通

# 一天真数据 e2e 记录（#16）

这一份记录的是「一天真数据」跑下来的样子：08:45 早报 → 用户关掉一件 → 18:30 晚报 → 第二天回来还看得到。
只写跑出来的东西：没跑到的写 `null` 和缺哪个 issue 的字段，不估算、不美化。

## 环境

| 项 | 值 |
| --- | --- |
| 记录来自的 main | `e7239659ac05e10c23e076185d0166a6a1c07534`（写这条时读到；开工时是 `5b21385`，#46 在 08:42Z 合入后刷新；真跑时换成被跑的那次 commit） |
| 时区 | Asia/Shanghai |
| 机器 | 未跑（还没有真实运行） |
| 起点 / 终点（UTC） | 未跑 |
| 谁跑的 | 未跑 |

## 一天时间线

还没有真实运行，四步都是空的：

| 步 | 本地截止 | 发生时刻（UTC） | latency_ms | deadline_ms |
| --- | --- | --- | --- | --- |
| 早报 `morning_report` | 08:45 | 未跑 | `null` | `null` |
| 关一件 `closure` | — | 未跑 | — | — |
| 晚报 `evening_report` | 18:30 | 未跑 | `null` | `null` |
| 次日再看 `next_day_view` | — | 未跑 | — | — |

## 面板数字

还没有面板快照。真跑后这里写提交率与未交数两个值，以及各自的 `report:` / `member:` ref；
机器可读的那份放在 `run.json` 的 `panel`（`member_ids` / `report_keys` / `numbers`）里，
判定器按它复算并核对这里写的值。面板今天（#46 合入后）有 day 契约的 ① 首屏，
提交率 / 未交两张卡仍从 `state.reports` 算；快照里的每件事只给信源的类型名，没有逐句 `source.ref`。

## 时延四项

| 项 | 预算 | 实测 | 口径 |
| --- | --- | --- | --- |
| 首屏 | 1000ms（浏览器） | `null` | #46 已落 day 契约的 ① 首屏，但还没有一次真跑：`server_ms` 与 `browser_ms` 要分开实测、不合并（#15 收尾时补） |
| 追问首字 | 3000ms | `null` | 面板内追问入口还没有（#34 只合了引擎 `src/host/ask.js`，第五幕的常驻输入框未落）；只能按 `test/e2e/real-model.e2e.mjs` 同口径直连量，口径 ≠ 面板内追问 |
| 提醒误差 | 30000ms | `null` | 今天就能算（`sent[eventId@fireAt]` 的投递时刻 − `fireAt`），但还没有真跑 |
| 日报偏差 | 60000ms | `null` | 缺 #14 的投放记录：`deliveries` 里还没有 `kind=report` 的条目，日报本身也还不存在 |

## 20 句抽查

还没有抽样池：面板快照里的每件事只有信源类型名与 `closure.evidence_ref`，没有逐句的 `source.ref`
（缺 #9 的证据账本与 `explain()`），`docs/e2e-day1/panel-facts.json` 只能是空数组。
池子不足 20 条时判定器直接报「池子不足 20 条」，**不手写补满**。

## 失败场景

还没有真跑，所以还没有一次真实失败。「时延四项」「20 句抽查」里的空缺正是它的下游：
等 #9 / #14 的字段落地、真跑一遍之后，才有「缺源仍出报」这件事可记。

## 零写操作

还没有真跑，`docs/e2e-day1/requests.json` 还没有请求记录。只读钩子
`scripts/e2e-day1-fetch-log.mjs` 按分步随后续切片补，写完才能证明「日志里无写请求」。

## 截图

五张截图（`morning-report.png` / `closure.png` / `evening-report.png` / `missing-source.png` /
`next-day.png`）等真跑那一步产出，放在 `docs/e2e-day1/shots/`；现在一张都没有。

## 复现

这一刀只装闸，不判真跑；下面两条命令是现在就能跑的：

```sh
node --test test/e2e-day1-check.test.js test/e2e-day1-doc.test.js   # 判定器自己的用例
node scripts/e2e-day1-check.mjs docs/e2e-day1.md                    # 现在：NO-RUN 今晚还没跑（exit 2）
```

真跑那一步的命令等依赖合入后写，不写没跑过的命令。

## 卡在哪

这一刀先把闸装起来：判定器只有 `status` / `doc` 两段（末行 `PASS 2/2`），
`samples` / `latency` / `failure` / `writes` / `day2` 五段与采集器、只读钩子、nightly 作业按分步随后续切片补。
真跑今天跑不起来，卡在这些：

- **#9 证据账本**：`src/host/normalize.js` 只给「事」挂 `sources[]`，没有账本也没有 `explain()`；PR #38 仍是 draft。→ 20 句指不到 `source.ref`。
- **#10 GitHub 只读适配器**：PR #39 仍是 draft，`sources_used` 里还没有可登记的真实信源。
- **#11 Composio（日历 / 邮件）**：`needs-human`。
- **#12 飞书应用**：要本人建应用并给凭证。
- **#14 08:45 / 18:30 与日报投递记录**：`REPORT_HOUR = 18` 全仓只在一处，投递记录里还没有 `kind=report`；#43 未合（#40 已合）。→ 日报 ±60s 无从实测。
- **#15 面板**：快照里的每件事只有信源类型名与 `closure.evidence_ref`，没有逐句 `source.ref`；四种坏状态与其余卡片还没落。→ 抽样池为空。
