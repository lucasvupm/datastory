import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, apiHeaders, extractText, parseJsonLoosely, describeHttpError, askClaudeDirect, MODEL, API_URL } from '../src/core/claude.js';

test('請求形狀符合 Messages API', () => {
  const req = buildRequest([{ mediaType: 'image/png', base64: 'AAA' }, { mediaType: 'image/jpeg', base64: 'BBB' }], '讀這個');
  assert.equal(req.model, MODEL);
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].role, 'user');
  const content = req.messages[0].content;
  assert.equal(content.length, 3, '兩張圖 + 一段文字');
  assert.deepEqual(content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } });
  assert.equal(content[2].type, 'text');
  assert.equal(content[2].text, '讀這個', '文字要放在圖片後面');
  assert.equal(req.output_config.effort, 'high');
  assert.ok(!('thinking' in req), 'Opus 5.5 送 thinking 會 400');
  assert.ok(!JSON.stringify(req).includes('budget_tokens'));
});

test('瀏覽器直連的 header 齊全', () => {
  const h = apiHeaders('sk-ant-abc');
  assert.equal(h['x-api-key'], 'sk-ant-abc');
  assert.equal(h['anthropic-version'], '2023-06-01');
  assert.equal(h['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(h['content-type'], 'application/json');
});

test('extractText 接起所有文字區塊', () => {
  assert.equal(extractText({ content: [{ type: 'text', text: 'a' }, { type: 'thinking', thinking: 'x' }, { type: 'text', text: 'b' }], stop_reason: 'end_turn' }), 'a\nb');
});

test('refusal / 空回應 / 截斷都要擋下來', () => {
  assert.throws(() => extractText({ stop_reason: 'refusal', stop_details: { explanation: '不行' }, content: [] }), (e) => e.code === 'refused');
  assert.throws(() => extractText({ stop_reason: 'end_turn', content: [] }), (e) => e.code === 'empty');
  assert.throws(() => extractText({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{' }] }), (e) => e.code === 'truncated');
  assert.throws(() => extractText(null), (e) => e.code === 'bad_response');
});

test('JSON 解析容錯', () => {
  assert.deepEqual(parseJsonLoosely('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoosely('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseJsonLoosely('我讀好了：\n{"a":3}\n以上'), { a: 3 });
  assert.throws(() => parseJsonLoosely('完全沒有 JSON'), (e) => e.code === 'invalid_json');
});

test('HTTP 錯誤有看得懂的訊息', () => {
  assert.equal(describeHttpError(401).code, 'auth');
  assert.equal(describeHttpError(429).code, 'rate_limited');
  assert.equal(describeHttpError(529).code, 'overloaded');
  assert.equal(describeHttpError(503).code, 'server');
  assert.ok(describeHttpError(400, { error: { message: 'bad model' } }).message.includes('bad model'));
});

test('沒有 key 就直接擋下來，不要浪費一次請求', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  await assert.rejects(askClaudeDirect({ apiKey: '', images: [], prompt: 'x', fetchImpl }), (e) => e.code === 'no_key');
  await assert.rejects(askClaudeDirect({ apiKey: 'wrong-prefix', images: [], prompt: 'x', fetchImpl }), (e) => e.code === 'no_key');
  assert.equal(called, false);
});

test('成功路徑：送出正確的 URL、header 和 body，回傳解析後的 JSON', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"rows":[{"name":"王","entries":[{"day":1,"code":"早"}]}]}' }] }) };
  };
  const data = await askClaudeDirect({ apiKey: 'sk-ant-test', images: [{ mediaType: 'image/png', base64: 'Zm9v' }], prompt: '讀班表', fetchImpl });
  assert.equal(data.rows[0].name, '王');
  assert.equal(seen.url, API_URL);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.messages[0].content[0].source.data, 'Zm9v');
});

test('HTTP 錯誤會變成帶 code 的錯誤', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid key' } }) });
  await assert.rejects(askClaudeDirect({ apiKey: 'sk-ant-test', images: [], prompt: 'x', fetchImpl }), (e) => e.code === 'auth');
});

test('網路掛掉和取消分得出來', async () => {
  await assert.rejects(
    askClaudeDirect({ apiKey: 'sk-ant-t', images: [], prompt: 'x', fetchImpl: async () => { throw new Error('boom'); } }),
    (e) => e.code === 'network',
  );
  await assert.rejects(
    askClaudeDirect({ apiKey: 'sk-ant-t', images: [], prompt: 'x', fetchImpl: async () => { const e = new Error('a'); e.name = 'AbortError'; throw e; } }),
    (e) => e.code === 'cancelled',
  );
});
