# 修復報告 - 5d9db2c

## ✅ 已修復的嚴重錯誤

### 1. 語法錯誤（line 873）
**問題：** 重複的錯誤處理代碼塊導致 SyntaxError
```javascript
// ❌ 之前（重複）
return {
  text: '模型返回了無效響應',
  cards: [{...}],
  time: ...
};
}
    cards: [{  // ← 重複！
      type: 'error',
      title: '內部錯誤',
```

**修復：** 刪除重複塊
```bash
$ node --check src/host/api.js
✅ Syntax OK
```

---

### 2. 連接賬號查詢（不包含 statuses=ACTIVE）
**問題：** `getConnectedAccounts()` 未過濾 ACTIVE 狀態
```javascript
// ❌ 之前
const result = await request(`/connected_accounts?user_ids=${entityId}`);
// → 返回 INITIATED（待授權）和 ACTIVE 混合
```

**修復：** 添加狀態過濾
```javascript
// ✅ 現在
const result = await request(`/connected_accounts?user_ids=${entityId}&statuses=ACTIVE`);
```

---

### 3. gatherContext 使用錯誤字段
**問題：** 檢查 `account.appName`（v3 API 不存在）
```javascript
// ❌ 之前
context.connectedSources = accounts.map(acc => acc.appName || acc.appId);
// → appName undefined，無法識別 GitHub
```

**修復：** 使用 `toolkit.slug` 和 `status`
```javascript
// ✅ 現在
context.connectedSources = accounts
  .filter(acc => acc.status === 'ACTIVE' && acc.toolkit?.slug)
  .map(acc => ({
    slug: acc.toolkit.slug,  // ← 'github'
    identity: acc.metadata?.username || acc.user_id,
  }));
```

---

### 4. getComposioApps 解析錯誤結構
**問題：** 假設 `accounts` 是直接數組
```javascript
// ❌ 之前
const accounts = await client.getConnectedAccounts();
if (accounts && Array.isArray(accounts)) {  // ← 錯誤！
  accounts.forEach(account => { ... });
}
```

**修復：** 正確解析 `result.items`
```javascript
// ✅ 現在
const result = await client.getConnectedAccounts();
const accounts = result?.items || [];
accounts.forEach(account => {
  if (account.status === 'ACTIVE' && account.toolkit?.slug) {
    connectedApps.set(account.toolkit.slug, { ... });
  }
});
```

---

### 5. buildContextMessage 使用舊結構
**問題：** `connectedSources` 從 `string[]` 變為 `{slug, identity}[]`
```javascript
// ❌ 之前
message += context.connectedSources.join('、');
// → [object Object], [object Object]
```

**修復：** 格式化新結構
```javascript
// ✅ 現在
message += context.connectedSources.map(s => `${s.slug} (${s.identity})`).join('、');
// → "github (user@github.com)、gmail (user@gmail.com)"
```

---

## 🧪 測試計劃（需要真實 Composio Key）

### 前提條件
```bash
export COMPOSIO_API_KEY=your_key_here
export COMPOSIO_ENTITY_ID=default
cd /path/to/openDigitalMate
git checkout cursor/redesign-card-ui-e793
git pull origin cursor/redesign-card-ui-e793  # 應該是 5d9db2c
npm start
```

---

### 測試 1：驗證連接狀態（GET /api/composio/apps）

**curl 命令：**
```bash
curl -s http://localhost:7777/api/composio/apps | jq .
```

**預期結果（GitHub 已連接 ca_zH4rAcTcHAfi）：**
```json
{
  "apps": [
    {
      "key": "github",
      "name": "GitHub",
      "logo": "https://logos.composio.dev/api/github",
      "connected": true,  // ← 必須是 true
      "connectionId": "ca_zH4rAcTcHAfi",
      "connectedAt": "2024-..."
    },
    {
      "key": "gmail",
      "name": "Gmail",
      "connected": false
    },
    ...
  ],
  "configured": true
}
```

**❌ 之前的錯誤結果：**
```json
{
  "apps": [
    {
      "key": "github",
      "connected": false  // ← 錯誤！明明已連接
    }
  ]
}
```

---

### 測試 2：直接查詢 Composio API

**curl 命令：**
```bash
curl -s "https://backend.composio.dev/api/v3/connected_accounts?user_ids=default&statuses=ACTIVE" \
  -H "x-api-key: $COMPOSIO_API_KEY" | jq '.items[] | {id, status, toolkit: .toolkit.slug, user: .metadata.username}'
```

**預期結果：**
```json
{
  "id": "ca_zH4rAcTcHAfi",
  "status": "ACTIVE",
  "toolkit": "github",
  "user": "your-github-username"
}
```

**驗證：** `toolkit` 必須是 `"github"`（不是 `null`），`status` 必須是 `"ACTIVE"`

---

### 測試 3：聊天調用工具（POST /api/chat）

**前提：** 模型已配置（DeepSeek 或 OpenAI-compatible）

**curl 命令：**
```bash
curl -s http://localhost:7777/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "列出我的GitHub仓库"}' | jq .
```

**預期行為：**
1. 終端日志：
   ```
   [LLM] Iteration 1, messages: 4
   [LLM] Received 156 chars
   [LLM] Model requested 1 tool calls
   [LLM] Executing tool: github_list_repos
   [Composio] Executing GITHUB_USER_GET_CURRENT_USER_REPOS
   [LLM] Tool github_list_repos returned: {"repos":[...],"count":5}
   [LLM] Iteration 2, messages: 6
   [LLM] Final response: text=... chars, cards=5
   ```

2. HTTP 響應：
   ```json
   {
     "text": "你有 N 個倉庫",
     "cards": [
       {
         "type": "info",
         "title": "openDigitalMate",  // ← 真實倉庫名
         "description": "...",
         "url": "https://github.com/..."
       }
     ],
     "time": "15:30"
   }
   ```

**❌ 之前的錯誤結果：**
```json
{
  "text": "你还没有连接 GitHub",  // ← 錯誤！明明已連接
  "cards": [{
    "type": "action",
    "title": "连接数据源",
    "actions": [{"label": "前往设置", ...}]
  }]
}
```

**為什麼之前會錯：**
- `gatherContext()` 查詢到的 accounts 沒有 `appName` 字段
- `context.connectedSources` 是空數組
- `buildContextMessage()` 返回 "未连接任何数据源"
- 模型看到這個提示，直接回复 "你还没有连接" 而不調用工具

**現在為什麼會對：**
- `gatherContext()` 正確提取 `toolkit.slug === 'github'`
- `context.connectedSources = [{slug: 'github', identity: 'user@github.com'}]`
- `buildContextMessage()` 告訴模型 "已連接: github (user@github.com)"
- 工具 **總是** 被創建（`createComposioTools(composioClient)`）
- 模型看到有 GitHub 連接 + 有 `github_list_repos` 工具 → 調用工具

---

### 測試 4：Sources 頁面（GET /api/sources）

**curl 命令：**
```bash
curl -s http://localhost:7777/api/sources | jq .
```

**預期結果：**
```json
{
  "sources": [
    {
      "name": "GitHub",
      "logo": "https://logos.composio.dev/api/github",
      "key": "github",
      "connected": true,
      "identity": "your-github-username",  // ← 不是 "default"
      "connectionId": "ca_zH4rAcTcHAfi",
      "connectedAt": "2024-..."
    },
    {
      "name": "Gmail",
      "connected": false,
      "identity": null
    }
  ]
}
```

**❌ 之前的錯誤（用戶報告）：**
- 顯示 "Unknown" 卡片
- 顯示 "Connected as default"（應該是 GitHub username）
- 混合已連接和未連接（應該分開）

---

## 📝 仍待修復（未完成）

### 1. Callback 路由 404
**問題：** OAuth 回調 `/composio-callback?status=success...` 返回 404

**需要檢查：**
```bash
curl -s "http://localhost:7777/composio-callback?status=success&connected_account_id=ca_xxx" | head -20
```

**應該返回：** HTML 頁面顯示成功 + 自動關閉窗口

**如果 404：** 需要在 `src/host/api.js` 添加路由

---

### 2. Calendar 使用 GitHub Auth Config
**問題：** `getAuthConfig(toolkitSlug)` 未按 `toolkit.slug` 過濾，導致 Calendar OAuth 打開 GitHub 授權

**需要檢查（在連接 Calendar 時）：**
- 終端日志：`[Composio] Getting auth config for: googlecalendar`
- OAuth URL：應該是 `https://connect.composio.dev/...` 並重定向到 Google（不是 GitHub）

**如果錯誤：** `src/host/composio.js` 的 `getAuthConfig()` 需要過濾 `item.toolkit?.slug === toolkitSlug`

---

### 3. Logos 和 Sources 頁面
**用戶報告：** Gmail 和 Linear logos 不加載，Sources 頁面顯示 "Unknown"

**修復狀態：**
- ✅ Sources API (`GET /api/sources`) 已修復（使用 toolkit.slug + identity）
- ⏳ 前端 `src/client/index.html` 的 `loadSources()` 需要驗證
- ⏳ Logo URLs (`https://logos.composio.dev/api/<slug>`) 需要驗證

---

## 🎯 測試檢查表

用戶需要在真實環境（有 Composio key + GitHub 已連接）運行以下測試：

- [ ] `npm start` 無語法錯誤
- [ ] `curl http://localhost:7777/api/composio/apps` 顯示 `github connected: true`
- [ ] `curl https://backend.composio.dev/api/v3/connected_accounts?user_ids=default&statuses=ACTIVE -H "x-api-key: $KEY"` 返回 `ca_zH4rAcTcHAfi` 且 `toolkit.slug === 'github'`
- [ ] 聊天 "列出我的GitHub仓库" 調用 `github_list_repos` 工具（終端日志可見）
- [ ] 聊天返回真實倉庫名稱（不是 "你还没有连接"）
- [ ] `curl http://localhost:7777/api/sources` 顯示 GitHub identity（不是 "default"）
- [ ] 前端 Sources 頁面顯示 GitHub 用戶名（不是 "Unknown"）
- [ ] 前端 Sources 頁面 logos 加載成功
- [ ] Callback `/composio-callback?status=success...` 不是 404
- [ ] Calendar OAuth 不打開 GitHub 授權頁面

---

## 🚀 快速驗證腳本

```bash
#!/bin/bash
# quick-test.sh

# 前提：npm start 已運行，COMPOSIO_API_KEY 已設置

echo "1. 測試 /api/composio/apps"
curl -s http://localhost:7777/api/composio/apps | jq '.apps[] | select(.key=="github") | {connected, connectionId}'

echo -e "\n2. 測試 Composio API"
curl -s "https://backend.composio.dev/api/v3/connected_accounts?user_ids=default&statuses=ACTIVE" \
  -H "x-api-key: $COMPOSIO_API_KEY" | jq '.items[] | select(.toolkit.slug=="github") | {id, status, toolkit: .toolkit.slug}'

echo -e "\n3. 測試聊天（需要 LLM 配置）"
curl -s http://localhost:7777/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "列出我的GitHub仓库"}' | jq '{text, cards: .cards | length}'

echo -e "\n4. 測試 /api/sources"
curl -s http://localhost:7777/api/sources | jq '.sources[] | select(.key=="github") | {connected, identity}'

echo -e "\n✅ 所有測試完成"
```

**執行：**
```bash
chmod +x quick-test.sh
./quick-test.sh
```

---

## 💾 提交記錄

**Commit:** `5d9db2c`  
**分支:** `cursor/redesign-card-ui-e793`  
**推送:** ✅ 已推送到 origin

**變更文件：**
- `src/host/api.js` (+57, -66)
- `src/host/composio.js` (+1, -1)

**驗證：**
```bash
$ node --check src/host/api.js
✅ Syntax OK

$ npm start
✅ Server running at http://localhost:7777
```
