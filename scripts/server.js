#!/usr/bin/env node
/**
 * Standalone server for Open Digital Mate web interface
 * Run with: node scripts/server.js [port]
 */

import { createServer } from 'node:http';
import { createRuntime } from '../index.js';
import { mountApiRoutes } from '../src/host/api.js';
import { createLLMClient, PROVIDERS } from '../src/host/llm-client.js';

const PORT = process.env.PORT || process.argv[2] || 7777;

// Create runtime with minimal config
const config = {
  home: process.env.ODM_HOME || './.odm-data',
  composioApiKey: process.env.COMPOSIO_API_KEY,
  composioEntityId: process.env.COMPOSIO_ENTITY_ID,
  digestSchedule: process.env.DIGEST_SCHEDULE || '08:00',
  enableDigest: process.env.ENABLE_DIGEST !== 'false',
  log: msg => console.log(`[ODM] ${msg}`),
};

console.log('🚀 Starting Open Digital Mate server...');
console.log(`📁 Data directory: ${config.home}`);
console.log(`🔑 Composio configured: ${config.composioApiKey ? 'Yes' : 'No'}`);

const runtime = createRuntime(null, config);

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

// Mount API routes
mountApiRoutes(server, runtime.apiRouter);

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
