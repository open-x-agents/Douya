/**
 * Integration test: Verify all client fetch() URLs are handled by the API router
 * This prevents regressions where UI calls non-existent endpoints
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { createRuntime } from '../index.js';
import { mountApiRoutes } from '../src/web/api.js';
import { createLLMClient } from '../src/web/llm-client.js';

// Extract all fetch() URLs from index.html
const EXPECTED_ROUTES = [
  { method: 'GET', path: '/api/today' },
  { method: 'GET', path: '/api/digest' },
  { method: 'GET', path: '/api/sources' },
  { method: 'GET', path: '/api/config/check' },
  { method: 'POST', path: '/api/chat' },
  { method: 'POST', path: '/api/digest/push' },
  { method: 'GET', path: '/api/composio/config' },
  { method: 'POST', path: '/api/composio/config' },
  { method: 'GET', path: '/api/composio/apps' },
  { method: 'POST', path: '/api/composio/connect' },
  { method: 'POST', path: '/api/composio/disconnect' },
  { method: 'GET', path: '/api/llm/config' },
  { method: 'POST', path: '/api/llm/config' },
  { method: 'POST', path: '/api/llm/test' },
  { method: 'GET', path: '/' }, // index.html
];

test('All client fetch() URLs are handled by API router', async (t) => {
  // Create test server
  const config = {
    home: '/tmp/odm-test-' + Date.now(),
    log: () => {},
  };

  const runtime = createRuntime(null, config);
  
  // Add mock LLM client
  const llmCtx = {
    llm: createLLMClient({
      provider: 'openai',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test-key-for-testing',
      model: 'gpt-4o',
      log: () => {},
    }),
  };

  runtime.apiRouter = runtime.createApiRouter?.({
    store: runtime.store,
    composioClient: runtime.composioClient,
    config,
    llmCtx,
    sendCard: runtime.sendCard,
    configStore: runtime.configStore,
    ctx: runtime,
    updateLLMClient: () => {},
  }) || runtime.apiRouter;

  const server = createServer();
  mountApiRoutes(server, runtime.apiRouter);

  // Start server
  await new Promise((resolve) => {
    server.listen(0, () => resolve());
  });

  const port = server.address().port;
  const baseURL = `http://localhost:${port}`;

  try {
    // Test each route
    for (const route of EXPECTED_ROUTES) {
      await t.test(`${route.method} ${route.path}`, async () => {
        const url = `${baseURL}${route.path}`;
        const options = {
          method: route.method,
          headers: { 'Content-Type': 'application/json' },
        };

        // Add body for POST requests
        if (route.method === 'POST') {
          if (route.path === '/api/chat') {
            options.body = JSON.stringify({ message: 'test' });
          } else if (route.path === '/api/llm/config') {
            options.body = JSON.stringify({ provider: 'openai', model: 'gpt-4o' });
          } else if (route.path === '/api/composio/config') {
            options.body = JSON.stringify({ apiKey: 'test' });
          } else if (route.path === '/api/composio/connect') {
            options.body = JSON.stringify({ appKey: 'github' });
          } else if (route.path === '/api/composio/disconnect') {
            options.body = JSON.stringify({ appKey: 'github' });
          } else {
            options.body = JSON.stringify({});
          }
        }

        const response = await fetch(url, options);
        
        // Should NOT be 404
        assert.notStrictEqual(
          response.status,
          404,
          `Route ${route.method} ${route.path} returned 404 - endpoint not implemented!`
        );

        // Should return valid response (2xx, 4xx for client errors, or 5xx)
        assert.ok(
          response.status >= 200 && response.status < 600,
          `Route ${route.method} ${route.path} returned unexpected status ${response.status}`
        );

        // HTML routes should return HTML
        if (route.path === '/') {
          const contentType = response.headers.get('content-type');
          assert.ok(
            contentType?.includes('text/html'),
            `Route ${route.method} ${route.path} should return HTML`
          );
        } else {
          // API routes should return JSON
          const contentType = response.headers.get('content-type');
          assert.ok(
            contentType?.includes('application/json'),
            `Route ${route.method} ${route.path} should return JSON, got ${contentType}`
          );
        }
      });
    }

    // Test 404 for non-existent route
    await t.test('Non-existent route returns 404', async () => {
      const response = await fetch(`${baseURL}/api/nonexistent`);
      assert.strictEqual(response.status, 404);
    });

  } finally {
    // Cleanup
    server.close();
  }
});

test('LLM config roundtrip', async (t) => {
  const config = {
    home: '/tmp/odm-test-llm-' + Date.now(),
    log: () => {},
  };

  const runtime = createRuntime(null, config);
  
  const llmCtx = {
    llm: createLLMClient({
      provider: 'openai',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      log: () => {},
    }),
  };

  runtime.apiRouter = runtime.createApiRouter?.({
    store: runtime.store,
    composioClient: runtime.composioClient,
    config,
    llmCtx,
    sendCard: runtime.sendCard,
    configStore: runtime.configStore,
    ctx: runtime,
    updateLLMClient: () => {},
  }) || runtime.apiRouter;

  const server = createServer();
  mountApiRoutes(server, runtime.apiRouter);

  await new Promise((resolve) => {
    server.listen(0, () => resolve());
  });

  const port = server.address().port;
  const baseURL = `http://localhost:${port}`;

  try {
    // GET initial config (should be empty)
    let response = await fetch(`${baseURL}/api/llm/config`);
    let data = await response.json();
    assert.strictEqual(data.configured, false);

    // POST new config
    response = await fetch(`${baseURL}/api/llm/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'deepseek',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'sk-deepseek-test',
        model: 'deepseek-chat',
      }),
    });
    data = await response.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.masked.includes('...'));

    // GET updated config
    response = await fetch(`${baseURL}/api/llm/config`);
    data = await response.json();
    assert.strictEqual(data.configured, true);
    assert.strictEqual(data.provider, 'deepseek');
    assert.strictEqual(data.model, 'deepseek-chat');
    assert.ok(data.apiKey.includes('...'), 'API key should be masked');

  } finally {
    server.close();
  }
});
