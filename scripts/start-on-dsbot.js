#!/usr/bin/env node
/**
 * Run Douya on ds-bot framework
 * This is the proper way to run the plugin with full ds-bot capabilities
 */

import { Context } from '@deepseek-ai/cordis';
import * as dsBot from './vendor/ds-bot/index.js';
import * as odmPlugin from './index.js';

const PORT = process.env.PORT || 7777;
const DSH_HOME = process.env.DSH_HOME || './.dsh';

console.log('🚀 Starting Douya on ds-bot...');
console.log(`📁 DSH Home: ${DSH_HOME}`);

// Create Cordis context
const ctx = new Context();

// Install ds-bot
ctx.plugin(dsBot, {
  home: DSH_HOME,
});

// Install Douya plugin
ctx.plugin(odmPlugin, {
  home: process.env.ODM_HOME || './.odm-data',
  composioApiKey: process.env.COMPOSIO_API_KEY,
  composioEntityId: process.env.COMPOSIO_ENTITY_ID,
  digestSchedule: process.env.DIGEST_SCHEDULE || '08:00',
  enableDigest: process.env.ENABLE_DIGEST !== 'false',
});

// Start context
ctx.start();

console.log('✅ ds-bot runtime started');
console.log('📊 Douya plugin loaded');
console.log(`🌐 HTTP server should be available at http://localhost:${PORT}`);
console.log('');
console.log('Press Ctrl+C to stop');

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  ctx.dispose();
  process.exit(0);
});

process.on('SIGTERM', () => {
  ctx.dispose();
  process.exit(0);
});
