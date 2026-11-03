/**
 * API routes for the web interface
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDailyDigest, getSourcesStatus, pushDailyDigest, createComposioClient } from './composio.js';
import { reminderCard } from '../host/cards.js';
import { createProfileManager } from './profile.js';
import { resolveDisplayName, lastGithubIdentity } from './aggregation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Static list of popular Composio apps
const COMPOSIO_APPS = [
  { key: 'github', name: 'GitHub', category: '开发协作', logo: 'https://logos.composio.dev/api/github', description: 'PR、issue 与 review 请求，汇总到每日项目卡片', authMode: 'OAUTH2' },
  { key: 'gitlab', name: 'GitLab', category: '开发协作', logo: 'https://logos.composio.dev/api/gitlab', description: '合并请求与 issue 动态', authMode: 'OAUTH2' },
  { key: 'linear', name: 'Linear', category: '开发协作', logo: 'https://logos.composio.dev/api/linear', description: '分配给你的 Linear 任务与进度', authMode: 'OAUTH2' },
  { key: 'jira', name: 'Jira', category: '开发协作', logo: 'https://logos.composio.dev/api/jira', description: 'Jira 工单、冲刺与指派', authMode: 'OAUTH2' },
  { key: 'figma', name: 'Figma', category: '开发协作', logo: 'https://logos.composio.dev/api/figma', description: '设计文件评论与更新', authMode: 'OAUTH2' },
  { key: 'gmail', name: 'Gmail', category: '邮件与消息', logo: 'https://logos.composio.dev/api/gmail', description: '未读与重要邮件，提醒你该回谁', authMode: 'OAUTH2' },
  { key: 'outlook', name: 'Outlook', category: '邮件与消息', logo: 'https://logos.composio.dev/api/outlook', description: 'Outlook 邮件与日程', authMode: 'OAUTH2' },
  { key: 'slack', name: 'Slack', category: '邮件与消息', logo: 'https://logos.composio.dev/api/slack', description: '频道 @你 的消息与私信', authMode: 'OAUTH2' },
  { key: 'microsoft_teams', name: 'Microsoft Teams', category: '邮件与消息', logo: 'https://logos.composio.dev/api/microsoft_teams', description: 'Teams 聊天与频道消息', authMode: 'OAUTH2' },
  { key: 'discord', name: 'Discord', category: '邮件与消息', logo: 'https://logos.composio.dev/api/discord', description: '服务器频道里提到你的消息', authMode: 'OAUTH2' },
  { key: 'telegram', name: 'Telegram', category: '邮件与消息', logo: 'https://logos.composio.dev/api/telegram', description: 'Telegram 机器人消息（需 Bot Token）', authMode: 'API_KEY' },
  { key: 'whatsapp', name: 'WhatsApp', category: '邮件与消息', logo: 'https://logos.composio.dev/api/whatsapp', description: 'WhatsApp Business 消息', authMode: 'OAUTH2' },
  { key: 'googlecalendar', name: 'Google 日历', category: '日程与会议', logo: 'https://logos.composio.dev/api/googlecalendar', description: '今天的会议，自动排进「我的一天」', authMode: 'OAUTH2' },
  { key: 'calendly', name: 'Calendly', category: '日程与会议', logo: 'https://logos.composio.dev/api/calendly', description: '别人在你日历上预约的时段', authMode: 'OAUTH2' },
  { key: 'zoom', name: 'Zoom', category: '日程与会议', logo: 'https://logos.composio.dev/api/zoom', description: '即将开始的 Zoom 会议与录制', authMode: 'OAUTH2' },
  { key: 'notion', name: 'Notion', category: '文档与知识', logo: 'https://logos.composio.dev/api/notion', description: 'Notion 页面与数据库更新', authMode: 'OAUTH2' },
  { key: 'googledrive', name: 'Google Drive', category: '文档与知识', logo: 'https://logos.composio.dev/api/googledrive', description: '最近修改与共享给你的文件', authMode: 'OAUTH2' },
  { key: 'googledocs', name: 'Google Docs', category: '文档与知识', logo: 'https://logos.composio.dev/api/googledocs', description: '文档评论与 @提及', authMode: 'OAUTH2' },
  { key: 'googlesheets', name: 'Google Sheets', category: '文档与知识', logo: 'https://logos.composio.dev/api/googlesheets', description: '表格数据变化', authMode: 'OAUTH2' },
  { key: 'confluence', name: 'Confluence', category: '文档与知识', logo: 'https://logos.composio.dev/api/confluence', description: '团队 Wiki 页面更新', authMode: 'OAUTH2' },
  { key: 'dropbox', name: 'Dropbox', category: '文档与知识', logo: 'https://logos.composio.dev/api/dropbox', description: 'Dropbox 文件变动', authMode: 'OAUTH2' },
  { key: 'one_drive', name: 'OneDrive', category: '文档与知识', logo: 'https://logos.composio.dev/api/one_drive', description: 'OneDrive 文件变动', authMode: 'OAUTH2' },
  { key: 'asana', name: 'Asana', category: '任务与项目', logo: 'https://logos.composio.dev/api/asana', description: 'Asana 任务与截止日期', authMode: 'OAUTH2' },
  { key: 'trello', name: 'Trello', category: '任务与项目', logo: 'https://logos.composio.dev/api/trello', description: 'Trello 看板卡片变动', authMode: 'OAUTH1' },
  { key: 'clickup', name: 'ClickUp', category: '任务与项目', logo: 'https://logos.composio.dev/api/clickup', description: 'ClickUp 任务与提醒', authMode: 'OAUTH2' },
  { key: 'todoist', name: 'Todoist', category: '任务与项目', logo: 'https://logos.composio.dev/api/todoist', description: '今天到期的 Todoist 待办', authMode: 'OAUTH2' },
  { key: 'airtable', name: 'Airtable', category: '任务与项目', logo: 'https://logos.composio.dev/api/airtable', description: 'Airtable 表格记录', authMode: 'OAUTH2' },
  { key: 'twitter', name: 'X / Twitter', category: '资讯与社区', logo: 'https://logos.composio.dev/api/twitter', description: '提及、私信与关注的动态', authMode: 'OAUTH2' },
  { key: 'reddit', name: 'Reddit', category: '资讯与社区', logo: 'https://logos.composio.dev/api/reddit', description: '订阅版块的热门帖子', authMode: 'OAUTH2' },
  { key: 'youtube', name: 'YouTube', category: '资讯与社区', logo: 'https://logos.composio.dev/api/youtube', description: '订阅频道的新视频', authMode: 'OAUTH2' },
  { key: 'hackernews', name: 'Hacker News', category: '资讯与社区', logo: 'https://logos.composio.dev/api/hackernews', description: 'HN 热门与你关注的话题（无需授权）', authMode: 'NO_AUTH' },
  { key: 'spotify', name: 'Spotify', category: '生活', logo: 'https://logos.composio.dev/api/spotify', description: '最近播放与歌单', authMode: 'OAUTH2' },
  { key: 'strava', name: 'Strava', category: '生活', logo: 'https://logos.composio.dev/api/strava', description: '运动记录，用于「我的一天」节奏建议', authMode: 'OAUTH2' },
];

// In-memory chat history per session
const chatSessions = new Map();

/**
 * System prompt for card-based responses
 */
const CARD_SYSTEM_PROMPT = `你是「豆芽」，一个智能数字同事助手。你的回复必须简洁、结构化，以卡片形式呈现。

**核心原则**：
- 文本要简短（1-2 句话总结）
- 交互通过卡片（info/action/choice/task/event）
- 每次回复 1-3 张卡片

**严格禁止编造数据**：
- 绝不虚构项目、任务、会议、邮件、代码仓库、PR、Issue、消息等任何数据
- 绝不编造数字、统计、人名、时间
- 只使用用户消息中明确提到的信息和系统提供的真实上下文数据
- 如果没有相关数据，诚实说明"暂无相关数据"，并引导用户连接数据源

**回复格式（JSON）**：
{
  "text": "简短总结（1-2句话）",
  "cards": [
    {
      "type": "info|action|choice|task|event",
      "title": "卡片标题",
      "description": "详细说明（可选）",
      "actions": [{"label": "按钮文字", "value": "人类可读的完整文本"}],
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

**重要**：
- actions 的 value 字段必须是人类可读的完整文本（如"查看今日任务"），不是代码标识符（如"view_today"）
- 点击按钮后，value 会作为新消息发送，必须是合理的人类问句

**示例**：
用户："今天有什么安排？"
{
  "text": "<根据工具返回的真实数据写的一句话>",
  "cards": [
    {"type":"event","title":"<真实日程标题>","time":"<真实时间>"}
  ]
}

用户："我的项目"
（如果没有连接 GitHub/Linear 等数据源）
{
  "text": "暂无项目数据",
  "cards": [
    {"type":"action","title":"连接数据源","description":"连接 GitHub、Linear 或 Notion 以查看项目","actions":[{"label":"前往设置","value":"打开设置页面"}]}
  ]
}

严格返回 JSON，不要 markdown 格式。`;

/**
 * Gather real context from connected data sources
 */
async function gatherContext(composioClient, store) {
  const context = {
    connectedSources: [],
    hasData: false,
    data: {},
  };

  try {
    // Check connected Composio accounts
    if (composioClient) {
      const result = await composioClient.getConnectedAccounts();
      const accounts = result?.items || [];
      
      if (accounts.length > 0) {
        // Extract toolkit slugs from ACTIVE accounts
        context.connectedSources = accounts
          .filter(acc => acc.status === 'ACTIVE' && acc.toolkit?.slug)
          .map(acc => ({
            slug: acc.toolkit.slug,
            identity: acc.metadata?.username || acc.metadata?.email || acc.user_id,
          }));
        context.hasData = context.connectedSources.length > 0;

        // Fetch real data from connected sources (limited to avoid token overflow)
        for (const account of accounts.slice(0, 3)) {  // Max 3 sources
          if (account.status !== 'ACTIVE' || !account.toolkit?.slug) continue;
          
          const slug = account.toolkit.slug;
          
          try {
            if (slug === 'github') {
              // Get user's repos (first 5)
              const repos = await composioClient.executeAction('GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER', {
                per_page: 5,
                sort: 'updated',
              });
              context.data.github = {
                repos: repos?.data?.repositories?.slice(0, 5).map(r => ({
                  name: r.name,
                  description: r.description,
                  updated: r.updated_at,
                })) || [],
              };
            } else if (slug === 'googlecalendar') {
              // Get today's events
              const now = new Date();
              const startOfDay = new Date(now.setHours(0,0,0,0)).toISOString();
              const endOfDay = new Date(now.setHours(23,59,59,999)).toISOString();
              
              const events = await composioClient.executeAction('GOOGLECALENDAR_EVENTS_LIST', {
                timeMin: startOfDay,
                timeMax: endOfDay,
                maxResults: 5,
              });
              context.data.calendar = {
                events: events?.data?.items?.slice(0, 5).map(e => ({
                  summary: e.summary,
                  start: e.start?.dateTime || e.start?.date,
                })) || [],
              };
            } else if (slug === 'gmail') {
              // Get recent emails
              const emails = await composioClient.executeAction('GMAIL_FETCH_EMAILS', {
                max_results: 3,
                query: 'in:inbox',
              });
              context.data.gmail = {
                unread: emails?.data?.messages?.length || 0,
              };
            }
          } catch (err) {
            console.warn(`[gatherContext] Failed to fetch ${slug} data:`, err.message);
          }
        }
      }
    }

    // Get local store tasks
    if (store) {
      try {
        const tasks = await store.get('tasks') || [];
        if (tasks.length > 0) {
          context.hasData = true;
          context.data.localTasks = tasks.slice(0, 10).map(t => ({
            title: t.title,
            status: t.status,
            due: t.due,
          }));
        }
      } catch (err) {
        console.warn('[Context] Failed to get local tasks:', err.message);
      }
    }

  } catch (err) {
    console.error('[Context] Error gathering context:', err);
  }

  return context;
}

/**
 * Build context message for LLM
 */
function buildContextMessage(context) {
  if (!context.hasData || context.connectedSources.length === 0) {
    return `
当前状态：未连接任何数据源

用户还没有连接 GitHub、Gmail、Calendar 等数据源，也没有本地任务数据。
如果用户询问项目、邮件、日程、任务等信息，你可以调用工具尝试获取，但工具会返回 "not connected" 错误。
这时请：
1. 诚实说明"暂无相关数据"或"未连接 XX 数据源"
2. 提供卡片引导用户连接数据源（设置页面）
3. 绝不编造任何数据

示例回复：
{
  "text": "暂无项目数据",
  "cards": [{
    "type": "action",
    "title": "连接数据源",
    "description": "连接 GitHub、Linear 或 Notion 以查看项目",
    "actions": [{"label": "前往设置", "value": "打开设置页面"}]
  }]
}`;
  }

  let message = '\n当前连接的数据源：\n';
  message += context.connectedSources.map(s => `${s.slug} (${s.identity})`).join('、') + '\n\n';
  message += '真实数据上下文（只使用这些数据回答问题）：\n';

  if (context.data.github?.repos) {
    message += '\nGitHub 仓库（最近更新的 5 个）：\n';
    context.data.github.repos.forEach(r => {
      message += `- ${r.name}${r.description ? ': ' + r.description : ''}\n`;
    });
  }

  if (context.data.gmail) {
    message += `\nGmail: 收件箱有 ${context.data.gmail.unread} 封未读邮件\n`;
  }

  if (context.data.calendar?.events) {
    message += '\n今日日程：\n';
    if (context.data.calendar.events.length === 0) {
      message += '今天没有日程安排\n';
    } else {
      context.data.calendar.events.forEach(e => {
        message += `- ${e.summary} (${e.start})\n`;
      });
    }
  }

  message += '\n重要：只使用以上真实数据回答问题，绝不编造其他信息。如需更多数据，调用相应工具。';
  return message;
}

/**
 * Call LLM - Build client from config store on-demand
 */
/**
 * Call LLM with function calling support for Composio tools
 * @param {object} ctx - Context with llm client
 * @param {Array} messages - Message history
 * @param {string} sessionId - Session ID for logging
 * @param {object} composioClient - Composio client for tool execution
 * @returns {Promise<{text: string, cards: Array}>}
 */
async function callLLM(ctx, messages, sessionId = 'web-chat', composioClient = null) {
  const { createComposioTools, AGENT_SYSTEM_PROMPT } = await import('./agent-tools.js');
  const { createTodayTools } = await import('./card-tools.js');
  
  // Build tool definitions
  const composioTools = composioClient ? createComposioTools(composioClient) : [];
  const cardTools = createTodayTools(callLLM.router); // Pass router for card operations
  const tools = [...composioTools, ...cardTools];
  
  // Prepend system prompt
  const messagesWithSystem = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    ...messages,
  ];

  // Try to get LLM from context first (ds-bot mode)
  if (ctx?.llm?.stream) {
    try {
      return await callLLMWithTools(ctx.llm, messagesWithSystem, tools, sessionId);
    } catch (error) {
      console.error('[LLM] ds-bot error:', error);
      throw error;  // Rethrow to let caller handle
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

        return await callLLMWithTools(client, messagesWithSystem, tools, sessionId);
      } catch (error) {
        console.error('[LLM] Standalone mode error:', error);
        throw error;  // Rethrow to let caller handle
      }
    }
  }

  // No LLM available - throw error
  throw new Error('模型未配置。请先在设置中配置 LLM 模型');
}

/**
 * Parse model output as JSON. Tolerates code fences, leading noise, and
 * native tool-call markup some providers emit (e.g. <invoke name="x"> … {args}).
 */
function parseModelJson(text, tools = []) {
  const t = String(text || '').trim();
  try { return JSON.parse(t); } catch {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const names = new Set(tools.map(x => x.name));
  const invokes = [...t.matchAll(/invoke\s+name\s*=\s*"([\w.-]+)"/g)].map(m => m[1]);
  const named = invokes.find(n => names.has(n)) || [...names].find(n => t.includes(n));
  const objs = t.match(/\{[\s\S]*\}/);
  if (named) {
    let args = {};
    if (objs) { try { args = JSON.parse(objs[0]); } catch {} }
    return { tool_calls: [{ name: named, arguments: args }] };
  }
  if (objs) { try { return JSON.parse(objs[0]); } catch {} }
  return null;
}

/**
 * Call LLM with function calling and execute tools
 * @param {object} llm - LLM client with stream method
 * @param {Array} messages - Message history with system prompt
 * @param {Array} tools - Tool definitions
 * @param {string} sessionId - Session ID for logging
 * @returns {Promise<{text: string, cards: Array}>}
 */
async function callLLMWithTools(llm, messages, tools, sessionId) {
  const { groupsToCards } = await import('./chat-groups.js');
  const collectedGroups = [];

  // Intent pre-fetch: for inbox / PR / issue questions, always pull fresh data and
  // aggregate it, instead of letting the model answer from chat history.
  const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const intents = [
    [/邮件|邮箱|inbox|e-?mail|gmail/i, 'gmail_fetch_emails', {}],
    [/\bPR\b|pull request|合并请求|review/i, 'github_search_my_prs', {}],
    [/\bissue/i, 'github_list_my_issues', {}],
    [/slack|频道|私信|channel/i, 'slack_search_messages', {}],
  ];
  const pre = [];
  for (const [re, name, args] of intents) {
    const tool = tools.find(t => t.name === name);
    if (tool && re.test(lastUser)) {
      try {
        const result = await tool.execute(args);
        if (Array.isArray(result?.groups)) collectedGroups.push(...result.groups);
        pre.push({ tool: name, result });
      } catch (e) { pre.push({ tool: name, error: e.message }); }
    }
  }
  if (pre.length) {
    messages = [...messages, { role: 'user', content: `系统已为这条消息实时拉取并预聚合了数据（不要再调用同名工具）：\n${JSON.stringify(pre)}\n\n请按「聚合原则」直接给出最终 JSON 回复。` }];
  }
  const MAX_TOOL_ITERATIONS = 5;
  let iteration = 0;
  let currentMessages = [...messages];

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++;
    console.log(`[LLM] Iteration ${iteration}, messages: ${currentMessages.length}`);

    // For models that support function calling (like OpenAI)
    // we would pass tools here. For now, we use JSON mode and parse tool calls manually
    let fullText = '';
    for await (const chunk of llm.stream({
      messages: currentMessages.map(({ role, content }) => ({ role, content })),
      maxTokens: 2000,
      responseFormat: { type: 'json_object' },
    })) {
      if (chunk.type === 'text' && chunk.text) {
        fullText += chunk.text;
      }
    }

    console.log(`[LLM] Received ${fullText.length} chars`);

    if (!fullText.trim()) {
      throw new Error('模型返回了空响应');
    }

    // Try to parse as JSON
    let parsed = parseModelJson(fullText, tools);
    if (!parsed) {
      console.error('[LLM] Failed to parse JSON:', fullText.substring(0, 200));
      if (!currentMessages.some(m => m.__jsonRetry)) {
        currentMessages.push({ role: 'user', content: '请只输出一个合法 JSON 对象（tool_calls 或 text+cards），不要输出其他标记。', __jsonRetry: true });
        continue;
      }
      throw new Error('模型返回的不是有效的 JSON 格式');
    }

    // Check if response contains tool calls
    if (parsed.tool_calls && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
      console.log(`[LLM] Model requested ${parsed.tool_calls.length} tool calls`);
      
      // Execute all tool calls
      const toolResults = [];
      for (const toolCall of parsed.tool_calls) {
        const tool = tools.find(t => t.name === toolCall.name);
        if (!tool) {
          toolResults.push({
            tool: toolCall.name,
            error: 'Tool not found',
          });
          continue;
        }

        try {
          console.log(`[LLM] Executing tool: ${toolCall.name}`);
          const result = await tool.execute(toolCall.arguments || {});
          if (Array.isArray(result?.groups)) collectedGroups.push(...result.groups);
          toolResults.push({
            tool: toolCall.name,
            result,
          });
          console.log(`[LLM] Tool ${toolCall.name} returned:`, JSON.stringify(result).substring(0, 100));
        } catch (error) {
          toolResults.push({
            tool: toolCall.name,
            error: error.message,
          });
          console.error(`[LLM] Tool ${toolCall.name} failed:`, error);
        }
      }

      // Add tool results to messages and continue
      currentMessages.push({
        role: 'assistant',
        content: JSON.stringify({ tool_calls: parsed.tool_calls }),
      });
      currentMessages.push({
        role: 'user',
        content: `工具调用结果：\n${JSON.stringify(toolResults, null, 2)}\n\n请基于以上真实数据回复用户。`,
      });

      continue;  // Next iteration with tool results
    }

    // No tool calls, this is the final response
    const result = parseResponseToCards(fullText);
    // Aggregation guarantee: when tools produced groups, reply with group cards
    // (real links from the server), merging any richer why/nextAction from the model.
    if (collectedGroups.length) {
      const byKey = new Map((result.cards || []).filter(c => c && c.key).map(c => [c.key, c]));
      result.cards = groupsToCards(collectedGroups).map(c => {
        const m = byKey.get(c.key);
        return m ? { ...c, why: m.why || c.why, description: m.why || c.description, nextAction: m.nextAction || c.nextAction } : c;
      }).sort((a, b) => (a.waiting === 'fyi') - (b.waiting === 'fyi'));
    }
    console.log(`[LLM] Final response: text=${result.text?.length || 0} chars, cards=${result.cards?.length || 0}`);
    return result;
  }

  throw new Error('达到最大工具调用次数限制');
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
  const { store, config, configStore } = ctx;
  const llmCtx = ctx.llmCtx || ctx.ctx;

  // Export configStore for callLLM to access
  callLLM.configStore = configStore;
  
  // Initialize profile manager
  const profilePath = join(config?.dataDir || './.odm-data', 'profile.json');
  const profileManager = createProfileManager(profilePath);
  const identityCache = { tried: false, value: null };
  
  // Load profile on startup
  profileManager.load().catch(err => {
    console.warn('[Profile] Failed to load:', err.message);
  });

  /**
   * Get Composio client - builds lazily from saved config or env
   */
  function getComposioClient() {
    // Check if already built in context
    if (ctx.composioClient) {
      return ctx.composioClient;
    }

    // Build from saved config (configStore saves flat keys)
    const cfg = configStore?.get();
    if (cfg?.composioApiKey) {
      try {
        ctx.composioClient = createComposioClient({
          composioApiKey: cfg.composioApiKey,
          composioEntityId: cfg.composioEntityId || 'default',
        });
        console.log('[Composio] Client built from saved config');
        return ctx.composioClient;
      } catch (err) {
        console.error('[Composio] Failed to build client from config:', err);
      }
    }

    // Build from environment
    if (process.env.COMPOSIO_API_KEY) {
      try {
        ctx.composioClient = createComposioClient({
          composioApiKey: process.env.COMPOSIO_API_KEY,
          composioEntityId: process.env.COMPOSIO_ENTITY_ID || 'default',
        });
        console.log('[Composio] Client built from environment');
        return ctx.composioClient;
      } catch (err) {
        console.error('[Composio] Failed to build client from env:', err);
      }
    }

    return null;
  }

  
  const router = {
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

        // Get cards from store
        const state = store.get();
        const cards = state.cards || [];
        
        // Filter active cards (not done/deleted/snoozed)
        const activeCards = cards.filter(c => c.status === 'active' || !c.status);
        
        // Count meetings (event-type cards)
        const meetings = activeCards.filter(c => c.type === 'event');
        const meetingHours = meetings.reduce((sum, m) => {
          // Extract duration if available in body or default to 1h
          const match = m.body?.match(/(\d+(\.\d+)?)\s*(h|小时|hour)/i);
          return sum + (match ? parseFloat(match[1]) : 1);
        }, 0);
        
        // Work items = everything except system tiles (hero / timetable), so the
        // header count always matches the cards rendered in the grid.
        const SYSTEM_TYPES = new Set(['hero', 'timetable']);
        const actionable = activeCards.filter(c => !SYSTEM_TYPES.has(c.type) && c.source !== 'system' && c.type !== 'event');
        const urgent = actionable.filter(c => c.priority === 'urgent' || c.priority === 'high');
        
        // Build sources list
        const sources = [...new Set(activeCards.map(c => c.source).filter(Boolean))].filter(s => s !== 'system');
        const sourcesText = sources.length > 0 
          ? sources.map(s => {
              const map = { github: 'GitHub', gmail: 'Gmail', googlecalendar: '日历', slack: 'Slack', manual: '手动' };
              return map[s] || s;
            }).join('、')
          : '暂无数据';

        // Display name ONLY from connected sources (GitHub name → login). Never profile.json.
        const home = config.home || '.odm-data';
        if (!identityCache.value) {
          const { loadCachedIdentity } = await import('./identity.js');
          identityCache.value = await loadCachedIdentity(home);
        }
        let userName = resolveDisplayName('', identityCache.value || lastGithubIdentity);
        if (!userName || !identityCache.tried) {
          identityCache.tried = true;
          try {
            const { fetchIdentityFromSources, displayNameOf } = await import('./identity.js');
            const id = await fetchIdentityFromSources(getComposioClient(), { home, log: console.log });
            if (id) identityCache.value = id;
            userName = displayNameOf(identityCache.value || lastGithubIdentity);
          } catch (e) { console.warn('[Identity] lookup failed:', e.message); }
        }

        return {
          summary: activeCards.length === 0
            ? '今天还没有待办，点「立即汇聚」拉取最新动态'
            : `今天 ${meetings.length} 个会，${actionable.length} 件在手，其中 ${urgent.length} 件优先`,
          date: today,
          sources: sourcesText,
          userName,
          openCount: actionable.length,
          urgentCount: urgent.length,
          meetingCount: meetings.length,
          meetingHours: Math.round(meetingHours * 10) / 10,
          waitingCount: activeCards.filter(c => c.status === 'waiting').length,
          lastDigestAt: state.lastDigest?.generatedAt || null,
          cards: activeCards,
          hasDigest: state.lastDigest !== null,
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
          cards: [],
          hasDigest: false,
        };
      }
    },

    /**
     * GET /api/digest - Get Composio daily digest
     */
    async getDigest() {
      try {
        const client = getComposioClient();
        if (!client) {
          return {
            error: 'Composio 未配置。请设置 API Key',
            items: [],
          };
        }

        const digest = await generateDailyDigest(client);
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
     * POST /api/digest/generate - Manually trigger digest generation with LLM summary
     */
    async generateDigestNow() {
      try {
        const client = getComposioClient();
        if (!client) {
          return {
            success: false,
            error: 'Composio 未配置。请先设置 Composio API Key',
          };
        }

        // Check LLM configuration
        const llmConfig = configStore?.get()?.llm;
        if (!llmConfig?.apiKey || !llmConfig?.provider) {
          return {
            success: false,
            error: '模型未配置。请先在设置中配置 LLM 模型',
          };
        }

        // Get ACTIVE connected accounts
        const result = await client.getConnectedAccounts();
        const accounts = result?.items || [];
        const activeAccounts = accounts.filter(acc => acc.status === 'ACTIVE' && acc.toolkit?.slug);

        if (activeAccounts.length === 0) {
          return {
            success: false,
            error: '未连接任何数据源。请先连接 GitHub、Gmail 或 Calendar',
          };
        }

        // Create LLM client
        const { createLLMClient } = await import('./llm-client.js');
        const llm = createLLMClient({
          provider: llmConfig.provider,
          baseURL: llmConfig.baseURL,
          apiKey: llmConfig.apiKey,
          model: llmConfig.model,
          log: console.log,
        });

        // Run multi-stage aggregation pipeline with profile context
        const { runAggregationPipeline } = await import('./aggregation.js');
        const profileContext = profileManager.getPersonalizationContext();
        const brief = await runAggregationPipeline(client, activeAccounts, llm, profileContext);

        // CRITICAL: Cards are append/merge-only, NEVER wiped
        // Store.save() now handles merging internally
        const state = store.get();
        
        // Learn from generated cards
        await profileManager.learnFromCards(brief.cards);
        // Refresh display name from connected sources after digest (never write it into profile.json).
        try {
          const { fetchIdentityFromSources } = await import('./identity.js');
          const id = await fetchIdentityFromSources(client, { home: config.home || '.odm-data', log: console.log });
          if (id) identityCache.value = id;
          // Drop any leftover personal name that was once saved into the profile.
          const ctx = profileManager.getPersonalizationContext();
          if (ctx.name) await profileManager.save({ name: '' });
        } catch (e) { console.warn('[Identity] digest refresh failed:', e.message); }
        
        // Just pass the new cards to store.save()
        // Store will merge them with existing cards by sourceId
        state.cards = brief.cards;
        state.lastDigest = {
          summary: brief.summary,
          generatedAt: new Date().toISOString(),
          itemCount: brief.cards.length,
          sources: activeAccounts.map(a => a.toolkit.slug),
        };
        
        await store.save(state);
        
        // Get final merged count
        const finalState = store.get();
        const newCardCount = finalState.cards.length - (state.cards?.length || 0);

        console.log(`[generateDigest] Generated brief: ${brief.summary}`);
        console.log(`[generateDigest] Total cards in store: ${finalState.cards.length} (added ${newCardCount >= 0 ? newCardCount : 'and updated'})`);

        return {
          success: true,
          summary: brief.summary,
          totalCardCount: finalState.cards.length,
          timestamp: state.lastDigest.generatedAt,
        };
      } catch (err) {
        console.error('[generateDigest] Error:', err);
        return {
          success: false,
          error: err.message || '生成汇聚失败',
        };
      }
    },

    /**
     * GET /api/cards - List all today cards
     */
    async listCards() {
      try {
        const state = store.get();
        const cards = state.cards || [];
        
        // Sort by priority (high first) then by createdAt (newest first)
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        const sorted = [...cards].sort((a, b) => {
          const priorityDiff = (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1);
          if (priorityDiff !== 0) return priorityDiff;
          return new Date(b.createdAt) - new Date(a.createdAt);
        });
        
        return { cards: sorted };
      } catch (err) {
        console.error('[listCards] Error:', err);
        return { cards: [] };
      }
    },

    /**
     * POST /api/cards - Create a new card
     */
    async createCard(data) {
      try {
        const { source, type, title, body, url, priority, status } = data;
        
        if (!title) {
          return { success: false, error: '标题不能为空' };
        }
        
        const now = new Date().toISOString();
        const card = {
          id: `card_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          source: source || 'manual',
          type: type || 'info',
          title,
          body: body || '',
          url: url || null,
          priority: priority || 'medium',
          status: status || 'active',
          createdAt: now,
          updatedAt: now,
        };
        
        const state = store.get();
        state.cards = state.cards || [];
        state.cards.push(card);
        await store.save(state);
        
        console.log('[createCard] Created:', card.id, card.title);
        return { success: true, card };
      } catch (err) {
        console.error('[createCard] Error:', err);
        return { success: false, error: err.message };
      }
    },

    /**
     * POST /api/cards/:id - Update an existing card
     */
    async updateCard(id, updates) {
      try {
        const state = store.get();
        const cards = state.cards || [];
        const index = cards.findIndex(c => c.id === id);
        
        if (index === -1) {
          return { success: false, error: '卡片不存在' };
        }
        
        const card = cards[index];
        const updated = {
          ...card,
          ...updates,
          id: card.id, // Prevent ID change
          createdAt: card.createdAt, // Prevent createdAt change
          updatedAt: new Date().toISOString(),
        };
        
        cards[index] = updated;
        await store.save(state);
        
        console.log('[updateCard] Updated:', id, updated.title);
        return { success: true, card: updated };
      } catch (err) {
        console.error('[updateCard] Error:', err);
        return { success: false, error: err.message };
      }
    },

    /**
     * DELETE /api/cards/:id - Delete a card
     */
    async deleteCard(id) {
      try {
        const state = store.get();
        const cards = state.cards || [];
        const index = cards.findIndex(c => c.id === id);
        
        if (index === -1) {
          return { success: false, error: '卡片不存在' };
        }
        
        const deleted = cards.splice(index, 1)[0];
        await store.save(state);
        
        console.log('[deleteCard] Deleted:', id, deleted.title);
        return { success: true };
      } catch (err) {
        console.error('[deleteCard] Error:', err);
        return { success: false, error: err.message };
      }
    },
    
    /**
     * POST /api/cards/:id/interact - Track card interaction
     */
    async trackCardInteraction(id, action) {
      try {
        const state = store.get();
        const cards = state.cards || [];
        const card = cards.find(c => c.id === id);
        
        if (!card) {
          return { success: false, error: '卡片不存在' };
        }
        
        // Track in profile
        await profileManager.trackInteraction(card.sourceId, action);
        
        // Update card status if action implies it
        if (action === 'done' && card.status !== 'done') {
          card.status = 'done';
          card.updatedAt = new Date().toISOString();
          await store.save(state);
        } else if (action === 'dismiss' && card.status !== 'dismissed') {
          card.status = 'dismissed';
          card.updatedAt = new Date().toISOString();
          await store.save(state);
        }
        
        console.log('[trackInteraction]', action, card.sourceId);
        return { success: true };
      } catch (err) {
        console.error('[trackInteraction] Error:', err);
        return { success: false, error: err.message };
      }
    },

    /**
     * GET /api/sources - Get connected sources status
     */
    async getSources() {
      try {
        const client = getComposioClient();
        
        if (!client) {
          return {
            sources: COMPOSIO_APPS.map(app => ({
              name: app.name,
              logo: app.logo,
              description: app.description,
              connected: false,
              identity: null,
            })),
          };
        }

        // Get all connected accounts from Composio v3
        const result = await client.getConnectedAccounts();
        const accounts = result?.items || [];
        
        // Build map of ACTIVE connections by toolkit.slug
        const activeConnections = new Map();
        accounts.forEach(account => {
          // Only include ACTIVE connections, skip INITIATED
          if (account.status === 'ACTIVE' && account.toolkit?.slug) {
            const slug = account.toolkit.slug;
            
            // Extract real account identity if available
            let identity = account.user_id || 'default';
            
            // Try to get more specific identity from account data
            if (account.account_display_name) {
              identity = account.account_display_name;
            } else if (account.user_info?.login) {
              identity = account.user_info.login;  // GitHub login
            } else if (account.user_info?.email) {
              identity = account.user_info.email;  // Gmail address
            } else if (account.metadata?.username) {
              identity = account.metadata.username;
            } else if (account.metadata?.email) {
              identity = account.metadata.email;
            }
            
            // Only store first ACTIVE connection per toolkit (dedupe)
            if (!activeConnections.has(slug)) {
              activeConnections.set(slug, {
                connectionId: account.id,
                identity,
                connectedAt: account.createdAt,
                status: account.status,
              });
            }
          }
        });

        // Map supported apps with connection status
        const sources = COMPOSIO_APPS.map(app => {
          const toolkitSlug = app.toolkitSlug || app.key;
          const connection = activeConnections.get(toolkitSlug);
          
          return {
            name: app.name,
            logo: app.logo,
            description: app.description,
            key: app.key,
            connected: !!connection,
            identity: connection?.identity || null,
            connectionId: connection?.connectionId || null,
            connectedAt: connection?.connectedAt || null,
          };
        });

        return { sources };
      } catch (err) {
        console.error('API /sources error:', err);
        return {
          sources: COMPOSIO_APPS.map(app => ({
            name: app.name,
            logo: app.logo,
            description: app.description,
            connected: false,
            identity: null,
          })),
          error: err.message,
        };
      }
    },

    /**
     * GET /api/config/check - Check if Composio is configured
     */
    async checkConfig() {
      const client = getComposioClient();
      return {
        configured: !!client,
        composioApiKey: !!(configStore?.get()?.composio?.apiKey || process.env.COMPOSIO_API_KEY),
        composioEntityId: configStore?.get()?.composio?.entityId || process.env.COMPOSIO_ENTITY_ID || 'default',
        digestSchedule: config?.digestSchedule || '08:00',
        llmConfigured: !!(llmCtx?.llm?.stream),
      };
    },

    /**
     * GET /api/chat/history — transcript from the real ds-bot Chief.
     */
    async getChatHistory() {
      const { loadDsBotHistory, BOT_SESSION_ID } = await import('./dsbot-chat.js');
      const home = config.home || '.odm-data';
      try {
        const hist = await loadDsBotHistory({
          home,
          baseUrl: process.env.DSBOT_URL || 'http://127.0.0.1:7788',
          token: process.env.DSBOT_TOKEN,
        });
        return { sessionId: hist.sessionId || BOT_SESSION_ID, messages: hist.messages || [], botId: hist.botId || null };
      } catch (err) {
        console.error('[getChatHistory] ds-bot:', err.message);
        return { sessionId: BOT_SESSION_ID, messages: [], error: err.message };
      }
    },

    /**
     * POST /api/chat - Send a chat message and get LLM response with cards
     */
    async sendChatMessage(data) {
      try {
        const { message, sessionId = 'default' } = data;
        if (!message || typeof message !== 'string') {
          return { 
            text: '消息不能为空',
            cards: [],
            time: new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'}),
          };
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

        // Real ds-bot Chief only — no ask-bridge / homemade LLM Q&A layer.
        {
          const { chatWithDsBot, BOT_SESSION_ID } = await import('./dsbot-chat.js');
          const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
          const home = config.home || '.odm-data';
          const card = data.cardId ? (store.get()?.cards || []).find(c => c.id === data.cardId) : null;
          const cardContext = data.cardContext || (card ? `卡片「${card.title}」：${card.body || ''} 链接：${card.url || ''}` : null);
          try {
            const result = await chatWithDsBot({
              message,
              cardId: data.cardId || null,
              cardContext,
              home,
              baseUrl: process.env.DSBOT_URL || 'http://127.0.0.1:7788',
              token: process.env.DSBOT_TOKEN,
              log: m => console.log(m),
            });
            session.messages.push({ role: 'user', content: message });
            session.messages.push({ role: 'assistant', content: result.text || '' });
            chatSessions.set(BOT_SESSION_ID, session);
            console.log(`[dsbot] status=${result.status} bot=${result.botId}`);
            return { text: result.text, status: result.status, citations: result.citations || [], cards: result.cards || [], time, sessionId: BOT_SESSION_ID, botId: result.botId };
          } catch (err) {
            console.error('[sendChatMessage] ds-bot:', err);
            return {
              text: `没法连上 ds-bot：${err.message}`,
              status: 'error',
              citations: [],
              cards: [{ type: 'error', title: 'ds-bot 未就绪', description: err.message, actions: [{ label: '重试', value: message }] }],
              time,
            };
          }
        }
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
        const client = getComposioClient();
        if (!client) {
          return { error: 'Composio 未配置' };
        }

        const digest = await generateDailyDigest(client);
        
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
      const cfg = configStore?.get()?.composio || {};
      const client = getComposioClient();
      
      return {
        configured: !!client,
        apiKey: cfg.apiKey ? '***' + cfg.apiKey.slice(-4) : null,
        entityId: cfg.entityId || 'default',
      };
    },

    /**
     * POST /api/composio/config - Update Composio configuration
     */
    async updateComposioConfig(data) {
      try {
        const { apiKey, entityId } = data;

        // Save to config store (flat keys for compatibility)
        await configStore.save({
          composioApiKey: apiKey,
          composioEntityId: entityId || 'default',
        });

        // Rebuild client immediately
        ctx.composioClient = null; // Clear old client
        const client = getComposioClient(); // Build new client

        console.log('[Composio] Config saved, client rebuilt:', !!client);

        return {
          success: true,
          configured: !!client,
        };
      } catch (err) {
        console.error('[Composio] Update config error:', err);
        return { error: err.message };
      }
    },

    /**
     * GET /api/composio/apps - List available apps with connection status
     */
    async getComposioApps() {
      try {
        const client = getComposioClient();
        
        // Return app list even without client
        const apps = COMPOSIO_APPS.map(app => ({
          ...app,
          connected: false,
          connectionId: null,
        }));

        if (!client) {
          return { apps, configured: false };
        }

        // Fetch actual connection status
        try {
          const result = await client.getConnectedAccounts();
          const accounts = result?.items || [];
          const connectedApps = new Map();
          const pendingApps = new Set();
          
          // v3 API response: {items: [...]}, items contain {id, status, toolkit: {slug}, ...}
          accounts.forEach(account => {
            // Only count ACTIVE connections, skip INITIATED (pending OAuth)
            if (account.status !== 'ACTIVE' && account.toolkit?.slug && !connectedApps.has(account.toolkit.slug)) {
              pendingApps.add(account.toolkit.slug);
            }
            if (account.status === 'ACTIVE' && account.toolkit?.slug) {
              connectedApps.set(account.toolkit.slug, {
                connectionId: account.id,
                connectedAt: account.createdAt,
              });
            }
          });

          // Match apps by toolkitSlug (calendar->googlecalendar) or key
          apps.forEach(app => {
            const toolkitSlug = app.toolkitSlug || app.key;
            const conn = connectedApps.get(toolkitSlug);
            if (conn) {
              app.connected = true;
              app.connectionId = conn.connectionId;
              app.connectedAt = conn.connectedAt;
            } else if (pendingApps.has(toolkitSlug)) {
              app.pending = true;
            }
          });
        } catch (err) {
          console.error('[Composio] Failed to fetch connections:', err);
        }

        return { apps, configured: true };
      } catch (err) {
        console.error('[Composio] Get apps error:', err);
        return { error: err.message, apps: [] };
      }
    },

    /**
     * POST /api/composio/connect - Initiate OAuth connection for an app
     */
    async connectComposioApp(data) {
      try {
        const client = getComposioClient();
        if (!client) {
          return { error: 'Composio 未配置。请先设置 API Key' };
        }

        const appId = data.appKey || data.appId;
        const app = appId && COMPOSIO_APPS.find(a => a.key === appId || a.id === appId || (appId === 'calendar' && a.key === 'googlecalendar'));
        
        if (!app) {
          return { error: '未知应用' };
        }

        // Initiate connection (returns OAuth redirect URL)
        const callbackUrl = `${config?.baseUrl || 'http://localhost:7777'}/composio-callback`;
        const toolkitSlug = app.toolkitSlug || app.key || appId;
        const result = await client.initiateConnection(toolkitSlug, callbackUrl);

        return {
          success: true,
          redirectUrl: result.redirectUrl,
          connectionId: result.connectionId,
          authConfigId: result.authConfigId,
          appName: app.name,
        };
      } catch (err) {
        console.error('[Composio] Connect app error:', err);
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
      try {
        const client = getComposioClient();
        if (!client) {
          return { error: 'Composio 未配置' };
        }

        const { appId, connectionId } = data;
        
        if (connectionId) {
          await client.deleteConnection(connectionId);
        }

        return {
          success: true,
          appId,
        };
      } catch (err) {
        console.error('[Composio] Disconnect app error:', err);
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
  
  // Set router reference for card tools
  callLLM.router = router;
  
  return router;
}

/**
 * Mount API routes to HTTP server
 */
export function mountApiRoutes(server, router, { extraRoutes = [] } = {}) {
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

    // Routes registered the ds-bot way ({ path, methods, fetch(Request) => Response }), e.g. main's
    // morning-brief panel. Served first so the standalone server exposes the same plugin routes.
    const extra = extraRoutes.find(r => r.path === url.pathname && (!r.methods || r.methods.includes(req.method)));
    if (extra) {
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const request = new Request(url.href, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
        const response = await extra.fetch(request);
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
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
      } else if (url.pathname === '/api/digest/generate' && req.method === 'POST') {
        const data = await router.generateDigestNow();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } else if (url.pathname === '/api/cards' && req.method === 'GET') {
        const data = await router.listCards();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } else if (url.pathname === '/api/cards' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const response = await router.createCard(data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
          }
        });
        return;
      } else if (url.pathname.startsWith('/api/cards/') && req.method === 'POST') {
        const id = url.pathname.split('/api/cards/')[1];
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const response = await router.updateCard(id, data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
          }
        });
        return;
      } else if (url.pathname.startsWith('/api/cards/') && req.method === 'DELETE') {
        const id = url.pathname.split('/api/cards/')[1];
        const data = await router.deleteCard(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } else if (url.pathname.match(/^\/api\/cards\/[^\/]+\/interact$/) && req.method === 'POST') {
        const id = url.pathname.split('/api/cards/')[1].split('/interact')[0];
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const response = await router.trackCardInteraction(id, data.action);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
          }
        });
        return;
      } else if (url.pathname === '/api/sources' && req.method === 'GET') {
        const data = await router.getSources();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } else if (url.pathname === '/api/config/check' && req.method === 'GET') {
        const data = await router.checkConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } else if (url.pathname === '/api/chat/history' && req.method === 'GET') {
        const data = await router.getChatHistory();
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
      } else if (url.pathname === '/composio-callback' && req.method === 'GET') {
        // OAuth callback from Composio
        const status = url.searchParams.get('status');
        const connectedAccountId = url.searchParams.get('connected_account_id');
        const error = url.searchParams.get('error');
        
        const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Composio ${status === 'success' ? '连接成功' : '连接失败'}</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
    .icon { font-size: 48px; margin-bottom: 1rem; }
    h1 { margin: 0 0 0.5rem; font-size: 1.5rem; }
    p { margin: 0 0 1rem; color: #666; }
    .countdown { font-weight: bold; color: #333; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${status === 'success' ? '✅' : '❌'}</div>
    <h1>${status === 'success' ? 'Composio 连接成功！' : 'Composio 连接失败'}</h1>
    <p>${status === 'success' 
      ? `账号已连接 (${connectedAccountId || 'unknown'})`
      : `错误: ${error || '未知错误'}`
    }</p>
    <p class="countdown"><span id="countdown">2</span> 秒后自动关闭窗口...</p>
  </div>
  <script>
    let count = 2;
    const countdownEl = document.getElementById('countdown');
    const timer = setInterval(() => {
      count--;
      countdownEl.textContent = count;
      if (count <= 0) {
        clearInterval(timer);
        window.close();
        // If window.close() doesn't work (e.g. not opened by script), redirect
        setTimeout(() => {
          if (window.opener) {
            window.opener.location.reload();
          }
          window.location.href = '/';
        }, 500);
      }
    }, 1000);
  </script>
</body>
</html>`;
        
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
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
        res.writeHead(200, { 
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        });
        res.end(html);
      } else if (url.pathname === '/composio-callback' && req.method === 'GET') {
        // OAuth callback from Composio - show success page and close popup
        const status = url.searchParams.get('status');
        const connectedAccountId = url.searchParams.get('connected_account_id');
        
        const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>连接${status === 'success' ? '成功' : '失败'}</title>
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, sans-serif; 
      display: flex; 
      align-items: center; 
      justify-content: center; 
      height: 100vh; 
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .card {
      background: white;
      padding: 40px;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      text-align: center;
      max-width: 400px;
    }
    .icon { font-size: 64px; margin-bottom: 20px; }
    .success { color: #10b981; }
    .error { color: #ef4444; }
    h1 { margin: 0 0 12px; font-size: 24px; color: #1f2937; }
    p { margin: 0; color: #6b7280; font-size: 14px; line-height: 1.6; }
    .countdown { margin-top: 20px; font-size: 12px; color: #9ca3af; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon ${status === 'success' ? 'success' : 'error'}">
      ${status === 'success' ? '✓' : '✕'}
    </div>
    <h1>${status === 'success' ? '连接成功！' : '连接失败'}</h1>
    <p>${status === 'success' 
      ? '数据源已成功连接，窗口将自动关闭。' 
      : '连接过程中出现错误，请重试。'}</p>
    ${connectedAccountId ? `<p style="margin-top:12px;font-family:monospace;font-size:11px;color:#d1d5db;">ID: ${connectedAccountId}</p>` : ''}
    <div class="countdown">窗口将在 <span id="timer">2</span> 秒后关闭</div>
  </div>
  <script>
    let seconds = 2;
    const timer = document.getElementById('timer');
    const interval = setInterval(() => {
      seconds--;
      timer.textContent = seconds;
      if (seconds <= 0) {
        clearInterval(interval);
        window.close();
        // If window.close() is blocked, redirect back
        setTimeout(() => {
          if (!window.closed) {
            window.location.href = '/#/settings';
          }
        }, 100);
      }
    }, 1000);
  </script>
</body>
</html>`;
        res.writeHead(200, { 
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
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
