#!/usr/bin/env node
/**
 * Standalone server for Open Digital Mate web interface
 * Run with: node scripts/server.js [port]
 */

import { createServer } from 'node:http';
import { createRuntime } from '../index.js';
import { mountApiRoutes } from '../src/host/api.js';

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
