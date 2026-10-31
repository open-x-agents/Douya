#!/usr/bin/env node
/**
 * Fake OpenAI-compatible server for testing
 * Responds to POST /v1/chat/completions
 */

import { createServer } from 'node:http';

const PORT = 9999;

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const authHeader = req.headers.authorization;
        
        console.log(`[FAKE SERVER] Received request:`);
        console.log(`  Authorization: ${authHeader}`);
        console.log(`  Model: ${data.model}`);
        console.log(`  Messages: ${JSON.stringify(data.messages)}`);
        
        // Return fake streaming response
        if (data.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"content":" from"}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"content":" fake"}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"content":" server!"}}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          // Non-streaming
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{
              message: {
                content: 'Hello from fake OpenAI server! ✓'
              }
            }]
          }));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`✅ Fake OpenAI server running at http://localhost:${PORT}`);
  console.log(`   Endpoint: http://localhost:${PORT}/v1/chat/completions`);
  console.log('');
  console.log('Press Ctrl+C to stop');
});
