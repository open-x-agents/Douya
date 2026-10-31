/**
 * API routes for the web interface
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDailyDigest, getSourcesStatus, pushDailyDigest, createComposioClient } from './composio.js';
import { reminderCard } from './cards.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Static list of popular Composio apps
const COMPOSIO_APPS = [
  {
    key: 'github',
    name: 'GitHub',
    logo: 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
    description: 'Repositories and issues',
  },
  {
    key: 'slack',
    name: 'Slack',
    logo: 'https://a.slack-edge.com/80588/marketing/img/icons/icon_slack_hash_colored.png',
    description: 'Team messages',
  },
  {
    key: 'gmail',
    name: 'Gmail',
    logo: 'https://www.google.com/gmail/about/static/images/logo-gmail.png',
    description: 'Email access',
  },
  {
    key: 'notion',
    name: 'Notion',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/4/45/Notion_app_logo.png',
    description: 'Workspace docs',
  },
  {
    key: 'linear',
    name: 'Linear',
    logo: 'https://asset.brandfetch.io/idAnDTFapY/idG_TlAMjQ.png',
    description: 'Issue tracking',
  },
  {
    key: 'calendar',
    name: 'Google Calendar',
    logo: 'https://ssl.gstatic.com/calendar/images/dynamiclogo_2020q4/calendar_31_2x.png',
    description: 'Calendar events',
  },
];

// Simple in-memory chat history for demo
const chatSessions = new Map();

/**
 * System prompt for card-based responses
 */
const CARD_SYSTEM_PROMPT = `你是「豆芽」，一个智能数字同事助手。你的回复必须简洁、结构化，以卡片形式呈现。

**核心原则**：
- 文本要简短（1-2 句话总结）
- 交互通过卡片（info/action/choice/task/event）
- 每次回复 1-3 张卡片

**回复格式（JSON）**：
{
  "text": "简短总结（1-2句话）",
  "cards": [
    {
      "type": "info|action|choice|task|event",
      "title": "卡片标题",
      "description": "详细说明（可选）",
      "actions": [{"label": "按钮文字", "value": "action_id"}],
      "items": ["列表项1", "列表项2"],
      "time": "时间（可选）",
      "status": "状态（可选）"
    }
  ]
}

**卡片类型**：
- info: 信息展示（带 items 列表）
- action: 操作建议（带 actions 按钮）
- choice: 多选项（带 actions 按钮）
- task: 任务卡片（title, description, status）
- event: 日程卡片（title, time, description）

**示例**：
用户："今天有什么安排？"
{
  "text": "今天有 2 个会议，3 件待办",
  "cards": [
    {"type":"event","title":"团队周会","time":"14:00"},
    {"type":"task","title":"完成设计稿","status":"进行中"}
  ]
}

用户："帮我查一下项目进度"
{
  "text": "以下是可用的操作",
  "cards": [
    {"type":"action","title":"查询项目进度","actions":[{"label":"查看详情","value":"view_project"}]}
  ]
}

严格返回 JSON，不要 markdown 格式。`;

/**
 * Call LLM - Build client from config store on-demand
 */
async function callLLM(ctx, messages, sessionId = 'web-chat') {
  // Prepend system prompt
  const messagesWithSystem = [
    { role: 'system', content: CARD_SYSTEM_PROMPT },
    ...messages,
  ];

  // Try to get LLM from context first (ds-bot mode)
  if (ctx?.llm?.stream) {
    try {
      let fullText = '';
      for await (const chunk of ctx.llm.stream({
        messages: messagesWithSystem,
        maxTokens: 1000,
        responseFormat: { type: 'json_object' },
      })) {
        if (chunk.type === 'text' && chunk.text) {
          fullText += chunk.text;
        }
      }

      if (fullText.trim()) {
        const result = parseResponseToCards(fullText);
        console.log(`[LLM] Response: text=${result.text?.length || 0} chars, cards=${result.cards?.length || 0}`);
        return result;
      } else {
        console.warn('[LLM] Empty response from ds-bot LLM');
        return {
          text: '模型返回了空响应',
          cards: [
            {
              type: 'error',
              title: '模型返回空白',
              description: '请重试或检查模型配置',
              actions: [{ label: '重试', value: 'retry' }],
            },
          ],
        };
      }
    } catch (error) {
      console.error('[LLM] ds-bot error:', error);
      return {
        text: '调用模型时出错',
        cards: [
          {
            type: 'error',
            title: '错误: ' + error.message,
            description: '请检查模型配置',
            actions: [{ label: '检查配置', value: 'goto_settings' }],
          },
        ],
      };
    }
  }

  // Standalone mode: build client from config store
  const configStore = callLLM.configStore;
  if (configStore?.get) {
    const cfg = configStore.get()?.llm;
    if (cfg?.apiKey && cfg?.provider) {
      try {
        const { createLLMClient } = await import('./llm-client.js');
        const client = createLLMClient({
          provider: cfg.provider,
          baseURL: cfg.baseURL,
          apiKey: cfg.apiKey,
          model: cfg.model,
          log: console.log,
        });

        let fullText = '';
        for await (const chunk of client.stream({
          messages: messagesWithSystem,
          maxTokens: 1000,
          responseFormat: { type: 'json_object' },
        })) {
          if (chunk.type === 'text' && chunk.text) {
            fullText += chunk.text;
          }
        }

        console.log(`[LLM] Received ${fullText.length} chars from ${cfg.provider}`);

        if (fullText.trim()) {
          const result = parseResponseToCards(fullText);
          console.log(`[LLM] Parsed: text=${result.text?.length || 0} chars, cards=${result.cards?.length || 0}`);
          return result;
        } else {
          console.warn('[LLM] Empty response from model');
          return {
            text: '模型返回了空响应',
            cards: [
              {
                type: 'error',
                title: '模型返回空白',
                description: '请重试或检查模型配置',
                actions: [{ label: '重试', value: 'retry' }],
              },
            ],
          };
        }
      } catch (error) {
        console.error('[LLM] Standalone mode error:', error);
        return {
          text: '调用模型时出错',
          cards: [
            {
              type: 'error',
              title: '错误: ' + error.message,
              description: '请检查模型配置是否正确',
              actions: [
                { label: '检查配置', value: 'goto_settings' },
              ],
            },
          ],
        };
      }
    }
  }

  // No model configured
  console.warn('[LLM] No model configured');
  return {
    text: '模型未配置',
    cards: [
      {
        type: 'action',
        title: '需要配置 AI 模型才能对话',
        description: '请点击下方按钮前往配置页面',
        actions: [
          { label: '前往配置', value: 'goto_settings' },
        ],
      },
    ],
  };
}

/**
 * Parse LLM response for structured cards
 * Looks for JSON blocks or action patterns in the response
 */
/**
 * Parse LLM response to extract structured cards
 * Expects JSON response: { text: "...", cards: [...] }
 */
function parseResponseToCards(text) {
  // First try: parse as pure JSON
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed.cards && Array.isArray(parsed.cards)) {
      return {
        text: parsed.text || '',
        cards: parsed.cards,
      };
    }
  } catch (err) {
    // Not pure JSON, continue
  }

  // Second try: extract JSON from markdown code block
  const jsonBlockMatch = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (parsed.cards && Array.isArray(parsed.cards)) {
        return {
          text: parsed.text || '',
          cards: parsed.cards,
        };
      }
    } catch (err) {
      // Invalid JSON in block
    }
  }

  // Third try: extract any JSON object with cards field
  const jsonMatch = text.match(/\{[\s\S]*?"cards"\s*:\s*\[[\s\S]*?\]\s*[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.cards && Array.isArray(parsed.cards)) {
        return {
          text: parsed.text || '',
          cards: parsed.cards,
        };
      }
    } catch (err) {
      // Invalid JSON
    }
  }

  // Fallback: return text as-is with no cards
  return {
    text: text.trim(),
    cards: [],
  };
}

export function createApiRouter(ctx) {
  const { store, composioClient, config, configStore } = ctx;
  const llmCtx = ctx.llmCtx || ctx.ctx;

  // Export configStore for callLLM to access
  callLLM.configStore = configStore;

  return {
    /**
     * GET /api/today - Get today's summary and tasks
     */
    async getToday() {
      try {
        const today = new Date().toLocaleDateString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          weekday: 'long',
        });

        // Get real data from store
        const state = store.get();
        const upcoming = state.upcoming || [];
        const reports = Object.values(state.reports || {});
        const deliveries = state.deliveries || [];
        
        // Extract today's meetings
        const todayMeetings = upcoming.filter(item => {
          const startDate = new Date(item.startAt).toLocaleDateString('zh-CN');
          return startDate === new Date().toLocaleDateString('zh-CN');
        });

        // Build task list from upcoming events and reports
        const tasks = [];
        
        // Add upcoming meetings as tasks
        todayMeetings.slice(0, 5).forEach((meeting, i) => {
          const startTime = new Date(meeting.startAt).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          });
          tasks.push({
            title: meeting.title || '未命名会议',
            reason: `${startTime} 开始，${meeting.leadMinutes || 10} 分钟前提醒`,
            evidence: `依据：日历事件 ${meeting.id}`,
            advice: meeting.location ? `地点：${meeting.location}` : '',
            closed: false,
          });
        });

        // Add recent report items as tasks
        const recentReport = reports
          .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
          [0];
        
        if (recentReport?.plan) {
          recentReport.plan.slice(0, 3).forEach(item => {
            tasks.push({
              title: item,
              reason: '今日计划',
              evidence: `依据：${recentReport.memberName || '成员'} 的日报`,
              closed: false,
            });
          });
        }

        // If store is empty, show clear message  
        const hasRealTasks = tasks.length > 0;
        if (tasks.length === 0) {
          tasks.push({
            title: '暂无待办任务',
            reason: '今天没有安排的会议或计划',
            evidence: '数据来源：本地存储（当前为空）',
            closed: false,
          });
        }
        const meetingHours = todayMeetings.reduce((sum, m) => {
          const duration = (new Date(m.endAt || m.startAt).getTime() - 
                          new Date(m.startAt).getTime()) / (1000 * 60 * 60);
          return sum + Math.max(0, duration);
        }, 0);

        const sources = [];
        if (upcoming.length > 0) sources.push('日历');
        if (reports.length > 0) sources.push('日报');
        if (deliveries.length > 0) sources.push('提醒');

        // Count only real tasks (not the empty placeholder)
        const realTaskCount = hasRealTasks ? tasks.length : 0;

        return {
          summary: realTaskCount === 0
            ? '今天 0 个会，0 件事' 
            : `今天 ${todayMeetings.length} 个会，${realTaskCount} 件事`,
          date: today,
          sources: sources.join('、') + (sources.length > 0 ? ' 已读' : '暂无数据'),
          openCount: realTaskCount,
          meetingHours: Math.round(meetingHours * 10) / 10,
          waitingCount: 0,
          tasks,
        };
      } catch (err) {
        console.error('API /today error:', err);
        return {
          error: err.message,
          summary: '加载失败',
          date: new Date().toLocaleDateString('zh-CN'),
          openCount: 0,
          meetingHours: 0,
          waitingCount: 0,
          tasks: [],
        };
      }
    },

    /**
     * GET /api/digest - Get Composio daily digest
     */
    async getDigest() {
      try {
        if (!composioClient) {
          return {
            error: 'Composio 未配置。请设置 COMPOSIO_API_KEY 环境变量',
            items: [],
          };
        }

        const digest = await generateDailyDigest(composioClient);
        return digest;
      } catch (err) {
        console.error('API /digest error:', err);
        return {
          error: `加载失败: ${err.message}`,
          items: [],
        };
      }
    },

    /**
     * GET /api/sources - Get connected sources status
     */
    async getSources() {
      try {
        if (!composioClient) {
          return {
            sources: [
              { name: 'Composio', connected: false, description: '未配置 API Key' },
            ],
          };
        }

        const status = await getSourcesStatus(composioClient);
        return status;
      } catch (err) {
        console.error('API /sources error:', err);
        return {
          sources: [],
          error: err.message,
        };
      }
    },

    /**
     * GET /api/config/check - Check if Composio is configured
     */
    async checkConfig() {
      return {
        configured: !!composioClient,
        composioApiKey: !!config?.composioApiKey,
        composioEntityId: config?.composioEntityId || 'default',
        digestSchedule: config?.digestSchedule || '08:00',
        llmConfigured: !!(llmCtx?.llm?.stream),
      };
    },

    /**
     * POST /api/chat - Send a chat message and get LLM response with cards
     */
    async sendChatMessage(data) {
      try {
        const { message, sessionId = 'default' } = data;
        if (!message || typeof message !== 'string') {
          return { error: '消息不能为空' };
        }

        // Get or create chat session
        let session = chatSessions.get(sessionId);
        if (!session) {
          session = {
            messages: [],
            history: [],
          };
          chatSessions.set(sessionId, session);
        }

        // Add user message
        session.messages.push({ role: 'user', content: message });
        session.history.push({
          role: 'user',
          content: message,
          time: new Date().toISOString(),
        });

        // Get LLM response
        const response = await callLLM({ llm: llmCtx?.llm }, session.messages, sessionId);

        // Ensure response is valid
        if (!response || typeof response !== 'object') {
          console.error('[sendChatMessage] Invalid response from callLLM:', response);
          return {
            text: '系统错误',
            cards: [{
              type: 'error',
              title: '内部错误',
              description: 'LLM 返回了无效响应',
            }],
            time: new Date().toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            }),
          };
        }

        // Add assistant message
        session.messages.push({ role: 'assistant', content: response.text || '' });
        session.history.push({
          role: 'assistant',
          content: response.text || '',
          cards: response.cards || [],
          time: new Date().toISOString(),
        });

        // Limit session size
        if (session.messages.length > 20) {
          session.messages = session.messages.slice(-20);
        }

        return {
          text: response.text || '',
          cards: response.cards || [],
          time: new Date().toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          }),
        };
      } catch (err) {
        console.error('[sendChatMessage] Error:', err);
        return {
          text: '系统错误',
          cards: [{
            type: 'error',
            title: '聊天失败',
            description: err.message,
          }],
          time: new Date().toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          }),
        };
      }
    },

    /**
     * POST /api/digest/push - Manually trigger daily digest push
     */
    async pushDigest() {
      try {
        if (!composioClient) {
          return { error: 'Composio 未配置' };
        }

        const digest = await generateDailyDigest(composioClient);
        
        // Deliver via available channels
        const results = await pushDailyDigest({
          digest,
          store,
          config,
          sendCard: ctx.sendCard,
        });

        return {
          success: true,
          digest,
          deliveries: results,
        };
      } catch (err) {
        console.error('API /digest/push error:', err);
        return {
          error: `推送失败: ${err.message}`,
        };
      }
    },

    /**
     * GET /api/composio/config - Get current Composio configuration (masked)
     */
    async getComposioConfig() {
      if (!configStore) {
        return {
          configured: false,
          apiKeyMasked: null,
          entityId: 'default',
          digestSchedule: '08:00',
          digestSources: [],
        };
      }

      const cfg = configStore.get();
      return {
        configured: configStore.isConfigured(),
        apiKeyMasked: configStore.getMaskedKey(),
        entityId: cfg.composioEntityId || 'default',
        digestSchedule: cfg.digestSchedule || '08:00',
        digestSources: cfg.digestSources || [],
        updatedAt: cfg.updatedAt,
      };
    },

    /**
     * POST /api/composio/config - Update Composio configuration
     */
    async updateComposioConfig(data) {
      if (!configStore) {
        return { error: '配置存储未初始化' };
      }

      try {
        const updates = {};
        
        if (data.apiKey && typeof data.apiKey === 'string') {
          updates.composioApiKey = data.apiKey.trim();
        }
        
        if (data.entityId) {
          updates.composioEntityId = data.entityId;
        }
        
        if (data.digestSchedule) {
          updates.digestSchedule = data.digestSchedule;
        }
        
        if (Array.isArray(data.digestSources)) {
          updates.digestSources = data.digestSources;
        }

        await configStore.save(updates);
        
        // Recreate Composio client if API key changed
        if (updates.composioApiKey) {
          ctx.composioClient = createComposioClient({
            composioApiKey: updates.composioApiKey,
            composioEntityId: updates.composioEntityId || 'default',
          });
        }

        return {
          success: true,
          configured: configStore.isConfigured(),
          apiKeyMasked: configStore.getMaskedKey(),
        };
      } catch (err) {
        console.error('Update config error:', err);
        return { error: err.message };
      }
    },

    /**
     * GET /api/composio/apps - List available apps with connection status
     */
    async getComposioApps() {
      try {
        // Return app list even without client
        const apps = COMPOSIO_APPS.map(app => ({
          ...app,
          connected: false,
          connectionId: null,
        }));

        if (!composioClient || !configStore?.isConfigured()) {
          return { apps, configured: false };
        }

        // Fetch actual connection status
        try {
          const accounts = await composioClient.getConnectedAccounts();
          const connectedApps = new Map();
          
          accounts.items?.forEach(account => {
            const appId = account.appName?.toLowerCase();
            if (appId) {
              connectedApps.set(appId, {
                connectionId: account.id,
                connectedAt: account.createdAt,
              });
            }
          });

          apps.forEach(app => {
            const conn = connectedApps.get(app.id);
            if (conn) {
              app.connected = true;
              app.connectionId = conn.connectionId;
              app.connectedAt = conn.connectedAt;
            }
          });
        } catch (err) {
          console.error('Failed to fetch connections:', err);
        }

        return { apps, configured: true };
      } catch (err) {
        console.error('Get apps error:', err);
        return { error: err.message, apps: [] };
      }
    },

    /**
     * POST /api/composio/connect - Initiate OAuth connection for an app
     */
    async connectComposioApp(data) {
      if (!composioClient || !configStore?.isConfigured()) {
        return { error: 'Composio 未配置。请先设置 API Key' };
      }

      try {
        const { appId } = data;
        const app = COMPOSIO_APPS.find(a => a.id === appId);
        
        if (!app) {
          return { error: '未知应用' };
        }

        // Create connection link
        const redirectUrl = `${config.baseUrl || 'http://localhost:7777'}/composio-callback`;
        const result = await composioClient.createConnection(appId, redirectUrl);

        return {
          success: true,
          connectionUrl: result.connectionUrl || result.redirectUrl,
          appName: app.name,
        };
      } catch (err) {
        console.error('Connect app error:', err);
        return { error: err.message };
      }
    },

    /**
     * GET /api/llm/config - Get LLM configuration
     */
    async getLLMConfig() {
      const cfg = configStore.get();
      return {
        configured: configStore.isLLMConfigured(),
        provider: cfg?.llm?.provider || null,
        baseURL: cfg?.llm?.baseURL || null,
        model: cfg?.llm?.model || null,
        apiKey: configStore.getMaskedLLMKey(),
      };
    },

    /**
     * POST /api/llm/config - Update LLM configuration
     */
    async updateLLMConfig(data) {
      const { provider, baseURL, apiKey, model } = data;

      // Build updates object
      const currentLLM = configStore.get()?.llm || {};
      const updates = {
        llm: {
          provider: provider || currentLLM.provider,
          baseURL: baseURL || currentLLM.baseURL,
          model: model || currentLLM.model,
          // Only update apiKey if provided (not masked placeholder)
          ...(apiKey && !apiKey.includes('...') ? { apiKey } : { apiKey: currentLLM.apiKey }),
        },
      };

      await configStore.save(updates);

      // Rebuild LLM client immediately from saved config
      if (typeof updateLLMClient === 'function') {
        updateLLMClient();
      }

      return {
        success: true,
        masked: configStore.getMaskedLLMKey(),
      };
    },

    /**
     * POST /api/llm/test - Test LLM connection
     */
    async testLLM() {
      // Build LLM client from saved config on-demand
      const cfg = configStore.get()?.llm;
      if (!cfg?.apiKey || !cfg?.provider) {
        return { ok: false, error: 'LLM not configured in config store' };
      }

      try {
        // Create temporary client for testing
        const { createLLMClient } = await import('./llm-client.js');
        const testClient = createLLMClient({
          provider: cfg.provider,
          baseURL: cfg.baseURL,
          apiKey: cfg.apiKey,
          model: cfg.model,
          log: () => {},
        });

        const result = await testClient.testConnection();
        return result;
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    /**
     * POST /api/composio/disconnect - Disconnect an app
     */
    async disconnectComposioApp(data) {
      if (!composioClient || !configStore?.isConfigured()) {
        return { error: 'Composio 未配置' };
      }

      try {
        const { appId, connectionId } = data;
        
        if (connectionId) {
          // TODO: Implement disconnect via Composio API
          // await composioClient.deleteConnection(connectionId);
        }

        return {
          success: true,
          appId,
        };
      } catch (err) {
        console.error('Disconnect app error:', err);
        return { error: err.message };
      }
    },

    /**
     * Serve the main HTML interface
     */
    async serveIndex() {
      const html = await readFile(
        join(__dirname, '../client/index.html'),
        'utf-8'
      );
      return html;
    },
  };
}

/**
 * Mount API routes to HTTP server
 */
export function mountApiRoutes(server, router) {
  if (!server || !server.on) {
    console.warn('No HTTP server provided, API routes not mounted');
    return;
  }

  server.on('request', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Route dispatch
      if (url.pathname === '/api/today' && req.method === 'GET') {
        const data = await router.getToday();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } else if (url.pathname === '/api/digest' && req.method === 'GET') {
        const data = await router.getDigest();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } else if (url.pathname === '/api/sources' && req.method === 'GET') {
        const data = await router.getSources();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } else if (url.pathname === '/api/config/check' && req.method === 'GET') {
        const data = await router.checkConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } else if (url.pathname === '/api/chat' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const response = await router.sendChatMessage(data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
          }
        });
        return;
      } else if (url.pathname === '/api/digest/push' && req.method === 'POST') {
        const data = await router.pushDigest();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } else if (url.pathname === '/api/composio/config' && req.method === 'GET') {
        const data = await router.getComposioConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } else if (url.pathname === '/api/composio/config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const response = await router.updateComposioConfig(data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
          }
        });
        return;
      } else if (url.pathname === '/api/composio/apps' && req.method === 'GET') {
        const data = await router.getComposioApps();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } else if (url.pathname === '/api/composio/connect' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const response = await router.connectComposioApp(data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
          }
        });
        return;
      } else if (url.pathname === '/api/composio/disconnect' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const response = await router.disconnectComposioApp(data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
          }
        });
        return;
      } else if (url.pathname === '/api/llm/config' && req.method === 'GET') {
        const data = await router.getLLMConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } else if (url.pathname === '/api/llm/config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const response = await router.updateLLMConfig(data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      } else if (url.pathname === '/api/llm/test' && req.method === 'POST') {
        const data = await router.testLLM();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } else if (url.pathname === '/' && req.method === 'GET') {
        const html = await router.serveIndex();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      console.error('API route error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
}

export default { createApiRouter, mountApiRoutes };
