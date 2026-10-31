/**
 * Composio integration for daily digest and multi-source aggregation
 * Connects user accounts via Composio to aggregate information
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Composio client wrapper
export class ComposioClient {
  constructor({ apiKey, entityId = 'default' }) {
    this.apiKey = apiKey;
    this.entityId = entityId;
    this.baseUrl = 'https://backend.composio.dev/api/v1';
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Composio API error: ${response.status} ${error}`);
    }

    return response.json();
  }

  /**
   * Get connected integrations for the entity
   */
  async getConnectedAccounts() {
    return this.request(`/connectedAccounts?user_uuid=${this.entityId}`);
  }

  /**
   * Execute an action on a connected app
   */
  async executeAction(action, params = {}) {
    return this.request('/actions/execute', {
      method: 'POST',
      body: JSON.stringify({
        entityId: this.entityId,
        action,
        params,
      }),
    });
  }

  /**
   * Get available apps
   */
  async getApps() {
    return this.request('/apps');
  }

  /**
   * Create a connection link for an app
   */
  async createConnection(appName, redirectUrl) {
    return this.request('/connectedAccounts', {
      method: 'POST',
      body: JSON.stringify({
        integrationId: appName,
        userUuid: this.entityId,
        redirectUrl,
      }),
    });
  }
}

/**
 * Aggregate daily digest from multiple sources
 */
export async function generateDailyDigest(composioClient) {
  const digest = {
    items: [],
    generatedAt: new Date().toISOString(),
  };

  try {
    const accounts = await composioClient.getConnectedAccounts();
    
    // Try to fetch from various sources
    const sources = [
      { app: 'github', action: 'GITHUB_LIST_NOTIFICATIONS', title: 'GitHub 通知' },
      { app: 'slack', action: 'SLACK_LIST_UNREAD_MESSAGES', title: 'Slack 消息' },
      { app: 'gmail', action: 'GMAIL_LIST_MESSAGES', title: 'Gmail 邮件' },
      { app: 'linear', action: 'LINEAR_LIST_MY_ISSUES', title: 'Linear 任务' },
      { app: 'calendar', action: 'GOOGLE_CALENDAR_LIST_EVENTS', title: '日历事件' },
      { app: 'notion', action: 'NOTION_LIST_PAGES', title: 'Notion 页面' },
    ];

    for (const source of sources) {
      const account = accounts.items?.find(acc => 
        acc.appName?.toLowerCase() === source.app
      );
      
      if (!account) continue;

      try {
        const result = await composioClient.executeAction(source.action, {
          limit: 5,
        });

        if (result.data) {
          digest.items.push({
            title: source.title,
            source: source.app,
            description: `发现 ${result.data.length || 0} 条更新`,
            data: result.data,
            time: new Date().toLocaleString('zh-CN'),
            actions: [
              { label: '查看详情', primary: true },
              { label: '标记已读', primary: false },
            ],
          });
        }
      } catch (err) {
        console.error(`Failed to fetch from ${source.app}:`, err.message);
        // Continue with other sources
      }
    }

    // If no sources connected, show placeholder
    if (digest.items.length === 0) {
      digest.items.push({
        title: '暂无连接的数据源',
        source: 'system',
        description: '请先在 Composio 中连接你的应用账号',
        time: new Date().toLocaleString('zh-CN'),
      });
    }

  } catch (err) {
    console.error('Failed to generate digest:', err);
    digest.error = err.message;
  }

  return digest;
}

/**
 * Get sources status
 */
export async function getSourcesStatus(composioClient) {
  try {
    const accounts = await composioClient.getConnectedAccounts();
    
    const commonApps = [
      { name: 'GitHub', app: 'github', description: '代码仓库、PR和Issue' },
      { name: 'Slack', app: 'slack', description: '团队消息和频道' },
      { name: 'Gmail', app: 'gmail', description: '邮件收发' },
      { name: 'Linear', app: 'linear', description: '项目管理和任务' },
      { name: 'Google Calendar', app: 'calendar', description: '日历和会议' },
      { name: 'Notion', app: 'notion', description: '知识库和文档' },
      { name: '飞书', app: 'feishu', description: '企业通讯' },
    ];

    const sources = commonApps.map(app => {
      const account = accounts.items?.find(acc => 
        acc.appName?.toLowerCase() === app.app
      );
      return {
        name: app.name,
        connected: !!account,
        description: app.description,
        lastSync: account?.updatedAt,
      };
    });

    return { sources };
  } catch (err) {
    console.error('Failed to get sources:', err);
    return { sources: [], error: err.message };
  }
}

/**
 * Push daily digest to configured channels
 */
export async function pushDailyDigest({ digest, store, config, sendCard }) {
  const results = [];

  try {
    // Get members who should receive digest
    const state = store?.get?.() || {};
    const members = Object.values(state.members || {});

    // Build digest card for Feishu
    const digestCard = buildDigestCard(digest);

    // Send to configured recipients
    const recipients = config?.digestRecipients || [];
    if (config?.ownerOpenId) {
      recipients.push(config.ownerOpenId);
    }

    for (const recipientId of [...new Set(recipients)]) {
      try {
        if (sendCard && typeof sendCard === 'function') {
          const messageId = await sendCard({
            receiveId: recipientId,
            card: digestCard,
          });
          results.push({
            channel: 'feishu',
            recipient: recipientId,
            success: true,
            messageId,
          });
        }
      } catch (err) {
        results.push({
          channel: 'feishu',
          recipient: recipientId,
          success: false,
          error: err.message,
        });
      }
    }

    // Store digest in state for web UI
    if (store?.save) {
      const newState = {
        ...state,
        lastDigest: {
          ...digest,
          pushedAt: new Date().toISOString(),
        },
      };
      await store.save(newState);
    }

  } catch (err) {
    console.error('Push daily digest failed:', err);
    results.push({
      channel: 'system',
      success: false,
      error: err.message,
    });
  }

  return results;
}

/**
 * Build Feishu card for daily digest
 */
function buildDigestCard(digest) {
  const elements = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**每日汇聚** · ${new Date().toLocaleDateString('zh-CN')}`,
      },
    },
    {
      tag: 'hr',
    },
  ];

  // Add each source's items
  if (digest.items && digest.items.length > 0) {
    digest.items.forEach((item, index) => {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${item.title}**\n${item.description}`,
        },
      });
      
      if (item.actions && item.actions.length > 0) {
        elements.push({
          tag: 'action',
          actions: item.actions.map(action => ({
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: action.label,
            },
            type: action.primary ? 'primary' : 'default',
            value: { action: action.label, itemIndex: index },
          })),
        });
      }

      if (index < digest.items.length - 1) {
        elements.push({ tag: 'hr' });
      }
    });
  } else {
    elements.push({
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: '今日暂无更新',
      },
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: '📊 每日汇聚',
      },
      template: 'blue',
    },
    elements,
  };
}
  const [hour, minute] = (config.digestSchedule || '08:00').split(':').map(Number);
  
  function checkAndRun() {
    const now = new Date();
    if (now.getHours() === hour && now.getMinutes() === minute) {
      callback().catch(err => console.error('Digest push failed:', err));
    }
  }

  // Check every minute
  const intervalId = setInterval(checkAndRun, 60 * 1000);
  
  // Also run immediately if configured
  if (config.runImmediately) {
    callback().catch(err => console.error('Immediate digest failed:', err));
  }

  return () => clearInterval(intervalId);
}

/**
 * Create Composio client from config
 */
export function createComposioClient(config) {
  if (!config.composioApiKey) {
    throw new Error('COMPOSIO_API_KEY not configured');
  }

  return new ComposioClient({
    apiKey: config.composioApiKey,
    entityId: config.composioEntityId || 'default',
  });
}

export default {
  ComposioClient,
  generateDailyDigest,
  getSourcesStatus,
  scheduleDailyDigest,
  createComposioClient,
};
