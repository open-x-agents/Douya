# 发版：每天一个版本

`.github/workflows/release.yml` 每天 02:00（Asia/Shanghai）自己跑一次，也接受手动触发。它不需要人点任何按钮。

## 顺序

1. **测试闸**：`node --test test/*.test.js`，跟 `tests.yml` 同一条命令。红在这里就结束，不留 tag。
2. **新东西闸**：上一个 `v*` tag 之后没有提交，就**不发**，日志与 step summary 里写一行「今天不发」。空版本不是进展。
3. **算版本**：第一次发布用 `package.json` 里的版本；之后每天升补丁号（`0.1.0` → `0.1.1`）。有人手动改过 `package.json` 且比 tag 新，就尊重那个数字，不越过它再跳一次。
4. **写**：`CHANGELOG.md` 顶部插一段（日期按 Asia/Shanghai，条目是这段时间的提交标题），`package.json` 的 `version` 改成新号。
5. **交**：一次提交 `release: vX.Y.Z` 推回 `main`，打附注 tag，`gh release create` 写这一页。

## 一个刻意的取舍

用 `GITHUB_TOKEN` 推送的提交**不会**再触发 `tests.yml`（GitHub 防止工作流互相点燃）。所以测试放在**同一个 job 里、升版本之前**跑：版本里装的仍然是绿过的东西，只是那一趟不会在 `main` 上多出一条 check。

## 失败怎么读

- **labelled 红在 Tests**：代码坏了，跟发版无关，去修测试。
- **红在 Release**：看 step summary 那一行，是「跳过」还是真失败。跳过是正常退出，不是红。
- **tag 推出去了但 release 没发出来**：下一轮会自动补发同一个 tag 的 release，不会升版本、不会出现两个 tag 指同一版。

## 不做什么

- 不部署、不发布到任何 registry。
- 不因为「今天该有一条」而造一个空版本。
- 不改别人的提交：`release:` 开头的版本提交本身不计入第二天的 CHANGELOG。
