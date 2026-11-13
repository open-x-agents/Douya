#!/usr/bin/env node
/**
 * Standalone server for Douya web interface
 * Run with: node scripts/server.js [port]
 */

import { createServer } from 'node:http';
import { createRuntime } from '../index.js';
import { mountApiRoutes } from '../src/web/api.js';
import { createLLMClient, PROVIDERS } from '../src/web/llm-client.js';
import { createComposioClient } from '../src/web/composio.js';
import { installPanel } from '../src/host/panel.js';
import { askQuestion, evidenceFromState } from '../src/host/ask.js';

const PORT = process.env.PORT || process.argv[2] || 7777;

// Create runtime with minimal config
const config = {
  home: process.env.ODM_HOME || './.odm-data',
  composioApiKey: process.env.COMPOSIO_API_KEY,
  composioEntityId: process.env.COMPOSIO_ENTITY_ID,
  digestSchedule: process.env.DIGEST_SCHEDULE || '08:00',
  enableDigest: process.env.ENABLE_DIGEST !== 'false',
  // Local zone of this machine (TZ wins), so the panel's day and clocks match the person's day.
  timeZone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  log: msg => console.log(`[ODM] ${msg}`),
};

console.log('🚀 Starting Douya server...');
console.log(`📁 Data directory: ${config.home}`);

const runtime = createRuntime(null, config);
await runtime.store.load();
// The config store loads asynchronously inside createRuntime; wait for it so the saved keys are read.
await runtime.configStore?.load?.().catch(() => {});

// Build Composio client from saved config at startup
const savedConfig = runtime.configStore?.get();
if (savedConfig?.composioApiKey) {
  try {
    runtime.composioClient = createComposioClient({
      composioApiKey: savedConfig.composioApiKey,
      composioEntityId: savedConfig.composioEntityId || 'default',
    });
    console.log('🔑 Composio configured: Yes (from saved config)');
  } catch (err) {
    console.error('⚠️  Failed to build Composio client from config:', err.message);
    console.log('🔑 Composio configured: No');
  }
} else if (config.composioApiKey) {
  console.log('🔑 Composio configured: Yes (from environment)');
} else {
  console.log('🔑 Composio configured: No');
}

// Create mock ctx with LLM client
const ctx = { llm: null };

function updateLLMClient() {
  const llmConfig = runtime.configStore?.get()?.llm;
  if (llmConfig?.apiKey && llmConfig?.provider) {
    console.log(`🤖 Initializing LLM: ${llmConfig.provider} / ${llmConfig.model || 'default'}`);
    ctx.llm = createLLMClient({
      provider: llmConfig.provider,
      baseURL: llmConfig.baseURL || PROVIDERS[llmConfig.provider]?.baseURL,
      apiKey: llmConfig.apiKey,
      model: llmConfig.model || PROVIDERS[llmConfig.provider]?.models[0],
      log: config.log,
    });
  } else {
    ctx.llm = null;
    console.log('⚠️  LLM not configured - chat will use fallback responses');
  }
}

// Initialize LLM on startup
updateLLMClient();

// Update apiRouter with LLM context and update callback
runtime.apiRouter = runtime.createApiRouter?.({
  store: runtime.store,
  composioClient: runtime.composioClient,
  config,
  llmCtx: ctx,
  sendCard: runtime.sendCard,
  configStore: runtime.configStore,
  ctx: runtime,
  updateLLMClient,
}) || runtime.apiRouter;

// Create HTTP server
const server = createServer();

// Plugin routes from main (morning-brief panel JSON + page, evidence-first ask), collected through a
// ds-bot-shaped ctx so the standalone server and the ds-bot plugin serve the same handlers.
const extraRoutes = [];
const routeCtx = { effect: fn => fn(), connection: { fetch: { register: r => { extraRoutes.push(r); return () => {}; } } } };
installPanel(routeCtx, runtime);
extraRoutes.push({
  path: '/api/ask',
  methods: ['POST'],
  fetch: async request => {
    const { text } = await request.json().catch(() => ({}));
    const state = runtime.store.get();
    const base = evidenceFromState(state);
    // Today's cards are evidence too: each card's link is its ref, its body the excerpt.
    const cardSources = (state.cards || []).filter(c => c.url && c.source !== 'system').map(c => ({
      ref: c.url, source: c.source, title: c.title || '', excerpt: String(c.body || c.title || '').slice(0, 400), at: c.updatedAt || '', read_scope: 'card',
    }));
    const result = await askQuestion({ text, sources: [...base.sources, ...cardSources], unread: base.unread });
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  },
});

// Mount API routes
mountApiRoutes(server, runtime.apiRouter, { extraRoutes });

server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`📊 Web UI: http://localhost:${PORT}/`);
  console.log(`🔌 API: http://localhost:${PORT}/api/today`);
  console.log('');
  console.log('Press Ctrl+C to stop');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
