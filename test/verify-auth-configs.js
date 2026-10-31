#!/usr/bin/env node
/**
 * Verify each app gets distinct auth_config matching its toolkit
 * Tests the auth_config lookup/filter fix for Calendar OAuth issue
 */

import { createComposioClient } from '../src/host/composio.js';

const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY;

if (!COMPOSIO_API_KEY) {
  console.error('❌ COMPOSIO_API_KEY not set');
  console.log('Set it with: export COMPOSIO_API_KEY=your_key');
  process.exit(1);
}

const apps = [
  { key: 'github', toolkit: 'github' },
  { key: 'calendar', toolkit: 'googlecalendar' },
  { key: 'gmail', toolkit: 'gmail' },
  { key: 'slack', toolkit: 'slack' },
];

async function test() {
  console.log('🧪 Testing auth_config lookup for each app\n');

  const client = createComposioClient({
    composioApiKey: COMPOSIO_API_KEY,
    composioEntityId: 'test-entity',
  });

  const authConfigs = new Map();

  for (const app of apps) {
    try {
      console.log(`→ Testing ${app.key} (toolkit: ${app.toolkit})...`);
      
      const result = await client.initiateConnection(
        app.toolkit,
        'http://localhost:7777/test'
      );

      const authConfigId = result.authConfigId;
      authConfigs.set(app.key, authConfigId);

      console.log(`  Auth config: ${authConfigId}`);
      console.log(`  Redirect: ${result.redirectUrl.substring(0, 50)}...`);
      
      // Check if this auth_config was reused from another app
      const duplicates = [];
      for (const [otherKey, otherId] of authConfigs.entries()) {
        if (otherKey !== app.key && otherId === authConfigId) {
          duplicates.push(otherKey);
        }
      }
      
      if (duplicates.length > 0) {
        console.log(`  ❌ DUPLICATE! Same as: ${duplicates.join(', ')}`);
      } else {
        console.log(`  ✓ Unique\n`);
      }
    } catch (error) {
      console.error(`  ❌ Error: ${error.message}\n`);
    }
  }

  // Summary
  console.log('📊 Summary:');
  console.log(`Total apps tested: ${apps.length}`);
  console.log(`Unique auth configs: ${new Set(authConfigs.values()).size}`);
  
  const uniqueCount = new Set(authConfigs.values()).size;
  if (uniqueCount === apps.length) {
    console.log('✅ All apps have distinct auth configs!');
  } else {
    console.log(`❌ FAILURE: Expected ${apps.length}, got ${uniqueCount}`);
    console.log('\nAuth config mapping:');
    for (const [key, id] of authConfigs) {
      console.log(`  ${key}: ${id}`);
    }
    process.exit(1);
  }
}

test().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
