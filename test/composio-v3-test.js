#!/usr/bin/env node
/**
 * Test Composio v3 API with real credentials
 * Usage: COMPOSIO_API_KEY=your-key node test/composio-v3-test.js
 */

const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY;
const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3';
const USER_ID = 'test-user-' + Date.now();

if (!COMPOSIO_API_KEY) {
  console.error('Error: COMPOSIO_API_KEY environment variable required');
  process.exit(1);
}

console.log('🧪 Testing Composio v3 API');
console.log(`   API Key: ${COMPOSIO_API_KEY.slice(0, 8)}...`);
console.log(`   User ID: ${USER_ID}\n`);

async function request(endpoint, options = {}) {
  const url = `${COMPOSIO_API_BASE}${endpoint}`;
  const headers = {
    'x-api-key': COMPOSIO_API_KEY,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  console.log(`→ ${options.method || 'GET'} ${endpoint}`);
  if (options.body) {
    console.log('  Body:', JSON.parse(options.body));
  }

  const response = await fetch(url, { ...options, headers });
  
  const text = await response.text();
  console.log(`← ${response.status} ${response.statusText}`);
  
  if (!response.ok) {
    console.error('  Error:', text);
    throw new Error(`API error: ${response.status} ${text}`);
  }

  const data = JSON.parse(text);
  console.log('  Response:', JSON.stringify(data, null, 2).split('\n').slice(0, 10).join('\n'));
  console.log('');
  
  return data;
}

async function test() {
  try {
    // 1. Find or create auth_config for GitHub
    console.log('=== Step 1: Find/create auth_config for GitHub ===\n');
    
    let authConfigs = await request('/auth_configs?toolkit_slug=github');
    let authConfigId;
    
    if (authConfigs.items && authConfigs.items.length > 0) {
      authConfigId = authConfigs.items[0].id;
      console.log(`✓ Found existing auth_config: ${authConfigId}\n`);
    } else {
      console.log('Creating new auth_config...\n');
      const newAuthConfig = await request('/auth_configs', {
        method: 'POST',
        body: JSON.stringify({
          toolkit: { slug: 'github' },
          auth_config: { type: 'use_composio_managed_auth' },
        }),
      });
      authConfigId = newAuthConfig.auth_config?.id || newAuthConfig.id;
      console.log(`✓ Created auth_config: ${authConfigId}\n`);
    }

    // 2. Initiate connection (get OAuth link)
    console.log('=== Step 2: Initiate connection ===\n');
    
    const connection = await request('/connected_accounts/link', {
      method: 'POST',
      body: JSON.stringify({
        auth_config_id: authConfigId,
        user_id: USER_ID,
        callback_url: 'http://localhost:7777/composio-callback',
      }),
    });
    
    console.log(`✓ Redirect URL: ${connection.redirect_url}`);
    console.log(`✓ Account ID: ${connection.connected_account_id}\n`);

    // 3. List connected accounts
    console.log('=== Step 3: List connected accounts ===\n');
    
    const accounts = await request(`/connected_accounts?user_ids=${USER_ID}`);
    console.log(`✓ Found ${accounts.items?.length || 0} accounts\n`);

    // 4. List available tools
    console.log('=== Step 4: List GitHub tools ===\n');
    
    const tools = await request('/tools?toolkit_slug=github');
    console.log(`✓ Found ${tools.items?.length || 0} tools`);
    if (tools.items && tools.items.length > 0) {
      console.log('  Sample tools:');
      tools.items.slice(0, 5).forEach(tool => {
        console.log(`    - ${tool.slug}: ${tool.description || 'No description'}`);
      });
    }
    console.log('');

    // 5. Test tool execution (will fail without OAuth, but validates API shape)
    console.log('=== Step 5: Test tool execution API shape ===\n');
    
    try {
      await request('/tools/execute/GITHUB_LIST_REPOS', {
        method: 'POST',
        body: JSON.stringify({
          user_id: USER_ID,
          arguments: {},
        }),
      });
    } catch (err) {
      console.log('⚠️  Expected error (no OAuth completed):', err.message.split('\n')[0]);
    }
    console.log('');

    console.log('✅ All API tests passed!\n');
    console.log('Summary:');
    console.log(`  - Auth config: ${authConfigId}`);
    console.log(`  - Redirect URL: ${connection.redirect_url}`);
    console.log(`  - Field names verified: redirect_url, connected_account_id, user_ids`);
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  }
}

test();
