# 快速啟動指南 - 測試真實工具集成

## 在你的 Mac 上測試

### 1. 拉取最新代碼
```bash
cd /path/to/Douya
git checkout cursor/redesign-card-ui-e793
git pull origin cursor/redesign-card-ui-e793
```

### 2. 確認依賴已安裝
```bash
npm install
npm install --prefix vendor/ds-bot   # deep-view for link:ds-bot (also auto on npm start)
```

### 3. 配置環境變量
確保你的 `.env` 或環境變量中有：
```bash
COMPOSIO_API_KEY=your_composio_key_here
COMPOSIO_ENTITY_ID=default
```

### 4. 啟動服務
```bash
npm start
```

服務啟動後訪問：http://localhost:7777

---

## 第一步：配置模型

1. 點擊右上角的 **⚙️ 設置** 按鈕
2. 選擇 **模型配置** 標籤
3. 填寫：
   - **Provider**: 選擇 `DeepSeek`（或 `自定義`）
   - **Base URL**: `https://api.deepseek.com/v1`
   - **API Key**: 你的 DeepSeek API key
   - **Model**: `deepseek-chat`
4. 點擊 **測試連接** - 應該看到成功響應
5. 點擊 **保存配置**

---

## 第二步：連接 GitHub

1. 在設置中選擇 **Composio 集成** 標籤
2. 填寫 Composio API Key
3. 點擊保存
4. 找到 **GitHub** 卡片
5. 點擊 **連接** 按鈕
6. 在新窗口完成 GitHub OAuth 授權
7. 返回後刷新頁面，GitHub 應該顯示 **✓ 已連接**

---

## 第三步：測試真實聊天

### 測試 1：待處理 PR

**在聊天框輸入：**
```
待處理 PR
```

**預期結果：**
- 終端顯示：
  ```
  [LLM] Iteration 1, messages: 4
  [LLM] Model requested 1 tool calls
  [LLM] Executing tool: github_list_pull_requests
  [LLM] Tool github_list_pull_requests returned: {"pullRequests":[...],"count":1}
  [LLM] Final response: text=18 chars, cards=1
  ```
- 聊天界面顯示：
  - 文本："你有 N 個待處理 PR"（N 是真實數字）
  - 卡片：顯示真實 PR 標題、編號、鏈接
  
**✅ 成功標誌：**
- PR 標題和編號與 GitHub 網頁一致
- 點擊卡片能跳轉到正確的 GitHub PR

**❌ 失敗標誌：**
- 出現 "我暫時沒有想法，您可以換個問法試試"
- 出現虛假的項目名稱（如 "官網改版"）
- 按鈕值是 `github_pull_requests` 之類的 ID

### 測試 2：我的倉庫

**輸入：**
```
我的倉庫
```

**預期：**
- 調用 `github_list_repos`
- 顯示真實倉庫列表（Douya, test-repo, ...）
- 每個卡片顯示 stars, language, 更新時間

### 測試 3：無模型時的行為

**步驟：**
1. 刪除模型配置：
   ```bash
   rm ~/.local/share/opendigitalmate/config.json
   # 或在設置中清空 API Key
   ```
2. 重啟 `npm start`
3. 發送任意消息："你好"

**預期：**
- 返回錯誤卡片：
  ```
  文本：模型未配置。請先在設置中配置 LLM 模型
  卡片：[前往模型設置] 按鈕
  ```
  
**❌ 不應該出現：**
- "收到！我可以幫你管理任務..." 之類的假回复
- "快速操作" 卡片

---

## 調試技巧

### 1. 查看完整日志
```bash
npm start 2>&1 | tee server.log
```

然後在聊天中發送消息，檢查 `server.log` 文件。

### 2. 檢查 Composio 連接狀態
```bash
# 在瀏覽器控制台或 curl
curl http://localhost:7777/api/composio/apps | jq .
```

應該看到：
```json
{
  "apps": [
    {
      "key": "github",
      "name": "GitHub",
      "connected": true,
      "account": {
        "id": "ca_zH4rAcTcHAfi",
        "status": "ACTIVE"
      }
    }
  ]
}
```

### 3. 手動測試 Composio API
```bash
export COMPOSIO_API_KEY=your_key

# 列出已連接的賬號
curl -X GET https://backend.composio.dev/api/v3/connected_accounts?user_ids=default \
  -H "x-api-key: $COMPOSIO_API_KEY" | jq .

# 測試執行 GitHub 工具
curl -X POST https://backend.composio.dev/api/v3/tools/execute/GITHUB_LIST_PULL_REQUESTS \
  -H "x-api-key: $COMPOSIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "default", "arguments": {"state": "open", "per_page": 5}}' | jq .
```

---

## 常見問題

### Q: 模型返回 "模型返回了空響應"
**A:** 檢查：
1. DeepSeek API key 是否有效
2. Base URL 是否正確（必須包含 `/v1`）
3. 模型名稱是否正確（`deepseek-chat`，不是 `gpt-4o`）

### Q: 工具沒有被調用
**A:** 檢查：
1. 終端日志是否顯示 `[LLM] Model requested N tool calls`
2. 如果沒有，說明模型沒有返回 `tool_calls` 字段
3. 可能是系統提示不夠清晰，或模型不理解工具調用格式

### Q: 工具調用失敗
**A:** 檢查：
1. Composio API key 是否有效
2. GitHub 是否真的連接（`curl http://localhost:7777/api/composio/apps`）
3. 終端日志中的錯誤信息

### Q: 按鈕點擊後沒反應
**A:** 檢查：
1. 瀏覽器控制台是否有錯誤
2. 按鈕的 `value` 是否是人類文本（不是 ID）
3. `handleCardAction()` 函數是否正常工作

---

## 驗證清單

- [ ] 模型配置保存成功
- [ ] GitHub 連接顯示 "✓ 已連接"
- [ ] "待處理 PR" 返回真實 PR
- [ ] PR 標題和 GitHub 網頁一致
- [ ] 點擊卡片跳轉到正確的 GitHub 頁面
- [ ] 終端顯示工具調用日志
- [ ] 無任何 "我暫時沒有想法" 假回复
- [ ] 按鈕值是人類文本，不是 ID
- [ ] 模型未配置時顯示錯誤卡片（不是假回复）

---

## 下一步

如果所有測試通過，你可以嘗試：
1. 連接 Gmail 和 Calendar
2. 測試 "最近的郵件"、"今天的安排"
3. 多輪對話：
   ```
   你："我的倉庫"
   AI：[顯示倉庫列表]
   你："第一個倉庫有什麼 PR？"
   AI：[調用工具獲取該倉庫的 PR]
   ```

---

## 報告問題

如果遇到問題，請提供：
1. 完整的終端日志（包括 `[LLM]` 開頭的行）
2. 瀏覽器控制台截圖
3. 具體的輸入和預期 vs 實際結果
4. Composio 連接狀態（`curl http://localhost:7777/api/composio/apps` 的輸出）
