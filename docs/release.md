# 发版：两种 tag，不要混

桌面安装包和源码版不是同一条发版线。

- **`v*`**（目前的稳定版：[v0.1.0](https://github.com/open-x-agents/openDigitalMate/releases/tag/v0.1.0)）：下面这份 `release.yml` 每天打的源码 / changelog 版。GitHub 的 [/releases/latest](https://github.com/open-x-agents/openDigitalMate/releases/latest) 指向这里，**没有** Windows / macOS / Linux 安装包。
- **`desktop-v*`**（当前预发布：[desktop-v0.1.0-rc7](https://github.com/open-x-agents/openDigitalMate/releases/tag/desktop-v0.1.0-rc7)）：`.github/workflows/desktop.yml` 在 `desktop-v*` tag 或手动触发时打的 Electron 安装包。要装桌面应用，请用这个页面，不要用 Latest。

下面是 `v*` 那条线怎么跑。

## 每天一个 `v*` 版本

`.github/workflows/release.yml` 每天 02:00（Asia/Shanghai）自己跑一次，也接受手动触发。它不需要人点任何按钮。

## 顺序

1. **pre-release 预检**（`scripts/pre-release.mjs --skip-version`，全绿才往下走）：
   - **单元测试**：`node --test 'test/**/*.test.js' 'acceptance-cases/**/*.test.js'`，跟 `tests.yml` 同一条命令；
   - **干净安装**：`npm pack` → 装进空目录 → 真的 `import` 一次，并检查 `package.json.files` 里没写不存在的路径；
   - **真实模型 e2e**：结论必须每条都可追源，缺一个信源必须说「还没读到」而不能编。
2. **新东西闸**：上一个 `v*` tag 之后没有提交，就**不发**，日志与 step summary 里写一行「今天不发」。空版本不是进展。
3. **算版本**：第一次发布用 `package.json` 里的版本；之后每天升补丁号。有人手动改过且比 tag 新，就尊重那个数字。
4. **写**：`CHANGELOG.md` 顶部插一段（日期按 Asia/Shanghai），`package.json` 的 `version` 改成新号。
5. **自检**：版本、要打的 tag、CHANGELOG 顶部三者不一致就停在提交之前，不留半成品。
6. **交**：一次提交 `release: vX.Y.Z` 推回 `main`，打附注 tag，`gh release create` 写这一页。

## 真实模型那一项要一个 secret

仓库 secrets 里需要有 `MODEL_API_KEY`（可选 `MODEL_BASE_URL`、`MODEL_NAME`）。**缺 key 时发版会红在这一步，当天不发版本。**

这是故意的：会跳过的那道闸等于没有。要让发版恢复，就在仓库 Settings → Secrets 里加一个 key，不需要改代码。

## 一个刻意的取舍

用 `GITHUB_TOKEN` 推送的提交**不会**再触发 `tests.yml`（GitHub 防止工作流互相点燃）。所以测试放在**同一次运行里、升版本之前**跑：版本里装的仍然是绿过的东西，只是那一趟不会在 `main` 上多出一条 check。

## 失败怎么读

| 红在哪 | 含义 | 怎么办 |
| --- | --- | --- |
| Pre-release 预检 → 单元测试 | 代码坏了，跟发版无关 | 修测试 |
| Pre-release 预检 → 干净安装 | 打出来的包装不起来（`files` 清单漏了东西） | 修 `package.json` |
| Pre-release 预检 → 真实模型 e2e | 模型开始编来源，或超时 | 看打印出的那几行，改提示词或降级 |
| Release → 跳过 | 今天没有新提交（正常退出，不是失败） | 什么都不用做 |
| tag 推出去了但 release 没发 | 上一轮半途失败 | 下一轮自动补发同一个 tag，不升版本、不会出现两个 tag 指同一版 |

## 不做什么

- 不部署、不发布到 npm registry（只验证 tgz）。
- 不因为「今天该有一条」而造一个空版本。
- 不改别人的提交：`release:` 开头的版本提交本身不计入第二天的 CHANGELOG。

## 以后会变的一处

现在发版是**直接推 `main`**，因为 `main` 还没有保护。等启用保护 + 合并队列（#23），这一步要改成走队列；那时需要一个能触发 check 的 token，见 #22。
