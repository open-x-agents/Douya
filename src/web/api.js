/**
 * API routes for the web interface
 */

import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDailyDigest, getSourcesStatus, pushDailyDigest, createComposioClient } from './composio.js';
import { reminderCard } from '../host/cards.js';
import { createProfileManager } from './profile.js';
import { computeAutoLayout } from '../ui/layout.js';
/** Stable key for a dock reply: whitespace-collapsed first 160 chars. */
export const dockKey = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
import { createActionService, ACTIONS } from './actions.js';
import { cardSnapshotText, cardFull } from './card-snapshot.js';
import { createUiService } from '../ui/service.js';
import { createChatDisplay, attachmentMeta } from './chat-display.js';
import { callbackUrlFor, callbackPage } from './composio-callback.js';
import { prepareCardActions, pickNextThing, daySummaryLine, tomorrowMorning } from './card-prep.js';
import { hydrateFace, autoFace } from '../ui/face.js';
import { isAfterHours, isWorkish, doneToday, greetingLine, shHour } from './day-pulse.js';
import { sweepClearedCards, applyClearance, cardClearance, completeClearedCard } from './card-clearance.js';
import { findTimetableCard, readPlan, applyPlanEdit, todaysCalendarEvents } from './timetable-plan.js';
import { uiView } from '../ui/ops.js';
import { createSurfaceService } from '../ui/surfaces.js';
import { resolveDisplayName, lastGithubIdentity } from './aggregation.js';
import { recordCompletion, setItemStatus, clearItemStatus, annotateCards, cardItemUrls } from '../host/store.js'

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
  // ds-bot Chief runs on the dsh profile's model; in dsh mode ctx.ctx is an inject-only proxy that throws on
  // unknown property reads, so never let a status check crash on it.
  function hasHostLlm() {
    try { return !!(llmCtx && llmCtx.llm && llmCtx.llm.stream) } catch { return false }
  }

  let lastChatCard = null; // { cardId, at } — the card whose zoom chat spoke last

  // ---- Source status cache: the 信源状态 page must paint at once. One Composio call lists every connected
  // account; keep the last answer in memory and on disk, refresh it with a hard timeout, never block forever.
  const SOURCES_TTL_MS = 30_000;
  const SOURCES_TIMEOUT_MS = Number(process.env.ODM_SOURCES_TIMEOUT_MS) || 6000;
  const sourcesCachePath = join(config?.home || config?.dataDir || './.odm-data', 'sources-cache.json');
  let sourcesCache = null; // { at, items, error, ms }
  try { sourcesCache = JSON.parse(readFileSync(sourcesCachePath, 'utf8')) } catch {}
  let sourcesInflight = null;
  function refreshAccounts(client) {
    if (sourcesInflight) return sourcesInflight;
    const t0 = Date.now();
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Composio 超过 ${Math.round(SOURCES_TIMEOUT_MS / 1000)} 秒没响应`)), SOURCES_TIMEOUT_MS) });
    sourcesInflight = Promise.race([client.getConnectedAccounts(), timeout])
      .then(r => {
        sourcesCache = { at: new Date().toISOString(), items: r?.items || [], error: null, ms: Date.now() - t0 };
        try { writeFileSync(sourcesCachePath, JSON.stringify(sourcesCache)) } catch {}
        return sourcesCache;
      })
      .catch(err => {
        sourcesCache = { ...(sourcesCache || { items: null, at: null }), error: err.message, failedAt: new Date().toISOString(), ms: Date.now() - t0 };
        return sourcesCache;
      })
      .finally(() => { clearTimeout(timer); sourcesInflight = null });
    return sourcesInflight;
  }
  /** Returns { items|null, at, error, stale, cached }. fresh=true waits (≤ timeout) for a live answer. */
  async function connectedAccounts({ fresh = false } = {}) {
    const client = getComposioClient();
    if (!client) return { items: [], at: null, error: null, stale: false, cached: false };
    const age = sourcesCache?.at ? Date.now() - Date.parse(sourcesCache.at) : Infinity;
    if (!fresh && sourcesCache?.items && age < SOURCES_TTL_MS && !sourcesCache.error) return { ...sourcesCache, stale: false, cached: true };
    if (!fresh && sourcesCache?.items) { refreshAccounts(client); return { ...sourcesCache, stale: true, cached: true } }
    const r = await refreshAccounts(client);
    return { ...r, stale: !!r.error, cached: false };
  }

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


  // Composio write actions: reversible run now, outgoing ones wait for the user's 确认执行.
  const actionService = createActionService({ store, getClient: () => getComposioClient(), log: m => console.log(m) });

  // 豆芽 Intelligent UI P1: declarative view ops (open / highlight / filter / arrange / navigate) + 当前视图.
  const uiService = createUiService({ store, log: m => console.log(m) });
  const chatDisplay = createChatDisplay({ home: config.home || '.odm-data' });
  // P2: temporary views Chief generates (odm_ui_render / odm_ui_update). Form drafts only become pending actions.
  const surfaceService = createSurfaceService({ store, actions: ACTIONS, requestAction: (n, input, o) => actionService.request(n, input, o), emit: e => uiService.emit(e), log: m => console.log(m) });

  let botDigest = null; // bot digest runner (src/digest/runner.js), set by index.js in the dsh host
  const router = {
    /** View op from the bot (odm_ui_op) or the owner's browser (撤销 / 固定). Validated against the store. */
    uiServiceRef() { return uiService; },
    /** Dock replies → the views shown under them, so /api/chat/history can bring them back after a reload. */
    async recordDockSurfaces(text, ids) {
      const key = dockKey(text); const list = (ids || []).filter(id => /^sf_\w{1,40}$/.test(id)).slice(0, 3);
      if (!key || !list.length) return { ok: false };
      const prev = (store.get().dockSurfaces || []).filter(r => r.key !== key);
      await store.save({ dockSurfaces: [...prev, { key, ids: list, at: new Date().toISOString() }].slice(-40) });
      return { ok: true };
    },
    dockSurfacesFor(messages) {
      const recs = new Map((store.get().dockSurfaces || []).map(r => [r.key, r.ids]));
      if (!recs.size) return messages;
      return messages.map(m => {
        if (m.role !== 'assistant') return m;
        const ids = recs.get(dockKey(m.content)); if (!ids) return m;
        const views = ids.map(id => { try { return surfaceService.get(id)?.view || null; } catch { return null; } }).filter(Boolean);
        return views.length ? { ...m, surfaces: views } : m;
      });
    },
    async uiOp(body = {}, { by = 'bot' } = {}) { return uiService.op(body, { by: by === 'user' ? 'user' : 'bot' }); },
    /** Long-poll for view events: { since, boot, wait }. */
    async uiEvents({ since = 0, boot = null, wait = 25000 } = {}) { return uiService.poll({ since: Number(since) || 0, boot, waitMs: Math.min(Number(wait) || 0, 30000) }); },
    /** The browser reports what it shows (debounced); kept in memory for odm_ui_state. */
    setViewContext(view) { return uiService.setView(view); },
    /** 【当前视图】 text for a chat turn (also records the view). */
    viewSnapshot(view) { return uiService.viewText(view); },
    /** Full view for odm_ui_state. */
    uiState() { return uiService.state(); },
    chatDisplay() { return chatDisplay; },
    /** Composio OAuth popup landing: read the account back (≤4 s), refresh 信源 status, render the page. */
    async composioCallback({ status = '', connectedAccountId = '', error = '' } = {}) {
      let accountStatus = null, toolkit = '';
      const client = getComposioClient();
      if (client && connectedAccountId && /^[\w-]{3,80}$/.test(connectedAccountId) && client.getConnectedAccount) {
        try {
          const acct = await Promise.race([client.getConnectedAccount(connectedAccountId), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
          accountStatus = acct?.status || null; toolkit = acct?.toolkit?.slug || '';
        } catch (err) { console.warn('[composio-callback] verify failed:', err.message); }
      }
      if (client) refreshAccounts(client);
      console.log(`[composio-callback] status=${status} account=${connectedAccountId || '-'} toolkit=${toolkit || '-'} verified=${accountStatus || '-'}`);
      return { html: callbackPage({ status, connectedAccountId, error, toolkit, accountStatus }), accountStatus, toolkit };
    },
    /** 我的一天: Chief reads / edits the suggested blocks; persisted on the timetable card, pushed live to open tabs. */
    timetableGet() {
      const card = findTimetableCard(store.get().cards || []);
      return card ? { success: true, ...readPlan(card) } : { success: false, error: '没有「我的一天」卡片（先刷新今日生成一次）' };
    },
    async timetableApply(edit = {}, { by = 'chief' } = {}) {
      const state = store.get();
      const cards = state.cards || [];
      const card = findTimetableCard(cards);
      const res = applyPlanEdit(card, edit, { by });
      if (!res.ok) return { success: false, errors: res.errors, ...(card ? { current: readPlan(card) } : {}) };
      const saved = { ...res.card, updatedAt: new Date().toISOString() };
      await store.save({ cards: [saved] });
      const message = res.reset ? '豆芽：今天的时间表会在下次汇聚时重新生成' : '豆芽更新了「我的一天」';
      uiService.emit({ kind: 'cards', reason: 'timetable', cardId: card.id, message });
      console.log(`[timetable] ${by} ${edit.mode || (edit.ops ? 'patch' : 'replace')} → ${res.plan.blocks.length} blocks, next=${res.plan.next ? res.plan.next.start + ' ' + res.plan.next.title : '-'}`);
      return { success: true, changed: res.changed, reset: !!res.reset, warnings: res.warnings, plan: res.plan, message };
    },
    uiBootId() { return uiService.bootId; },
    /** Bot: generate a temporary view (validated + hydrated from the store). */
    async uiRender(input = {}, opts = {}) { return surfaceService.render(input, opts); },
    /** Bot: patch a view's dataModel. */
    async uiUpdate(input = {}) { return surfaceService.update(input); },
    /** Views the bot created since ms (attached to the chat reply's `cards`). */
    surfacesSince(ms) { return surfaceService.since(ms); },
    /** Owner's browser: get / save (保存为卡片) / submit a form. */
    async surfaceOp({ op = 'get', id, component, values } = {}) {
      if (op === 'get') return surfaceService.get(id);
      if (op === 'save') return surfaceService.saveAsCard(id);
      if (op === 'submit') return surfaceService.submit({ surfaceId: id, component, values });
      return { success: false, error: `unknown op ${op}` };
    },

    /**
     * Owner's browser: run one of a card's prepared steps. The step is recomputed from the card's current data
     * (the client only names it), so targets can't be forged. act → a PENDING action held for 确认执行;
     * snooze → hidden until tomorrow 09:00. 'ask' steps go through the chat, not here.
     */
    async cardPrepRun({ cardId, prepId } = {}) {
      const state = store.get();
      const card = (state.cards || []).find(c => c.id === cardId);
      if (!card) return { success: false, error: '这张卡已经不在了' };
      if (prepId === 'unsnooze') { await router.updateCard(card.id, { status: 'active', snoozeUntil: null }); return { success: true, kind: 'unsnooze' }; }
      const step = prepareCardActions(card, { itemStatus: state.itemStatus || {}, max: 4 }).find(p => p.id === prepId);
      if (!step) return { success: false, error: '这一步已经过时了，刷新一下' };
      if (step.kind === 'snooze') {
        const until = tomorrowMorning();
        await router.updateCard(card.id, { status: 'snoozed', snoozeUntil: until });
        return { success: true, kind: 'snooze', until };
      }
      if (step.kind !== 'act') return { success: false, error: '这一步要在对话里交给豆芽' };
      const r = await actionService.request(step.action, step.input, { cardId: card.id, hold: true, prepId: step.id });
      if (!r.success) return { success: false, error: r.error || '没能准备好这个操作' };
      const listed = await actionService.userOp({ op: 'list' });
      return { success: true, kind: 'act', action: (listed.actions || []).find(a => a.id === r.actionId) || null };
    },
    /** Bot-side: request an action (never confirms an outgoing one). */
    async requestAction(action, input = {}, opts = {}) { return actionService.request(action, input, opts); },
    /** User-side: list / confirm / cancel / undo (HTTP route only, behind owner auth). */
    async actionsOp(body = {}) { return actionService.userOp(body); },

    /**
     * GET /api/today - Get today's summary and tasks
     */
    /** 今天 time-of-day order (P4): frozen per day + period; `hour` is a test override that is never stored. */
    async autoLayout(cards, { hour = null } = {}) {
      const state = store.get();
      const enabled = state.prefs?.autoLayout !== 'off';
      const a = profileManager.affinity();
      const profile = { preferences: { activeHours: a.activeHours, cardInteractions: a.cardInteractions }, stats: { totalInteractions: a.totalInteractions } };
      const override = Number.isInteger(hour) && hour >= 0 && hour <= 23;
      const auto = computeAutoLayout(cards, { profile, itemStatus: state.itemStatus, prev: state.uiAuto || null, enabled, hour: override ? hour : null });
      if (enabled && !override && !auto.kept && auto.order.length) {
        await store.save({ uiAuto: { key: auto.key, order: auto.order, reasons: auto.reasons, computedAt: auto.computedAt } });
      }
      return { ...auto, override };
    },
    async setAutoLayout({ enabled } = {}) {
      const state = store.get();
      await store.save({ prefs: { ...(state.prefs || {}), autoLayout: enabled === false || enabled === 'off' ? 'off' : 'on' } });
      return { success: true, enabled: store.get().prefs.autoLayout !== 'off' };
    },

    async getToday({ hour = null } = {}) {
      try {
        const today = new Date().toLocaleDateString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          weekday: 'long',
        });

        // Wake snoozed cards whose time has come (明天再看 / odm_card_snooze).
        {
          const st0 = store.get();
          const due = (st0.cards || []).filter(c => c.status === 'snoozed' && (c.snoozeUntil || c.snoozedUntil) && new Date(c.snoozeUntil || c.snoozedUntil).getTime() <= Date.now());
          if (due.length) {
            for (const c of due) { c.status = 'active'; c.wokeAt = new Date().toISOString(); delete c.snoozeUntil; delete c.snoozedUntil; }
            await store.save({ cards: st0.cards });
          }
        }
        // Get cards from store
        const state = store.get();
        // All items done → card done (face already says 都处理完了). Survives until genuinely new items reopen it.
        {
          const cleared = sweepClearedCards(state, { by: 'system' });
          if (cleared.length) await store.save(state);
        }
        const cards = state.cards || [];
        
        // Filter active cards (not done/deleted/snoozed)
        const activeCards = cards.filter(c => c.status === 'active' || !c.status);
        
        // Count meetings (event-type cards)
        // Meetings = today's real calendar events (the timetable's fixed blocks), else legacy event cards.
        const calToday = todaysCalendarEvents(findTimetableCard(state.cards || []));
        const eventCards = activeCards.filter(c => c.type === 'event');
        const meetings = calToday.length ? calToday : eventCards;
        const meetingHours = calToday.length
          ? calToday.reduce((sum, b) => sum + Math.max(0, (new Date(b.end) - new Date(b.start)) / 3600000 || 0), 0)
          : eventCards.reduce((sum, m) => {
            // Extract duration if available in body or default to 1h
            const match = m.body?.match(/(\d+(\.\d+)?)\s*(h|小时|hour)/i);
            return sum + (match ? parseFloat(match[1]) : 1);
          }, 0);
        
        // Work items = everything except system tiles (hero / timetable), so the
        // header count always matches the cards rendered in the grid.
        const SYSTEM_TYPES = new Set(['hero', 'timetable']);
        const actionable = activeCards.filter(c => !SYSTEM_TYPES.has(c.type) && c.source !== 'system' && c.type !== 'event' && c.type !== 'view');
        const urgent = actionable.filter(c => c.priority === 'urgent' || c.priority === 'high');
        
        // Source line: the live ACTIVE connected accounts (信源状态's cache, never blocks long); cards only as a fallback.
        let accts = null;
        try { const r = await connectedAccounts(); accts = Array.isArray(r?.items) ? r.items : null; } catch { accts = null; }
        const sourcesText = todaySourcesText(accts, activeCards);

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

        // Day pulse (Phase C): time-aware, all from live data.
        const hourNow = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : shHour();
        const afterHours = isAfterHours({ hour: Number.isInteger(hour) ? hourNow : null });
        const nextThing = pickNextThing({ cards: activeCards, itemStatus: state.itemStatus || {} });
        const doneNow = doneToday({ completions: state.completions || [], itemStatus: state.itemStatus || {}, pendingActions: state.pendingActions || {} });
        const meetingsLeft = calToday.filter(b => Date.parse(b.end) > Date.now()).length;
        return {
          afterHours,
          doneToday: doneNow || null,
          doneIds: doneNow ? doneNow.cardIds : [],
          greetingLine: greetingLine({ hour: hourNow, cards: activeCards, next: nextThing, meetingsLeft, done: doneNow }),
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
          cards: annotateCards(activeCards, state.itemStatus).map(c => {
            if (c.type === 'view') return { ...c, view: surfaceService.cardView(c) };
            const cleared = applyClearance(c, state.itemStatus || {});
            const prepared = cleared.clearance === 'waiting' || cleared.clearance === 'cleared' ? [] : prepareCardActions(cleared, { itemStatus: state.itemStatus || {} });
            const faceView = hydrateFace(cleared, cleared.face || autoFace(cleared), { itemStatus: state.itemStatus || {}, events: calToday }) || (cleared.face ? hydrateFace(cleared, autoFace(cleared), { itemStatus: state.itemStatus || {}, events: calToday }) : null);
            return { ...cleared, workish: isWorkish(cleared), prepared, faceView };
          }),
          next: nextThing,
          summaryLine: daySummaryLine({ cards: activeCards, itemStatus: state.itemStatus || {}, meetings: meetings.length }),
          ui: { ...uiView(state), bootId: uiService.bootId, seq: uiService.seq },
          autoLayout: await router.autoLayout(activeCards, { hour }),
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
    /** Bot digest wiring (set from index.js where the dsh ctx exists). */
    composio() { return getComposioClient(); },
    profileContext() { const p = profileManager.getPersonalizationContext() || {}; return { ...p, name: p.name || identityCache.value?.name || '你' }; },
    setBotDigest(runner) { botDigest = runner || null; return !!botDigest; },
    botDigestRef() { return botDigest; },
    digestMode() { const m = store.get()?.prefs?.digestMode; return m === 'legacy' ? 'legacy' : 'bot'; },
    async setDigestMode({ mode } = {}) {
      const state = store.get();
      await store.save({ prefs: { ...(state.prefs || {}), digestMode: mode === 'legacy' ? 'legacy' : 'bot' } });
      return { success: true, mode: router.digestMode(), botAvailable: !!botDigest };
    },
    digestStatus() {
      const runner = botDigest;
      return { success: true, mode: router.digestMode(), botAvailable: !!runner, running: !!runner?.running, live: runner?.live?.() || null, last: router.digestRuns()[0] || null, prefs: runner?.store?.get().prefs || [] };
    },
    /** Run the legacy pipeline as a dry run on the last bot run's exact source data and compare. Writes nothing. */
    async compareDigest() {
      const last = botDigest?.lastRun?.();
      if (!last) return { success: false, error: 'no bot run yet' };
      const { digestMetrics } = await import('../digest/compare.js');
      // Real links that are not in this run's fetch but already on stored cards (folded-in older mail) count as valid.
      const stored = new Set((store.get()?.cards || []).flatMap(c => (c.blocks || []).flatMap(b => (b.links || []).map(l => l?.url))).filter(Boolean));
      const valid = new Set([...last.validUrls, ...stored]);
      const t0 = Date.now();
      const legacy = await router.generateLegacyDigest({ dryRun: true, sourceData: last.sourceData });
      const legacyMs = Date.now() - t0;
      if (!legacy.success) return { success: false, error: legacy.error };
      const run = router.digestRuns()[0] || null;
      return { success: true, bot: { ...digestMetrics(last.cards, valid), ms: run?.ms, tokens: run?.tokens }, legacy: { ...digestMetrics(legacy.cards, valid), ms: legacyMs, llmChars: legacy.llmChars || null } };
    },
    digestRuns() { try { return botDigest?.store?.get().runs || []; } catch { return []; } },
    /**
     * The one save path for any digest (legacy or bot): learn, refresh identity, fold legacy email tiles,
     * store.save({digest:true}) = update-or-add by sourceId, done/dismissed never overwritten, itemStatus kept.
     */
    async commitDigestCards(cards, { summary = '', sources = [], mode = 'legacy', seen = null, channels = null } = {}) {
      const client = getComposioClient();
      const state = store.get();
      await profileManager.learnFromCards(cards);
      try {
        const { fetchIdentityFromSources } = await import('./identity.js');
        const id = client && await fetchIdentityFromSources(client, { home: config.home || '.odm-data', log: console.log });
        if (id) identityCache.value = id;
        const pctx = profileManager.getPersonalizationContext();
        if (pctx.name) await profileManager.save({ name: '' });
      } catch (e) { console.warn('[Identity] digest refresh failed:', e.message); }
      state.lastDigest = { summary, generatedAt: new Date().toISOString(), itemCount: cards.length, sources, mode };
      const { migrateEmailCards } = await import('./email-groups.js');
      const mig = migrateEmailCards(state.cards || [], cards, state.itemStatus || {});
      if (mig.merged) console.log(`[generateDigest] merged ${mig.merged} legacy email tiles into category groups`);
      await store.save({ ...state, itemStatus: mig.itemStatus, cards: mig.cards }, { digest: true, seen, channels });
      const finalState = store.get();
      const { duplicateCount } = await import('../host/reconcile.js');
      const active = finalState.cards.filter(c => c.status === 'active' || !c.status);
      const rec = finalState.lastReconcile || {};
      const reconcile = { created: rec.created, updated: rec.updated, reopened: rec.reopened, keptDone: rec.keptDone, archived: rec.archived, merged: rec.merged, fuzzy: rec.fuzzy, hintUsed: rec.hintUsed, newBecameUpdate: rec.newBecameUpdate, createdKeys: (rec.createdKeys || []).slice(0, 20), active: active.length, duplicates: duplicateCount(finalState.cards) };
      console.log(`[generateDigest] reconcile ${JSON.stringify(reconcile)}`);
      return { success: true, summary, totalCardCount: finalState.cards.length, timestamp: state.lastDigest.generatedAt, mode, reconcile };
    },

    async generateDigestNow({ mode = null } = {}) {
      const want = mode || router.digestMode();
      if (want === 'bot' && botDigest && getComposioClient()) {
        const r = await botDigest.run();
        if (r.status === 'done') return { ...r.result.saved, mode: 'bot', bot: botDigest.summarize(r) };
        console.warn(`[generateDigest] bot digest failed (${r.error}); falling back to the legacy pipeline`);
        const legacy = await router.generateLegacyDigest();
        return { ...legacy, mode: 'legacy-fallback', botError: r.error, bot: botDigest.summarize(r) };
      }
      return router.generateLegacyDigest();
    },

    async generateLegacyDigest({ dryRun = false, sourceData = null } = {}) {
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
        // Count model traffic (chars in / out, and usage when the client reports it) for the digest comparison.
        const meter = { calls: 0, inChars: 0, outChars: 0, usage: { input: 0, output: 0 } };
        const metered = Object.create(llm);
        metered.stream = async function* (req) {
          meter.calls++; meter.inChars += JSON.stringify(req?.messages || []).length;
          for await (const ch of llm.stream(req)) {
            if (ch?.type === 'text' && ch.text) meter.outChars += ch.text.length;
            const u = ch?.usage; if (u) { meter.usage.input += Number(u.inputTokens ?? u.prompt_tokens ?? 0) || 0; meter.usage.output += Number(u.outputTokens ?? u.completion_tokens ?? 0) || 0; }
            yield ch;
          }
        };
        const brief = await runAggregationPipeline(client, activeAccounts, metered, profileContext, { sourceData });
        if (dryRun) return { success: true, dryRun: true, cards: brief.cards, summary: brief.summary, llmChars: meter };
        return await router.commitDigestCards(brief.cards, { summary: brief.summary, sources: activeAccounts.map(a => a.toolkit.slug), mode: 'legacy' });
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
        
        return { cards: annotateCards(sorted, state.itemStatus) };
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
        const { source, type, title, body, url, priority, status, nextAction, links, snoozeUntil, sourceId } = data;
        
        if (!title) {
          return { success: false, error: '标题不能为空' };
        }
        
        const now = new Date().toISOString();
        const card = {
          id: `card_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          source: source || 'manual',
          sourceId: sourceId || null,
          type: type || 'info',
          title,
          body: body || '',
          url: url || null,
          priority: priority || 'medium',
          status: status || 'active',
          nextAction: nextAction || null,
          links: Array.isArray(links) ? links : null,
          snoozeUntil: snoozeUntil || null,
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
        const by = updates.completedBy || updates.dismissedBy || 'user';
        if (updates.status === 'done' && card.status !== 'done') {
          updated.completedAt = updated.completedAt || new Date().toISOString();
          updated.completedBy = by;
          state.completions = recordCompletion(state.completions, updated, { action: 'done', by });
        }
        if (updates.status === 'dismissed' && card.status !== 'dismissed') {
          updated.dismissedAt = updated.dismissedAt || new Date().toISOString();
          updated.dismissedBy = by;
          state.completions = recordCompletion(state.completions, updated, { action: 'dismissed', by });
        }
        
        cards[index] = updated;
        await store.save(state);
        
        console.log('[updateCard] Updated:', id, updated.title, updated.status);
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
    // Per-card zoom chat transcript (keyed by a stable card key such as repo or group), so
    // reopening a card shows its conversation. Capped; survives digests and restarts.
    async cardChat({ op = 'get', key, messages = [] } = {}) {
      key = String(key || '').slice(0, 200);
      if (!key) return { success: false, error: 'missing key' };
      const state = store.get();
      const all = { ...(state.cardChats || {}) };
      if (op === 'append') {
        const add = (Array.isArray(messages) ? messages : []).slice(0, 10)
          .map(m => (m && m.role === 'user' && Array.isArray(m.attachments) ? { ...m, attachments: m.attachments.slice(0, 8).map(a => attachmentMeta(a, a?.kind === 'image' && /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(String(a?.ref || '')) ? a.ref : null)) } : m))
          .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && (m.text.trim() || m.attachments?.length))
          .map(m => ({ role: m.role, text: m.text.slice(0, 8000), at: new Date().toISOString(), ...(m.attachments?.length ? { attachments: m.attachments } : {}), ...(Array.isArray(m.surfaces) && m.surfaces.length ? { surfaces: m.surfaces.filter(x => typeof x === 'string' && /^sf_\w{1,40}$/.test(x)).slice(0, 3) } : {}) }));
        all[key] = [...(all[key] || []), ...add].slice(-40);
        const keys = Object.keys(all);
        if (keys.length > 200) for (const k of keys.sort((a, b) => String(all[a].at(-1)?.at).localeCompare(String(all[b].at(-1)?.at))).slice(0, keys.length - 200)) delete all[k];
        await store.save({ ...state, cardChats: all });
      } else if (op === 'clear') {
        delete all[key];
        await store.save({ ...state, cardChats: all });
      }
      return { success: true, key, messages: all[key] || [] };
    },

    async trackCardInteraction(id, action, itemUrl = null, itemTitle = '', by = 'user') {
      try {
        const state = store.get();
        const cards = state.cards || [];
        const card = cards.find(c => c.id === id);
        
        if (!card) {
          return { success: false, error: '卡片不存在' };
        }

        // Batch: 一键全部忽略 / 全部完成 for the open items of a group card (itemUrl = [{url,title}]).
        if (Array.isArray(itemUrl)) {
          const urls = cardItemUrls(card);
          const status = action === 'done-all' || action === 'done' ? 'done' : 'dismissed';
          let n = 0;
          for (const it of itemUrl.slice(0, 200)) {
            const u = typeof it === 'string' ? it : it?.url;
            if (!u || !urls.has(u) || state.itemStatus?.[u]) continue;
            setItemStatus(state, { card, url: u, title: (typeof it === 'object' && it.title) || '', action: status, by });
            n++;
          }
          await store.save(state);
          let cardDone = false;
          if (status === 'done' || status === 'dismissed') {
            const clr = cardClearance(card, state.itemStatus || {});
            if (clr.kind === 'cleared' && completeClearedCard(state, card, { by })) {
              cardDone = true;
              await store.save(state);
            }
          }
          const [annotated] = annotateCards([card], state.itemStatus);
          console.log('[trackInteraction] batch', status, n, cardDone ? '→ card done' : '');
          return { success: true, count: n, itemStatus: annotated.itemStatus || {}, cardDone, cardId: card.id };
        }

        // Per-item 完成 / 忽略 / 撤销 — never touches the whole card's status.
        if (itemUrl) {
          if (!cardItemUrls(card).has(itemUrl)) return { success: false, error: '这张卡片里没有这个条目' };
          if (action === 'undo') {
            clearItemStatus(state, itemUrl);
            // Undoing an item on a card we auto-completed brings it back to Today.
            if (card.status === 'done' && card.completedBy && card.completedBy !== 'user-manual') {
              card.status = 'active';
              delete card.completedAt; delete card.completedBy;
              card.updatedAt = new Date().toISOString();
              card.reopenedAt = card.updatedAt;
              card.previousStatus = 'done';
            }
          } else if (action === 'done' || action === 'dismiss' || action === 'dismissed') {
            setItemStatus(state, { card, url: itemUrl, title: itemTitle, action: action === 'done' ? 'done' : 'dismissed', by });
          } else return { success: false, error: `未知操作: ${action}` };
          await store.save(state);
          let cardDone = false;
          if (action === 'done' || action === 'dismiss' || action === 'dismissed') {
            const clr = cardClearance(card, state.itemStatus || {});
            if (clr.kind === 'cleared' && completeClearedCard(state, card, { by })) {
              cardDone = true;
              await store.save(state);
            }
          }
          const [annotated] = annotateCards([card], state.itemStatus);
          console.log('[trackInteraction] item', action, itemUrl, cardDone ? '→ card done' : '');
          return { success: true, item: state.itemStatus[itemUrl] || null, itemStatus: annotated.itemStatus || {}, cardDone, cardId: card.id };
        }
        
        // Track in profile
        await profileManager.trackInteraction(card.sourceId, action);
        
        // Update card status if action implies it — also write durable completions.
        if (action === 'done' && card.status !== 'done') {
          card.status = 'done';
          card.completedAt = new Date().toISOString();
          card.completedBy = 'user';
          card.updatedAt = card.completedAt;
          state.completions = recordCompletion(state.completions, card, { action: 'done', by: 'user' });
          await store.save(state);
        } else if ((action === 'dismiss' || action === 'dismissed') && card.status !== 'dismissed') {
          card.status = 'dismissed';
          card.dismissedAt = new Date().toISOString();
          card.dismissedBy = 'user';
          card.updatedAt = card.dismissedAt;
          state.completions = recordCompletion(state.completions, card, { action: 'dismissed', by: 'user' });
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
     * GET /api/completions — durable done/dismissed ledger (survives digests).
     */
    /** Compact snapshot of a card, read fresh from the store (card-chat turns carry this). */
    cardSnapshot(cardId) {
      const st = store.get() || {};
      const card = (st.cards || []).find(c => c.id === cardId);
      if (!card) return null;
      lastChatCard = { cardId, at: Date.now() };
      return cardSnapshotText(card, st.itemStatus || {}, { actions: st.pendingActions || {} });
    },

    /** Full card for odm_current_card: the given id, else the card most recently chatted about (≤30 min). */
    currentCard({ cardId } = {}) {
      const st = store.get() || {};
      const id = cardId || (lastChatCard && Date.now() - lastChatCard.at < 30 * 60_000 ? lastChatCard.cardId : null);
      if (!id) return { found: false, error: '当前没有打开的卡片对话；用 odm_card_find 找卡片' };
      const card = (st.cards || []).find(c => c.id === id);
      if (!card) return { found: false, error: `找不到卡片 ${id}` };
      return { found: true, card: cardFull(card, st.itemStatus || {}) };
    },

    async listCompletions() {
      const state = store.get();
      return { completions: state.completions || [] };
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

        // Get all connected accounts (cached, timeout-bounded)
        const result = await connectedAccounts();
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
        composioApiKey: !!(configStore?.get()?.composioApiKey || process.env.COMPOSIO_API_KEY),
        composioEntityId: configStore?.get()?.composioEntityId || process.env.COMPOSIO_ENTITY_ID || 'default',
        digestSchedule: configStore?.get()?.digestSchedule || config?.digestSchedule || '08:00',
        llmConfigured: !!configStore?.isLLMConfigured?.() || hasHostLlm(),
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
          display: chatDisplay,
          baseUrl: process.env.DSBOT_URL || 'http://127.0.0.1:7788',
          token: process.env.DSBOT_TOKEN,
        });
        return { sessionId: hist.sessionId || BOT_SESSION_ID, messages: router.dockSurfacesFor(hist.messages || []), botId: hist.botId || null };
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
          let cardContext = (card && router.cardSnapshot(card.id)) || data.cardContext || null;
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
      // configStore saves flat keys (composioApiKey / composioEntityId).
      const cfg = configStore?.get() || {};
      const client = getComposioClient();
      const masked = configStore?.getMaskedKey?.() || null;
      return {
        configured: !!client,
        apiKeyPresent: !!cfg.composioApiKey,
        apiKeyMasked: masked,
        apiKey: masked,
        entityId: cfg.composioEntityId || 'default',
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
        sourcesCache = null; // new key → old connection list is meaningless
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
    async getComposioApps({ fresh = false } = {}) {
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

        // Connection status: cached/last-known at once, live probe with a hard timeout.
        const st = await connectedAccounts({ fresh });
        const status = { checkedAt: st.at, stale: !!st.stale, cached: !!st.cached, error: st.error || null, unknown: !st.items, probeMs: st.ms ?? null };
        try {
          const accounts = st.items || [];
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

        return { apps, configured: true, status };
      } catch (err) {
        console.error('[Composio] Get apps error:', err);
        return { error: err.message, apps: [] };
      }
    },

    /**
     * POST /api/composio/connect - Initiate OAuth connection for an app
     */
    async connectComposioApp(data, { origin = null } = {}) {
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
        // Same origin as the page that asked (host + port the user's browser uses), so the popup can talk back.
        const callbackUrl = callbackUrlFor(origin || config?.baseUrl || null);
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

      // Live-apply for Chief (same dsh process): without DEEPSEEK_API_KEY a fresh DeepSeek setup
      // saves 配置 successfully but every chat returns "No model is available" until restart.
      try {
        const { applyLlmEnv, ensureAgentDefaultModel } = await import('./llm-env.js');
        applyLlmEnv(updates.llm);
        const dshHome = process.env.DSH_HOME || null;
        if (dshHome) ensureAgentDefaultModel(dshHome, updates.llm);
      } catch (err) { console.warn('[llm-config] env apply failed:', err.message); }

      // Rebuild LLM client immediately from saved config (standalone server.js only)
      if (typeof updateLLMClient === 'function') {
        updateLLMClient();
      }

      return {
        success: true,
        masked: configStore.getMaskedLLMKey(),
        applied: { deepseek: !!process.env.DEEPSEEK_API_KEY, openai: !!process.env.OPENAI_API_KEY },
        note: '模型密钥已写入运行环境。若仍然无回复，请重启 npm start 后再试。',
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
      sourcesCache = sourcesCache && { ...sourcesCache, at: null }; // force a live re-check next time
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
        const hq = url.searchParams.get('hour');
        const data = await router.getToday({ hour: hq !== null && /^\d{1,2}$/.test(hq) ? Number(hq) : null });
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
      } else if (url.pathname === '/api/opendigitalmate/card-update' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const response = await router.updateCard(data.id, data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
          }
        });
        return;
      } else if (url.pathname === '/api/opendigitalmate/card-delete' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const response = await router.deleteCard(data.id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
          }
        });
        return;
      } else if (url.pathname === '/api/opendigitalmate/card-interact' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const response = await router.trackCardInteraction(data.id, data.action);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
          }
        });
        return;
      } else if (url.pathname === '/api/opendigitalmate/actions' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const response = await router.actionsOp(JSON.parse(body || '{}'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
          }
        });
        return;
      } else if (url.pathname === '/api/opendigitalmate/layout-pref' && req.method === 'POST') {
        const body = await new Promise(r => { let d = ''; req.on('data', c => { d += c; }); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(await router.setAutoLayout(body)));
      } else if (url.pathname === '/api/opendigitalmate/ui-renderer.js' && req.method === 'GET') {
        const js = await readFile(join(__dirname, '../client/ui-renderer.js'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(js);
      } else if (url.pathname === '/api/opendigitalmate/ui-events' && req.method === 'GET') {
        const data = await router.uiEvents({ since: url.searchParams.get('since'), boot: url.searchParams.get('boot'), wait: url.searchParams.get('wait') ?? 25000 });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      } else if ((url.pathname === '/api/opendigitalmate/ui-op' || url.pathname === '/api/opendigitalmate/ui-context' || url.pathname === '/api/opendigitalmate/surface') && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const response = url.pathname.endsWith('ui-op') ? await router.uiOp(data, { by: 'user' }) : url.pathname.endsWith('surface') ? await router.surfaceOp(data) : router.setViewContext(data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
          }
        });
        return;
      } else if (url.pathname === '/api/opendigitalmate/card-chat' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const response = await router.cardChat(JSON.parse(body || '{}'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
          }
        });
        return;
      } else if (url.pathname === '/api/completions' && req.method === 'GET') {
        const data = await router.listCompletions();
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
      } else if (url.pathname === '/api/composio/apps/refresh') {
        const data = await router.getComposioApps({ fresh: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
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
            const response = await router.connectComposioApp(data, { origin: req.headers.origin || (req.headers.host ? `http://${req.headers.host}` : null) });
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
      } else if ((url.pathname === '/composio-callback' || url.pathname === '/api/opendigitalmate/composio-callback') && req.method === 'GET') {
        const { html } = await router.composioCallback({ status: url.searchParams.get('status') || '', connectedAccountId: url.searchParams.get('connected_account_id') || '', error: url.searchParams.get('error') || '' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
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

const SOURCE_LABEL = { gmail: 'Gmail', github: 'GitHub', slack: 'Slack', googlecalendar: '日历', google_calendar: '日历', notion: 'Notion', linear: 'Linear', outlook: 'Outlook' };
const SOURCE_ORDER = ['gmail', 'github', 'slack', 'googlecalendar'];
/** 今天 header 「来自 …」: connected sources (ACTIVE accounts), else the sources the cards came from. */
export function todaySourcesText(accounts, cards = []) {
  let slugs = Array.isArray(accounts) ? [...new Set(accounts.filter(a => a?.status === 'ACTIVE' && a?.toolkit?.slug).map(a => a.toolkit.slug))] : null;
  if (!slugs || !slugs.length) slugs = [...new Set((cards || []).map(c => c?.source).filter(s => s && SOURCE_LABEL[s]))];
  if (!slugs.length) return '暂无数据';
  const rank = s => { const i = SOURCE_ORDER.indexOf(s === 'google_calendar' ? 'googlecalendar' : s); return i < 0 ? 99 : i; };
  return [...new Set(slugs.sort((a, b) => rank(a) - rank(b)).map(s => SOURCE_LABEL[s] || s))].join('、');
}
