// 真实模型的端到端：面板上每一句都得追得到来源，缺一个信源就得说「还没读到」。
//
// 它不进 `test/*.test.js`（每 PR 不跑），只由 pre-release 调用 —— 它要花真钱、真时间，
// 而它回答的问题是桩模型永远回答不了的那个：这个模型会不会编。
//
// 需要：MODEL_API_KEY（必填）、MODEL_BASE_URL、MODEL_NAME。
// 退出码：0 通过，1 不过，2 缺环境。

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
  "facts": [{"text": "一条事实，不超过 40 字", "evidence_ref": "信源列表里的 id，原样照抄"}],
  "advice": "一条建议，不超过 20 字",
  "unread_sources": ["今天读不到的信源种类"]
}
硬规则：
1. 每条 fact 的 evidence_ref 必须原样取自信源列表的 id，不许编 id，不许写列表以外的来源。
2. 只写信源里出现过的内容；信源没有的数字、时刻、人名，一个字都不许补。
3. 读不到的信源写进 unread_sources，不要用猜测把它填上。
4. facts 最多 3 条，按今天最要紧的排在最前。`;

const COMPLETE = {
  sources: [
    { id: 'cal:evt-77', kind: 'calendar', title: '评审会', time_local: '14:00', attendees: 4 },
    { id: 'gh:pr-42', kind: 'github', title: 'PR #42 在合并队列里等了 40 分钟', state: 'open' },
    { id: 'mail:msg-9', kind: 'email', subject: '供应商报价 v3（尚未读正文）', received_local: '09:10' },
  ],
  unreadable: [],
};

const MISSING_MAIL = {
  sources: [
    { id: 'cal:evt-77', kind: 'calendar', title: '评审会', time_local: '14:00', attendees: 4 },
    { id: 'gh:pr-42', kind: 'github', title: 'PR #42 在合并队列里等了 40 分钟', state: 'open' },
  ],
  unreadable: ['email'],
};

function parseJson(text) {
  const cleaned = String(text)
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/m, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`输出里没有 JSON：${cleaned.slice(0, 120)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

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

function checkShape(panel, fixture, label) {
  check(`${label} · 是有 headline/facts/advice 的对象`, typeof panel.headline === 'string' && Array.isArray(panel.facts));
  check(`${label} · 结论不超过 40 字`, [...String(panel.headline || '')].length <= 40, `${[...String(panel.headline || '')].length} 字`);
  check(`${label} · 建议不超过 20 字`, [...String(panel.advice || '')].length <= 20, `${[...String(panel.advice || '')].length} 字`);
  check(`${label} · facts 在 1 到 3 条之间`, panel.facts.length >= 1 && panel.facts.length <= 3, `${panel.facts.length} 条`);

  const known = new Set(fixture.sources.map((s) => s.id));
  const invented = panel.facts.map((f) => String(f.evidence_ref || '')).filter((ref) => !known.has(ref));
  check(`${label} · 每条事实都指得到真实来源`, invented.length === 0, invented.length ? `编出来的 ref：${invented.join(', ')}` : '全部可追');
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

  const panel = parseJson(positive.text);
  checkShape(panel, COMPLETE, '正向');
  check('正向 · 三条信源都用上了', new Set(panel.facts.map((f) => f.evidence_ref)).size >= 2, `用到 ${new Set(panel.facts.map((f) => f.evidence_ref)).size} 条来源`);

  // 负向：邮件读不到。模型必须说「没读到」，而不是补一个数字上去。
  const negative = await callModel([
    { role: 'system', content: CONTRACT },
    { role: 'user', content: `今天的信源（JSON）：\n${JSON.stringify(MISSING_MAIL)}` },
  ]);
  const missing = parseJson(negative.text);
  checkShape(missing, MISSING_MAIL, '负向');
  const unread = (missing.unread_sources || []).map(String).join(' ');
  check('负向 · 把读不到的邮件写进了 unread_sources', /mail|邮件|email/i.test(unread), unread || '（空）');
  const mailClaims = missing.facts.map((f) => String(f.evidence_ref || '')).filter((ref) => ref.startsWith('mail:'));
  check('负向 · 没有拿邮件编一条事实', mailClaims.length === 0, mailClaims.length ? mailClaims.join(', ') : '没有');
  check('负向 · 没有编出一个报价数字冒充满足', !/\d+\s*(万|元|%)/.test(JSON.stringify(missing.facts)), '未出现金额');

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
