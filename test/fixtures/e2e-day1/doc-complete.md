Status: 跑通

# 一天真数据 e2e 记录（夹具）

这是 `test/fixtures/e2e-day1/run-complete.json` 的配套文档：判定器的正例。
它证明「记录合格 + 文档写成跑通」能过 2/2；每一类坏记录各有一条用例证明会红。

## 环境

| 项 | 值 |
| --- | --- |
| sha | `5b21385502336b8daa91c42a01ae52b9ca881fbf` |
| 时区 | Asia/Shanghai |
| 机器 | fixture-host |
| 起点 / 终点（UTC） | 2026-10-31T00:44:00Z / 2026-11-01T01:30:00Z |
| 谁跑的 | fixture 夹具（不是真人跑出来的结果） |

## 一天时间线

四步：早报 08:45 → 关一件 → 晚报 18:30 → 次日再看；每个数字都在 `run-complete.json` 的 `steps` 里。

## 面板数字

提交率 2/3（`report:lisi:2026-10-31`、`report:wangwu:2026-10-31`）；未交 1 人（`member:zhaoliu`）。

## 时延四项

| 项 | 预算 | 实测 |
| --- | --- | --- |
| 首屏 | 1000ms（server 与 browser 分开记） | server_ms 180 / browser_ms 420 |
| 追问首字 | 3000ms | first_token_ms 900（口径 ≠ 面板内追问） |
| 提醒误差 | 30000ms | error_ms 1200 |
| 日报偏差 | 60000ms | delay_ms -800 |

## 20 句抽查

这一刀不判这一段（samples 段随后续切片补）；真跑后 20 行表格在这里。

## 失败场景

夹具里有一次 `gcal` 认证失败：日报照发、标注缺源，`resumed_at` 在其后。

## 零写操作

夹具里只有 `GET` 请求。

## 截图

`docs/e2e-day1/shots/` 五张（夹具用 `test/fixtures/e2e-day1/shots/` 代替）。

## 复现

```sh
node --test test/e2e-day1-check.test.js test/e2e-day1-doc.test.js
```

## 卡在哪

无。这一天跑通了。
