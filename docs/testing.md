# 测试：八层，分别拦什么

层数不是目的。每一层只回答一个问题，问题答不上来就不该有这一层。

| 层 | 跑在哪 | 拦什么 | 现在 |
| --- | --- | --- | --- |
| L0 单元 | 每 PR / 每 push（`tests.yml`） | 代码本身坏了；事模型与证据账本的四条不变量（#9：至少一条 source、关掉必须有出处、`due_at` 只存 UTC、一事多源不拆卡）与账本只追加 | **有**，294 条 |
| L1 适配器契约 | 每 PR | 信源响应形状变了、只读适配器长出写方法 | **部分**（`test/composio/*.test.js`：注册表与只读启动校验；适配器契约随 #32 S4） |
| L2 归一化 / 去重 / 冲突 | 每 PR | 把两件事合成一件；`confidence<0.6` 被强行合并 | 无（#13） |
| L3 一天真数据 e2e | 每晚 + 手动 | 「08:45 早报 → 关一件 → 18:30 晚报」这条路走不通 | 无（#16） |
| L4 时延实测 | 随 L3 | 首屏 >1s、首字 >3s、提醒误差 >30s、日报偏差 >60s | 无 |
| L5 准入 | 每 PR（`pr-guard.yml`） | 没资格排队的 PR 进了队列 | **有**（只报告，不阻断） |
| L6 合并树 | 每 PR（`merge-tree.yml`） | 自己绿、合进 main 后破（含合不上）；合出来的版本号撞已有 tag | **有**：每 PR 真合并一次再跑 L0，再用 `scripts/merge-tree-gate.mjs` 查一次撞号（#23） |
| L7 发布前 | 发版 job（`release.yml`） | 测试绿但装不起来；版本/tag/CHANGELOG 不自洽；模型开始编来源 | **有**（模型那项等 `MODEL_API_KEY`） |

## 本地怎么跑

```sh
node --test 'test/**/*.test.js' 'acceptance-cases/**/*.test.js'   # L0：单元测试 + 验收用例（不联网，不需要 key）
node scripts/pre-release.mjs        # L7 全跑：单元 → 干净安装 → 版本一致性 → 真实模型
node scripts/pre-release.mjs --skip-version   # 版本号还没写出来时用这个（发版 workflow 就是这样调的）
node scripts/pre-release.mjs --install-only   # 只跑干净安装：pack → 从 tgz 读 files 逐项核对仓库与 tgz → 空目录 import
node test/e2e/real-model.e2e.mjs    # 只跑真实模型那一段，需要 MODEL_API_KEY
node scripts/enqueue-guard.mjs --pr 12        # L5：对一个真 PR 跑准入（需要 GITHUB_TOKEN）
```

真实模型那段读三个环境变量：`MODEL_API_KEY`（必填）、`MODEL_BASE_URL`（默认 `https://api.deepseek.com/v1`）、`MODEL_NAME`（默认 `deepseek-chat`）。**没有 key 就失败，不跳过** —— 会跳过的那道闸等于没有。

## 四条纪律

1. **红就是红。** 不写 `|| true`、不写 `continue-on-error`、不写「已知失败」。要么修，要么把这条删掉并说明为什么不需要它。
2. **测试要能证明它会红。** 每加一条规则，我会真的把实现改坏一次，确认对应测试变红，再改回来。只有见过它红的测试才算测试。
3. **跑在合并结果上。** PR 页面的绿是「这个提交自己绿」，不是「它合进 main 之后绿」。两者不一致时，后者算数（这是 L6 存在的理由）。
4. **子目录里的 *.test.js 一律会被 CI 跑到。** 放到 test/<area>/ 不需要改任何命令；test/e2e/ 下的 .mjs 是故意不进 L0 的。

## L5 准入的九条规则

写在 `scripts/enqueue-guard.mjs`，样例集在 `test/enqueue-guard.test.js`：

1. 至少一条 issue 线索：`Fixes #N` / `Closes #N` —— 合入即关，所以那个 issue 必须 open；`Refs #N` —— 纯指针，不关任何单，指向已关闭的父单也算数（同一 issue 的后续刀就写这个）。
2. `Ran:` 行里有真命令。判据是**行首命令词**：该行（允许前置空白）以 `$ ` 开头，或以 `node`/`npm`/`npx`/`pnpm`/`yarn`/`git`/`gh`/`python`/`python3` 开头且后面是词边界；
   命令词只出现在散文里不算（`Ran: 我用 git 看过了`、`Ran: none` 都判 `missing-ran`）。裸 `Ran:` 之下**同一块**内的命令行也算，
   但到块边界就停（空行 / 下一个 `Ran:` / 最多 10 行），不往下全文找；
3. body 里的 40 位 sha 等于当前 head；
4. `tests` 在这个 head 上绿（不是「最后一次跑绿过」）；
5. 没有 `hold`；
6. 改动文件清单非空；
7. 改到 `index.js` 或 `src/host/**`：要么同 PR 改 `docs/architecture.md`，要么写 `Docs-not-needed: <理由>`；
8. `merge-tree` 在这个 head 上绿：自己绿、合到 main 上破的不算（没有这个 check 也算没有）；
9. `merge-tree` 的绿要比 **main 现在的 tip 新**：main 在你跑完之后又动过，这个绿就是陈的。
   用 `workflow_dispatch` 带 `pr` 对当前 main 重跑 `merge-tree`（结论写回 PR head），再重跑守卫，不用新提交。
   `tests` 没有陈旧一说：它测的是 head 那棵树，main 前进不改变它的结论。

`pr-guard.yml` 从 **base 分支** 取脚本，不在 PR head 上跑 —— 否则 PR 改掉守卫就能给自己放行。

守卫和 `tests`/`merge-tree` 是同一个事件同批启动的，所以脚本先按同一 sha 轮询到这两条 check 都
completed（`waitForChecks`：15 分钟窗口、15 秒读一次真实状态）再判；等不齐就报 `checks-timeout`
（没结论），不会把 in_progress 判成红。拒绝理由写进本 job 那条 `guard` check 的 output summary
与 step summary，人看 PR 页面就知道为什么。

## 已知的缺口

- **L5 现在只报告、不阻断**：`main` 没有保护，也没有 merge queue，没法在 GitHub 层挂成必需 check。等 owner 决定开不开保护（#22）。

> 实测纠正一条：GitHub 在 `pull_request` 上默认 checkout 的是 `refs/pull/<n>/merge`（PR 合到 base 的合成提交），
> 所以同仓 PR 的 `tests` 其实已经跑在合并结果上，不是「只跑 head」。真正漏的是两件事：main 在该次 run 之后又往前走了（绿变陈），
> 以及冲突的 PR 起不了这次 run。第 9 条只对 `merge-tree` 管前者（`tests` 测的是 head 那棵树，不算陈旧），
> `merge-tree` 用 `base.sha` 在跑的时候重新合一次、并且是一个能被守卫要求的名字。
- **L6 不串行、不自动合**：`merge-tree` 每个 PR 上真合并一次再跑 L0，拦的东西和 merge queue 一样，
  差的是两点 —— 两个 PR 同时绿地合进来仍可能互相踩，合入还得有人（或 Bot）按一下。仓库是 internal，
  merge queue 实测可用（规则集 201），但开它意味着没人能直接推 main 且发版流程要改走 PR，所以 #23 先做这一层。
  本地没有 `git`，这一段只能在 CI 上验证。
- **L6 的「版本号撞已有 tag」是保险，不是已发生的缺陷**：`package.json` 全史没有一次是 PR 顺手改版本号，
  今天真撞号也只是 `release-plan.mjs` 判 `tag-exists` 跳过、当天不发版。判据只有一条 —— PR 真的动了版本号
  （head 版本 ≠ merge-base 版本）时才拿 **head 的版本号** 去查 tag；写成「version ∈ tags 就红」会让所有 PR 变红，
  写成「merged vs base」会放过两个 PR 各自 bump 到同一个号的形态。同一条规则在 L7 也查，这里复用 `checkVersionConsistency`，
  L6 只报撞号，CHANGELOG 缺段属 L7。读不到任何 `v*` tag 时这道闸 `exit 2`（fail-closed）：没有 tag 列表就等于没判。
- **vendor 的 pin 由 `test/vendor-pin.test.js` 订住**（#23 第一刀）：`vendor/ds-bot/VENDOR_FROM`、`docs/vendor-ds-bot.md`、
  `vendor/ds-bot/package.json` 的版本、根 `package.json` 的 peer 下限四处是手写副本，一起改才一致，单改一处会红。
- **L7 的模型项在等 key**：仓库 secrets 里还没有 `MODEL_API_KEY`，所以下一次定时发版会红在这一步。这是故意的：先让它红一次，人就知道这道闸真的在。
- **L1 / L2 / L3 / L4 还没有**：随 #10、#13、#16 一起长。
