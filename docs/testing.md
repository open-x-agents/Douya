# 测试：八层，分别拦什么

层数不是目的。每一层只回答一个问题，问题答不上来就不该有这一层。

| 层 | 跑在哪 | 拦什么 | 现在 |
| --- | --- | --- | --- |
| L0 单元 | 每 PR / 每 push（`tests.yml`） | 代码本身坏了 | **有**，99 条 |
| L1 适配器契约 | 每 PR | 信源响应形状变了、只读适配器长出写方法 | 无（#10） |
| L2 归一化 / 去重 / 冲突 | 每 PR | 把两件事合成一件；`confidence<0.6` 被强行合并 | 无（#13） |
| L3 一天真数据 e2e | 每晚 + 手动 | 「08:45 早报 → 关一件 → 18:30 晚报」这条路走不通 | 无（#16） |
| L4 时延实测 | 随 L3 | 首屏 >1s、首字 >3s、提醒误差 >30s、日报偏差 >60s | 无 |
| L5 准入 | 每 PR（`pr-guard.yml`） | 没资格排队的 PR 进了队列 | **有**（只报告，不阻断） |
| L6 合并树 | 每 PR（`merge-tree.yml`） | 自己绿、合进 main 后破（含合不上） | **有**：每 PR 真合并一次再跑 L0（#23） |
| L7 发布前 | 发版 job（`release.yml`） | 测试绿但装不起来；版本/tag/CHANGELOG 不自洽；模型开始编来源 | **有**（模型那项等 `MODEL_API_KEY`） |

## 本地怎么跑

```sh
node --test test/*.test.js          # L0：单元测试（不联网，不需要 key）
node scripts/pre-release.mjs        # L7 全跑：单元 → 干净安装 → 版本一致性 → 真实模型
node scripts/pre-release.mjs --skip-version   # 版本号还没写出来时用这个（发版 workflow 就是这样调的）
node test/e2e/real-model.e2e.mjs    # 只跑真实模型那一段，需要 MODEL_API_KEY
node scripts/enqueue-guard.mjs --pr 12        # L5：对一个真 PR 跑准入（需要 GITHUB_TOKEN）
```

真实模型那段读三个环境变量：`MODEL_API_KEY`（必填）、`MODEL_BASE_URL`（默认 `https://api.deepseek.com/v1`）、`MODEL_NAME`（默认 `deepseek-chat`）。**没有 key 就失败，不跳过** —— 会跳过的那道闸等于没有。

## 三条纪律

1. **红就是红。** 不写 `|| true`、不写 `continue-on-error`、不写「已知失败」。要么修，要么把这条删掉并说明为什么不需要它。
2. **测试要能证明它会红。** 每加一条规则，我会真的把实现改坏一次，确认对应测试变红，再改回来。只有见过它红的测试才算测试。
3. **跑在合并结果上。** PR 页面的绿是「这个提交自己绿」，不是「它合进 main 之后绿」。两者不一致时，后者算数（这是 L6 存在的理由）。

## L5 准入的八条规则

写在 `scripts/enqueue-guard.mjs`，样例集在 `test/enqueue-guard.test.js`：

1. `Fixes #N` / `Closes #N`，且那个 issue 是 open；
2. `Ran:` 行里有真命令；
3. body 里的 40 位 sha 等于当前 head；
4. `tests` 在这个 head 上绿（不是「最后一次跑绿过」）；
5. 没有 `hold`；
6. 改动文件清单非空；
7. 改到 `index.js` 或 `src/host/**`：要么同 PR 改 `docs/architecture.md`，要么写 `Docs-not-needed: <理由>`；
8. `merge-tree` 在这个 head 上绿：自己绿、合到 main 上破的不算（没有这个 check 也算没有）。

`pr-guard.yml` 从 **base 分支** 取脚本，不在 PR head 上跑 —— 否则 PR 改掉守卫就能给自己放行。

## 已知的缺口

- **L5 现在只报告、不阻断**：`main` 没有保护，也没有 merge queue，没法在 GitHub 层挂成必需 check。等 owner 决定开不开保护（#22）。
- **L6 不串行、不自动合**：`merge-tree` 每个 PR 上真合并一次再跑 L0，拦的东西和 merge queue 一样，
  差的是两点 —— 两个 PR 同时绿地合进来仍可能互相踩，合入还得有人（或 Bot）按一下。仓库是 internal，
  merge queue 实测可用（规则集 201），但开它意味着没人能直接推 main 且发版流程要改走 PR，所以 #23 先做这一层。
  本地没有 `git`，这一段只能在 CI 上验证。
- **L7 的模型项在等 key**：仓库 secrets 里还没有 `MODEL_API_KEY`，所以下一次定时发版会红在这一步。这是故意的：先让它红一次，人就知道这道闸真的在。
- **L1 / L2 / L3 / L4 还没有**：随 #10、#13、#16 一起长。
