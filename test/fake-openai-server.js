#!/usr/bin/env node
/**
 * Fake OpenAI-compatible server that mimics DeepSeek behavior
 * - Supports streaming with response_format: json_object
 * - Returns structured JSON split across SSE chunks
 * - Also supports non-streaming mode
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
        console.log(`  Stream: ${data.stream ? 'yes' : 'no'}`);
        console.log(`  Messages: ${data.messages.length} messages`);
        
        // Structured JSON response (mimics DeepSeek JSON mode output)
        const structuredResponse = JSON.stringify({
          text: '这是一条简短的回复',
          cards: [
            {
              type: 'info',
              title: '今日日程',
              description: '您今天下午的工作安排',
              items: ['14:00 - 项目评审会', '15:30 - 代码审查', '17:00 - 团队同步'],
            },
            {
              type: 'action',
              title: '建议操作',
              actions: [
                { label: '查看详情', value: 'view_details' },
                { label: '添加任务', value: 'add_task' },
              ],
            },
          ],
        });

        if (data.stream) {
          // Streaming mode: split JSON across multiple SSE chunks (like DeepSeek)
          res.writeHead(200, { 
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          
          // Split response into realistic chunks (20-30 chars each)
          const chunkSize = 25;
          for (let i = 0; i < structuredResponse.length; i += chunkSize) {
            const chunk = structuredResponse.slice(i, i + chunkSize);
            res.write(`data: ${JSON.stringify({
              choices: [{
                delta: { content: chunk },
                index: 0,
              }],
            })}\n\n`);
          }
          
          res.write('data: [DONE]\n\n');
          res.end();
          
          console.log(`[FAKE SERVER] Streamed ${structuredResponse.length} chars in ${Math.ceil(structuredResponse.length / chunkSize)} chunks`);
        } else {
          // Non-streaming mode
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'fake-' + Date.now(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: data.model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: structuredResponse,
              },
              finish_reason: 'stop',
            }],
          }));
          
          console.log(`[FAKE SERVER] Returned ${structuredResponse.length} chars (non-streaming)`);
        }
      } catch (err) {
        console.error('[FAKE SERVER] Error:', err);
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
  console.log(`✅ Fake DeepSeek-like server running at http://localhost:${PORT}`);
  console.log(`   Endpoint: http://localhost:${PORT}/v1/chat/completions`);
  console.log(`   Supports: streaming + response_format json_object`);
  console.log('');
  console.log('Press Ctrl+C to stop');
});
