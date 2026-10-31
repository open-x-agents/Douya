/**
 * API routes for the web interface
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDailyDigest, getSourcesStatus } from './composio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Create API router
 */
export function createApiRouter(ctx) {
  const { store, composioClient } = ctx;

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

        const reports = await store.getRecentReports?.(1) || [];
        const reminders = await store.getReminders?.() || [];
        
        // Mock data for now - integrate with actual store
        const tasks = [
          {
            title: '报价单发给张伟',
            reason: '他昨天问了两次，卡着周四签约',
            evidence: '依据：飞书 · 张伟',
            advice: '10:00 前发，先发数字后补附件',
            closed: false,
          },
          {
            title: '评审会材料定稿',
            reason: '会从 14:00 挪到 16:00，多出两小时',
            evidence: '依据：日历改动',
            advice: '13:00 前只留一页结论页',
            closed: false,
          },
        ];

        return {
          summary: `今天 ${reminders.length} 个会，${tasks.length} 件必须今天完成`,
          date: today,
          sources: '飞书、日历、邮件已读',
          openCount: tasks.filter(t => !t.closed).length,
          meetingHours: reminders.length * 1.5, // Estimate
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
        composioApiKey: !!ctx.config?.composioApiKey,
        composioEntityId: ctx.config?.composioEntityId || 'default',
        digestSchedule: ctx.config?.digestSchedule || '08:00',
      };
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
