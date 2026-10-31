/**
 * Composio v3 REST API client
 * Verified against real API: https://backend.composio.dev/api/v3
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

  // Cache auth_config IDs per toolkit
  const authConfigCache = new Map();

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

  /**
   * Get or create auth_config for a toolkit (e.g., "github")
   */
  async function getAuthConfig(toolkitSlug) {
    // Check cache
    if (authConfigCache.has(toolkitSlug)) {
      return authConfigCache.get(toolkitSlug);
    }

    // Find existing auth_config
    const configs = await request(`/auth_configs?toolkit_slug=${toolkitSlug}`);
    
    // Filter to ensure we only get configs matching this exact toolkit
    const matchingConfigs = configs.items?.filter(
      item => item.toolkit?.slug === toolkitSlug
    ) || [];
    
    if (matchingConfigs.length > 0) {
      const authConfigId = matchingConfigs[0].id;
      authConfigCache.set(toolkitSlug, authConfigId);
      console.log(`[Composio] Found auth_config for ${toolkitSlug}: ${authConfigId}`);
      return authConfigId;
    }

    // Create new auth_config with managed auth
    console.log(`[Composio] Creating auth_config for ${toolkitSlug}...`);
    const result = await request('/auth_configs', {
      method: 'POST',
      body: JSON.stringify({
        toolkit: { slug: toolkitSlug },
        auth_config: { type: 'use_composio_managed_auth' },
      }),
    });

    const authConfigId = result.auth_config?.id || result.id;
    authConfigCache.set(toolkitSlug, authConfigId);
    console.log(`[Composio] Created auth_config: ${authConfigId}`);
    
    return authConfigId;
  }

  return {
    entityId,
    authConfigCache,

    /**
     * Initiate app connection (OAuth)
     * Returns redirect URL for user authorization
     */
    async initiateConnection(appId, callbackUrl = 'http://localhost:7777/composio-callback') {
      console.log(`[Composio] Initiating connection for app: ${appId}`);
      
      // Get or create auth_config
      const authConfigId = await getAuthConfig(appId);
      
      // Create connection link
      const result = await request('/connected_accounts/link', {
        method: 'POST',
        body: JSON.stringify({
          auth_config_id: authConfigId,
          user_id: entityId,
          callback_url: callbackUrl,
        }),
      });

      return {
        redirectUrl: result.redirect_url,
        connectionId: result.connected_account_id,
        authConfigId,
      };
    },

    /**
     * Get connected accounts
     */
    async getConnectedAccounts() {
      console.log('[Composio] Fetching connected accounts');
      
      const result = await request(`/connected_accounts?user_ids=${encodeURIComponent(entityId)}`);
      
      return {
        items: result.items || [],
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
     * @param {string} toolSlug - Tool slug in UPPERCASE_SNAKE_CASE (e.g., "GITHUB_LIST_REPOS")
     * @param {object} args - Tool arguments
     */
    async executeAction(toolSlug, args = {}) {
      console.log(`[Composio] Executing tool: ${toolSlug}`);
      
      const result = await request(`/tools/execute/${toolSlug}`, {
        method: 'POST',
        body: JSON.stringify({
          user_id: entityId,
          arguments: args,
        }),
      });

      return result;
    },

    /**
     * Get available tools for a toolkit
     */
    async getTools(toolkitSlug) {
      console.log(`[Composio] Fetching tools for: ${toolkitSlug}`);
      
      const result = await request(`/tools?toolkit_slug=${toolkitSlug}`);
      
      return result.items || [];
    },

    /**
     * Get available integrations
     */
    async getIntegrations() {
      console.log('[Composio] Fetching integrations');
      
      const result = await request('/integrations');
      
      return result.items || [];
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

    console.log(`[Composio] Found ${accounts.items.length} connected accounts`);

    // For each connected account, fetch recent activity
    for (const account of accounts.items) {
      const toolkitSlug = account.integration_id || account.toolkit_slug;
      
      if (!toolkitSlug) continue;

      try {
        // GitHub: recent repos and PRs
        if (toolkitSlug === 'github') {
          const repos = await composioClient.executeAction('GITHUB_LIST_REPOS', {
            sort: 'updated',
            per_page: 5,
          });
          
          if (repos.data) {
            repos.data.forEach(repo => {
              items.push({
                type: 'github_repo',
                title: repo.name,
                description: repo.description || 'No description',
                url: repo.html_url,
                time: new Date(repo.updated_at).toLocaleString('zh-CN'),
                source: 'GitHub',
              });
            });
          }
        }
        
        // Gmail: unread messages
        if (toolkitSlug === 'gmail') {
          const messages = await composioClient.executeAction('GMAIL_LIST_MESSAGES', {
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
        if (toolkitSlug === 'slack') {
          const messages = await composioClient.executeAction('SLACK_LIST_MESSAGES', {
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
        console.error(`[Composio] Failed to fetch data from ${toolkitSlug}:`, err.message);
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
      name: account.integration_id || account.toolkit_slug || 'Unknown',
      connected: account.status === 'ACTIVE',
      description: `Connected as ${account.user_id || 'default'}`,
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
 * Push daily digest (placeholder)
 */
export async function pushDailyDigest({ digest, store, config, sendCard }) {
  console.log('[Composio] Push digest:', digest.summary);
  return [];
}

/**
 * Schedule daily digest (placeholder)
 */
export async function scheduleDailyDigest(schedule) {
  console.log('[Composio] Schedule digest:', schedule);
}
