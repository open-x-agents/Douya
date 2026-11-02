// 真实模型的端到端：面板上每一句都得追得到来源，缺一个信源就得说「还没读到」。
//
// 它不进 `test/*.test.js`（每 PR 不跑），只由 pre-release 调用 —— 它要花真钱、真时间，
// 而它回答的问题是桩模型永远回答不了的那个：这个模型会不会编。
//
// 判定在 `./real-model-checks.mjs`（纯函数，`test/real-model-checks.test.js` 用桩喂它）。
// 这里只留「连一次真模型」和「把判定结果打出来」。
//
// 需要：MODEL_API_KEY（必填）、MODEL_BASE_URL、MODEL_NAME。
// 退出码：0 通过，1 不过，2 缺环境。

import { judgePanel, parseModelJson } from './real-model-checks.mjs'

const BASE = (process.env.MODEL_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
const KEY = process.env.MODEL_API_KEY;
const MODEL = process.env.MODEL_NAME || 'deepseek-chat';

// 时延预算（设计 §18）：首字 ≤3 秒；这一次调用允许到 15 秒，超了本身就是一个发现。
const FIRST_TOKEN_BUDGET_MS = 3000;
const TOTAL_BUDGET_MS = 15000;

const CONTRACT = `你是用户的「数字同事」，要把今天的信源汇总成一张面板。
只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。字段：
{
  "headline": "一句话结论，不超过 40 个汉字",
  "facts": [{"text": "一条事实，不超过 40 字", "evidence_ref": "信源列表里的 ref，原样照抄"}],
  "advice": "一条建议，不超过 20 字",
  "unread_sources": ["今天读不到的信源种类"]
}
硬规则：
1. 每条 fact 的 evidence_ref 必须原样取自信源列表的 ref，不许编 id，不许写列表以外的来源。
2. 每条 fact 引用一条不同的信源，facts 最多 3 条，按今天最要紧的排在最前。
3. 只写信源里出现过的内容；信源没有的数字、时刻、人名，一个字都不许补。
4. 读不到的信源只写进 unread_sources，不要用猜测把它填上。`;

// 夹具用产品的词汇（ref = `<source>:<id>`，source 见 src/host/panel.js 的 SOURCE_NAMES），
// 并且每条都带模型能原样引用的原文（title + excerpt）。
const COMPLETE = {
  sources: [
    {
      ref: 'feishu_cal:event/evt-77',
      source: 'feishu_cal',
      title: '评审会',
      excerpt: '14:00 开始，4 人',
      at: '2026-10-30T06:00:00Z',
    },
    {
      ref: 'github:pr/42',
      source: 'github',
      title: 'PR #42 在合并队列里等了 40 分钟',
      excerpt: '',
      at: '2026-10-30T05:20:00Z',
    },
    {
      ref: 'gmail:thread/9a1',
      source: 'gmail',
      title: '供应商报价 v3',
      excerpt: '（只读主题与收发关系，未读正文）',
      at: '2026-10-30T01:10:00Z',
    },
  ],
  unreadable: [],
};

const MISSING_MAIL = { sources: COMPLETE.sources.slice(0, 2), unreadable: ['gmail'] };

async function callModel(messages) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, stream: true, temperature: 0 }),
    });
  } catch (error) {
    throw new Error(`连不上 ${BASE}：${error.message}`);
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    if (response.status === 401 || response.status === 403) throw new Error(`鉴权失败（${response.status}）：MODEL_API_KEY 没被接受`);
    throw new Error(`模型返回 ${response.status}：${body}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let firstTokenMs = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstTokenMs === null) firstTokenMs = Date.now() - started;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
        if (delta) text += delta;
      } catch {
        // 半行 SSE 不是错误，下一轮会补齐。
      }
    }
  }

  return { text, firstTokenMs: firstTokenMs ?? Date.now() - started, totalMs: Date.now() - started };
}

const failures = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

// 判定失败的每一行都写成 `FAIL  <label> · <message> — <detail>`，pre-release 的日志里读得到。
function report(problems, label) {
  if (problems.length === 0) {
    console.log(`PASS  ${label} · 结论可追源，缺源不编`);
    return;
  }
  for (const problem of problems) {
    const line = `${label} · ${problem.message}${problem.detail ? ` — ${problem.detail}` : ''}`;
    console.log(`FAIL  ${line}`);
    failures.push(line);
  }
}

async function main() {
  if (!KEY) {
    console.error('缺 MODEL_API_KEY：真实模型 e2e 跑不了。');
    process.exit(2);
  }

  console.log(`模型：${MODEL} @ ${BASE}`);

  // 正向：三条信源齐全，结论必须可追源。
  const positive = await callModel([
    { role: 'system', content: CONTRACT },
    { role: 'user', content: `今天的信源（JSON）：\n${JSON.stringify(COMPLETE)}` },
  ]);
  console.log(`\n耗时：首字 ${positive.firstTokenMs}ms，总计 ${positive.totalMs}ms`);
  check('正向 · 首字在预算内（≤3s）', positive.firstTokenMs <= FIRST_TOKEN_BUDGET_MS, `${positive.firstTokenMs}ms`);
  check('正向 · 总时长在预算内（≤15s）', positive.totalMs <= TOTAL_BUDGET_MS, `${positive.totalMs}ms`);

  const panel = parseModelJson(positive.text);
  report(judgePanel({ panel, fixture: COMPLETE, label: '正向' }).problems, '正向');

  // 负向：邮件读不到。模型必须说「没读到」，而不是补一个数字上去。
  const negative = await callModel([
    { role: 'system', content: CONTRACT },
    { role: 'user', content: `今天的信源（JSON）：\n${JSON.stringify(MISSING_MAIL)}` },
  ]);
  const missing = parseModelJson(negative.text);
  report(judgePanel({ panel: missing, fixture: MISSING_MAIL, label: '负向' }).problems, '负向');

  console.log('');
  if (failures.length > 0) {
    console.error(`真实模型 e2e 失败 ${failures.length} 项：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('真实模型 e2e 通过：结论可追源，缺源不编。');
}

main().catch((error) => {
  console.error(`真实模型 e2e 跑不下去：${error.message}`);
  process.exit(1);
});
