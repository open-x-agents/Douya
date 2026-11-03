#!/usr/bin/env node
/**
 * Probe script to test digest generation pipeline
 * Run: node scripts/probe-digest.js
 * 
 * Requires .odm-data/config.json with Composio and LLM config
 */

import { readFile } from 'node:fs/promises';
import { createComposioClient } from '../src/web/composio.js';
import { runAggregationPipeline } from '../src/web/aggregation.js';

async function main() {
  console.log('=== Digest Pipeline Probe ===\n');
  
  // Load config
  const configPath = '.odm-data/config.json';
  let config;
  try {
    const data = await readFile(configPath, 'utf-8');
    config = JSON.parse(data);
  } catch (err) {
    console.error(`Error: Could not load ${configPath}`);
    console.error('Make sure Composio and LLM are configured via the web UI first');
    process.exit(1);
  }
  
  // Check Composio config
  if (!config.composioApiKey) {
    console.error('Error: composioApiKey not found in config');
    process.exit(1);
  }
  
  // Check LLM config
  if (!config.llm?.apiKey || !config.llm?.provider) {
    console.error('Error: LLM not configured in config');
    process.exit(1);
  }
  
  console.log('✓ Config loaded');
  console.log(`  - Composio entity: ${config.composioEntityId || 'default'}`);
  console.log(`  - LLM: ${config.llm.provider} / ${config.llm.model}\n`);
  
  // Create Composio client
  const composioClient = createComposioClient({
    composioApiKey: config.composioApiKey,
    composioEntityId: config.composioEntityId || 'default',
  });
  
  // Get connected accounts
  console.log('Fetching connected accounts...');
  const result = await composioClient.getConnectedAccounts();
  const accounts = result?.items || [];
  const activeAccounts = accounts.filter(acc => acc.status === 'ACTIVE' && acc.toolkit?.slug);
  
  if (activeAccounts.length === 0) {
    console.error('Error: No active Composio accounts connected');
    console.error('Connect GitHub, Gmail, or Calendar via the web UI first');
    process.exit(1);
  }
  
  console.log(`✓ Found ${activeAccounts.length} active source(s):`);
  activeAccounts.forEach(acc => {
    console.log(`  - ${acc.toolkit.slug} (${acc.id})`);
  });
  console.log('');
  
  // Create LLM client
  console.log('Creating LLM client...');
  const { createLLMClient } = await import('../src/web/llm-client.js');
  const llm = createLLMClient({
    provider: config.llm.provider,
    baseURL: config.llm.baseURL,
    apiKey: config.llm.apiKey,
    model: config.llm.model,
    log: console.log,
  });
  console.log('✓ LLM client ready\n');
  
  // Run aggregation pipeline
  console.log('=== Running Aggregation Pipeline ===\n');
  
  try {
    const brief = await runAggregationPipeline(composioClient, activeAccounts, llm, {
      name: 'TestUser',
      favoriteRepos: [],
      frequentContacts: [],
      typicalActiveHours: [],
      recentTopics: [],
    });
    
    console.log('\n=== Pipeline Complete ===');
    console.log(`Summary: ${brief.summary || '(none)'}`);
    console.log(`Total cards: ${brief.cards.length}`);
    console.log('');
    
    // Show card breakdown
    const cardsByType = {};
    brief.cards.forEach(card => {
      const type = card.type || 'unknown';
      cardsByType[type] = (cardsByType[type] || 0) + 1;
    });
    
    console.log('Cards by type:');
    Object.entries(cardsByType).forEach(([type, count]) => {
      console.log(`  - ${type}: ${count}`);
    });
    console.log('');
    
    // Show first 5 cards
    console.log('First 5 cards:');
    brief.cards.slice(0, 5).forEach((card, i) => {
      console.log(`  ${i + 1}. [${card.type}] ${card.title}`);
      console.log(`     sourceId: ${card.sourceId}`);
      console.log(`     size: ${card.size || 'normal'}, priority: ${card.priority || 'none'}`);
    });
    
  } catch (err) {
    console.error('\n=== Pipeline Error ===');
    console.error(err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
