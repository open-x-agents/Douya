#!/usr/bin/env node
/**
 * Fake OpenAI-compatible server for testing
 * Responds to POST /v1/chat/completions with structured JSON
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
        console.log(`  Response format: ${data.response_format?.type || 'none'}`);
        console.log(`  Messages: ${data.messages.length} messages`);
        
        // Structured JSON response with cards
        const structuredResponse = JSON.stringify({
          text: '这是一条简短的回复',
          cards: [
            {
              type: 'info',
              title: '测试卡片',
              description: '这是来自假服务器的结构化响应',
              items: ['项目 1', '项目 2', '项目 3'],
            },
            {
              type: 'action',
              title: '可用操作',
              actions: [
                { label: '查看详情', value: 'view_details' },
                { label: '关闭', value: 'close' },
              ],
            },
          ],
        });

        // Return fake streaming response
        if (data.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          
          // Split response into chunks for streaming
          const chunks = structuredResponse.match(/.{1,20}/g) || [];
          for (const chunk of chunks) {
            res.write(`data: ${JSON.stringify({choices:[{delta:{content:chunk}}]})}\n\n`);
          }
          
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          // Non-streaming
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{
              message: { content: structuredResponse }
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
