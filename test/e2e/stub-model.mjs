// 本地模型桩：只给验收用，不接进发版路径。
//
// 真模型 e2e 的失败分支（401、缺 facts、编 ref、编数字）在离线时也得判得了，否则
// A2/A3/A5/A6/A7 只能等 key 和人肉。它只说 OpenAI 兼容的两帧 SSE，不延迟、不心跳 ——
// 首字口径那件事是单测注入时钟，不靠这个桩。
//
// 用法：node test/e2e/stub-model.mjs --mode=<name> [--port=8787]
// 起来后第一行打印 http://127.0.0.1:<port>/v1，直到被 kill。

import http from 'node:http'

const PANELS = {
  shape: { headline: '今天两件事', advice: '先看评审' },
  'invented-ref': {
    headline: '今天两件事',
    advice: '先看评审',
    facts: [{ text: '评审会 14:00 开始', evidence_ref: 'feishu_cal:event/999' }],
    unread_sources: [],
  },
  'invented-anchor': {
    headline: '今天两件事',
    advice: '先看评审',
    facts: [{ text: '报价 12.8 万已发出', evidence_ref: 'github:pr/42' }],
    unread_sources: [],
  },
}

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const mode = arg('mode', 'invented-ref')
const port = Number(arg('port', '8787'))
if (mode !== 'auth401' && !PANELS[mode]) {
  console.error(`不认识的 --mode：${mode}（auth401 / shape / invented-ref / invented-anchor）`)
  process.exit(2)
}

function sse(response, panel) {
  const frame = { choices: [{ delta: { content: JSON.stringify(panel) } }] }
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  response.write(`data: ${JSON.stringify(frame)}\n\n`)
  response.write('data: [DONE]\n\n')
  response.end()
}

const server = http.createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => {
    if (!request.url.endsWith('/chat/completions') || request.method !== 'POST') {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end('{"error":{"message":"not found"}}')
      return
    }
    if (mode === 'auth401') {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end('{"error":{"message":"bad key"}}')
      return
    }
    sse(response, PANELS[mode])
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${port}/v1`)
})
