/**
 * Composio v3 REST API client
 * Docs: https://docs.composio.dev
 */

const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3';

/**
 * Create Composio client
 * @param {Object} config - { composioApiKey, composioEntityId }
 */
export function createComposioClient(config) {
  const apiKey = config.composioApiKey || config.apiKey || process.env.COMPOSIO_API_KEY;
  const entityId = config.composioEntityId || config.entityId || process.env.COMPOSIO_ENTITY_ID || 'default';

  if (!apiKey) {
    throw new Error('COMPOSIO_API_KEY not configured');
  }

  console.log(`[Composio] Client created for entity: ${entityId}`);

  /**
   * Make API request to Composio v3
   */
  async function request(endpoint, options = {}) {
    const url = `${COMPOSIO_API_BASE}${endpoint}`;
    const headers = {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Composio API error (${response.status}): ${error}`);
    }

    return response.json();
  }

  return {
    entityId,

    /**
     * Initiate app connection (OAuth)
     * Returns redirect URL for user authorization
     */
    async initiateConnection(appId) {
      console.log(`[Composio] Initiating connection for app: ${appId}`);
      
      const result = await request('/connected_accounts/initiate', {
        method: 'POST',
        body: JSON.stringify({
          integration_id: appId,
          user_uuid: entityId,
          redirect_url: 'http://localhost:7777/composio-callback',
        }),
      });

      return {
        redirectUrl: result.redirectUrl || result.redirect_url,
        connectionId: result.connectionId || result.connection_id,
      };
    },

    /**
     * Get connected accounts
     */
    async getConnectedAccounts() {
      console.log('[Composio] Fetching connected accounts');
      
      const result = await request(`/connected_accounts?user_uuid=${encodeURIComponent(entityId)}`);
      
      return {
        items: result.items || result.accounts || [],
      };
    },

    /**
     * Delete connection
     */
    async deleteConnection(connectionId) {
      console.log(`[Composio] Deleting connection: ${connectionId}`);
      
      await request(`/connected_accounts/${connectionId}`, {
        method: 'DELETE',
      });
    },

    /**
     * Execute tool action
     */
    async executeAction(action, params) {
      console.log(`[Composio] Executing action: ${action}`);
      
      const result = await request('/tools/execute', {
        method: 'POST',
        body: JSON.stringify({
          action_id: action,
          entity_id: entityId,
          params,
        }),
      });

      return result;
    },

    /**
     * Get available integrations
     */
    async getIntegrations() {
      console.log('[Composio] Fetching integrations');
      
      const result = await request('/integrations');
      
      return result.items || result.integrations || [];
    },
  };
}

/**
 * Generate daily digest from Composio sources
 */
export async function generateDailyDigest(composioClient) {
  const items = [];

  try {
    // Get connected accounts
    const accounts = await composioClient.getConnectedAccounts();
    
    if (!accounts.items || accounts.items.length === 0) {
      return {
        summary: '今天暂无数据',
        items: [],
      };
    }

    // For each connected account, fetch recent activity
    for (const account of accounts.items) {
      const appId = account.integration_id || account.appName;
      
      try {
        // GitHub: recent PRs and issues
        if (appId === 'github') {
          const prs = await composioClient.executeAction('github_list_pull_requests', {
            state: 'open',
            per_page: 5,
          });
          
          if (prs.data) {
            prs.data.forEach(pr => {
              items.push({
                type: 'github_pr',
                title: pr.title,
                description: `#${pr.number} · ${pr.user?.login || 'Unknown'}`,
                url: pr.html_url,
                time: new Date(pr.created_at).toLocaleString('zh-CN'),
                source: 'GitHub',
              });
            });
          }
        }
        
        // Gmail: unread messages
        if (appId === 'gmail') {
          const messages = await composioClient.executeAction('gmail_list_messages', {
            label_ids: ['UNREAD'],
            max_results: 5,
          });
          
          if (messages.data) {
            messages.data.forEach(msg => {
              items.push({
                type: 'gmail_message',
                title: msg.subject || '(No subject)',
                description: msg.from || 'Unknown sender',
                url: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
                time: new Date(msg.date).toLocaleString('zh-CN'),
                source: 'Gmail',
              });
            });
          }
        }
        
        // Slack: recent messages
        if (appId === 'slack') {
          const messages = await composioClient.executeAction('slack_list_messages', {
            limit: 5,
          });
          
          if (messages.data) {
            messages.data.forEach(msg => {
              items.push({
                type: 'slack_message',
                title: msg.text?.substring(0, 100) || '(No text)',
                description: `${msg.channel} · ${msg.user}`,
                url: msg.permalink,
                time: new Date(msg.ts * 1000).toLocaleString('zh-CN'),
                source: 'Slack',
              });
            });
          }
        }
      } catch (err) {
        console.error(`[Composio] Failed to fetch data from ${appId}:`, err.message);
      }
    }

    return {
      summary: `今天收到 ${items.length} 条更新`,
      items,
    };
  } catch (error) {
    console.error('[Composio] Generate digest error:', error);
    return {
      summary: '获取数据失败',
      items: [],
      error: error.message,
    };
  }
}

/**
 * Get sources status
 */
export async function getSourcesStatus(composioClient) {
  try {
    const accounts = await composioClient.getConnectedAccounts();
    
    const sources = accounts.items?.map(account => ({
      name: account.integration_id || account.appName || 'Unknown',
      connected: true,
      description: `Connected as ${account.user_uuid || 'default'}`,
    })) || [];

    if (sources.length === 0) {
      sources.push({
        name: 'Composio',
        connected: false,
        description: '暂无连接的应用',
      });
    }

    return { sources };
  } catch (error) {
    return {
      sources: [
        {
          name: 'Composio',
          connected: false,
          description: error.message,
        },
      ],
    };
  }
}

/**
 * Push daily digest (placeholder - implement delivery mechanism)
 */
export async function pushDailyDigest({ digest, store, config, sendCard }) {
  // TODO: Implement actual delivery (Feishu, email, etc.)
  console.log('[Composio] Push digest:', digest.summary);
  return [];
}

/**
 * Schedule daily digest (placeholder - implement scheduler)
 */
export async function scheduleDailyDigest(schedule) {
  console.log('[Composio] Schedule digest:', schedule);
  // TODO: Implement actual scheduler
}
