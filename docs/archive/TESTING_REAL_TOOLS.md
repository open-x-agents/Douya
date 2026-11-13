# 測試真實 Composio 工具集成

## 前提條件
- GitHub 已連接（account ca_zH4rAcTcHAfi, status ACTIVE）
- DeepSeek 模型已配置
- `npm start` 運行中

## 測試場景

### 場景 1：待處理 PR（真實工具調用）

**測試步驟：**
1. 打開 http://localhost:7777
2. 在聊天框輸入："待處理 PR"
3. 點擊發送

**預期行為：**
```
第1步 - 模型理解意圖：
  用戶想查看 open 狀態的 Pull Requests

第2步 - 模型調用工具：
  返回 JSON: {
    "tool_calls": [{
      "name": "github_list_pull_requests",
      "arguments": {"state": "open", "per_page": 5}
    }]
  }

第3步 - 系統執行工具：
  POST https://backend.composio.dev/api/v3/tools/execute/GITHUB_LIST_PULL_REQUESTS
  with { user_id: "default", arguments: {state: "open", per_page: 5} }
  
  返回真實 PRs from connected GitHub account

第4步 - 模型收到工具結果：
  系統注入消息: "工具調用結果：\n{pullRequests: [...], count: N}"

第5步 - 模型生成最終回复：
  {
    "text": "你有 N 個待處理 PR",
    "cards": [
      {
        "type": "info",
        "title": "feat: add composio",  // 真實 PR 標題
        "description": "#42 · cursor/redesign-card-ui-e793",  // 真實數據
        "url": "https://github.com/..."  // 真實鏈接
      }
    ]
  }
```

**❌ 不應該出現：**
- "我暫時沒有想法，您可以換個問法試試"
- "換個方式問" 卡片
- 虛假的項目名稱（如"官網改版"、"客戶管理後台"）
- 按鈕值為 `github_pull_requests` 之類的 ID

**✅ 正確行為：**
- 顯示真實 PR 標題和編號
- 卡片鏈接到 GitHub PR 頁面
- 如果沒有 PR，誠實告知 "沒有待處理 PR"

---

### 場景 2：我的倉庫

**測試：** "我的倉庫" 或 "list my repos"

**預期：**
- 調用 `github_list_repos`
- 返回真實倉庫列表（Douya, ...）
- 每個卡片顯示 stars, language, 更新時間

---

### 場景 3：今天的日曆事件

**測試：** "今天有什麼安排"

**預期：**
- 調用 `calendar_list_events` with timeMin/timeMax = today
- 返回 Google Calendar 真實事件（如果已連接）
- 如果 Calendar 未連接，誠實告知並提供 "前往設置" 按鈕

---

### 場景 4：最近的郵件

**測試：** "最近的郵件" 或 "recent emails"

**預期：**
- 調用 `gmail_list_recent`
- 返回 Gmail 收件箱真實郵件
- 如果 Gmail 未連接，提示連接

---

### 場景 5：模型未配置

**測試：**
1. 刪除模型配置：`rm ~/.local/share/opendigitalmate/config.json`
2. 重啟 `npm start`
3. 發送任意消息："你好"

**預期：**
```json
{
  "text": "模型未配置。請先在設置中配置 LLM 模型",
  "cards": [{
    "type": "error",
    "title": "錯誤",
    "description": "模型未配置。請先在設置中配置 LLM 模型",
    "actions": [{"label": "前往模型設置", "value": "打開模型設置頁面"}]
  }]
}
```

**❌ 不應該出現：**
- "收到！我可以幫你管理任務..." 之類的假回复
- "快速操作" 卡片

---

## 驗證工具調用日志

啟動時在終端查看：

```bash
npm start

# 發送 "待處理 PR" 後，應該看到：
[LLM] Iteration 1, messages: 4
[LLM] Received 123 chars
[LLM] Model requested 1 tool calls
[LLM] Executing tool: github_list_pull_requests
[Composio] POST https://backend.composio.dev/api/v3/tools/execute/GITHUB_LIST_PULL_REQUESTS
[LLM] Tool github_list_pull_requests returned: {"pullRequests":[...],"count":1}
[LLM] Iteration 2, messages: 6
[LLM] Received 234 chars
[LLM] Final response: text=18 chars, cards=1
```

---

## 常見問題

### Q: 模型返回空響應
**A:** 檢查：
1. DeepSeek API key 是否有效
2. baseURL 是否正確（https://api.deepseek.com/v1）
3. 模型名稱是否正確（deepseek-chat）

### Q: 工具調用失敗
**A:** 檢查：
1. Composio API key 是否有效
2. GitHub 是否真的連接（GET /api/composio/apps 應顯示 github connected:true）
3. 工具名稱是否正確（`GITHUB_LIST_PULL_REQUESTS`，全大寫加下劃線）

### Q: 模型不調用工具，直接回答
**A:** 檢查：
1. AGENT_SYSTEM_PROMPT 是否正確加載
2. 模型是否支持 JSON mode（DeepSeek 支持）
3. 提示詞中的工具調用示例是否清晰

### Q: 按鈕點擊後發送的是 ID
**A:** 檢查：
- 卡片 actions 中的 value 是否是人類文本
- 示例：`{label: "查看 PR", value: "查看我的 GitHub PR"}` ✅
- 錯誤：`{label: "查看 PR", value: "github_prs"}` ❌

---

## 成功標準

✅ **測試通過條件：**
1. "待處理 PR" 返回真實 PR（從 GitHub API）
2. 無任何 "我暫時沒有想法" 之類的假回复
3. 按鈕值是人類文本，不是 ID
4. 終端日志顯示工具調用和執行
5. 卡片數據與 GitHub 網頁一致

❌ **測試失敗條件：**
1. 返回虛構的項目名稱
2. 出現 "換個方式問" 卡片
3. 按鈕值是 `view_today` 之類的 ID
4. 日志無工具調用記錄
5. 模型未配置時返回假回复
