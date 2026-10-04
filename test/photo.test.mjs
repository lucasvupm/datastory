import test from 'node:test';
import assert from 'node:assert/strict';
import { rowToText, normalizePhotoResult, buildPhotoPrompt, formatBytes } from '../src/ui/photo.js';
import { buildQuestions } from '../src/core/clarify.js';

const PERIOD = { year: 2026, month: 10 };

test('照片結果會按天數排序並轉成文字', () => {
  const row = { name: '王小明', entries: [{ day: 3, code: '休' }, { day: 1, code: '早' }, { day: 2, code: 'G2' }] };
  assert.equal(rowToText(row, 10), '10/1 早\n10/2 G2\n10/3 休');
});

test('轉出來的文字解析得回去', () => {
  const text = rowToText({ entries: [{ day: 1, code: '早' }, { day: 2, code: '大夜' }] }, 10);
  const qs = buildQuestions([{ id: 'a', name: '我', raw: text, hints: {}, overrides: {} }], {}, PERIOD, new Date('2026-10-04'));
  assert.ok(!qs.some((q) => q.type === 'unreadable'), '照片轉出來的文字不該讀不懂');
});

test('壞掉的回應會被擋下來', () => {
  assert.equal(normalizePhotoResult(null, PERIOD), null);
  assert.equal(normalizePhotoResult({}, PERIOD), null);
  assert.equal(normalizePhotoResult({ rows: [] }, PERIOD), null);
  assert.equal(normalizePhotoResult({ rows: [{ name: 'x', entries: [] }] }, PERIOD), null, '沒有任何一天就不算讀到');
});

test('超出範圍的日期與空白代號會被丟掉', () => {
  const r = normalizePhotoResult({
    rows: [{ name: '王', entries: [{ day: 1, code: '早' }, { day: 0, code: '早' }, { day: 32, code: '早' }, { day: 5, code: '  ' }] }],
    shifts: [{ code: '早', label: '早班', kind: 'work', start: '08:00', end: '16:00' }, { code: '', label: '空' }],
  }, PERIOD);
  assert.deepEqual(r.rows[0].entries, [{ day: 1, code: '早' }]);
  assert.equal(r.shifts.length, 1);
});

test('沒名字的列會自動編號', () => {
  const r = normalizePhotoResult({ rows: [{ entries: [{ day: 1, code: '早' }] }, { name: '  ', entries: [{ day: 2, code: '休' }] }] }, PERIOD);
  assert.deepEqual(r.rows.map((x) => x.name), ['第 1 列', '第 2 列']);
});

test('年月不合理就退回目前選的月份', () => {
  assert.equal(normalizePhotoResult({ year: 1800, month: 99, rows: [{ entries: [{ day: 1, code: '早' }] }] }, PERIOD).month, 10);
  assert.equal(normalizePhotoResult({ year: 2027, month: 3, rows: [{ entries: [{ day: 1, code: '早' }] }] }, PERIOD).year, 2027);
});

test('kind 只接受 work / off', () => {
  const r = normalizePhotoResult({
    rows: [{ entries: [{ day: 1, code: 'A' }] }],
    shifts: [{ code: 'A', kind: 'off' }, { code: 'B', kind: '亂寫' }],
  }, PERIOD);
  assert.deepEqual(r.shifts.map((s) => s.kind), ['off', 'work']);
});

test('多個人的照片會變成「哪一個是你」的問題', () => {
  const pending = {
    rows: [{ name: '王小明', entries: [{ day: 1, code: '早' }] }, { name: '李小美', entries: [{ day: 1, code: '休' }] }],
    shifts: [], note: '右下角有點糊', year: 2026, month: 10,
  };
  const qs = buildQuestions([{ id: 'a', name: '我', raw: '', hints: {}, overrides: {}, pending }], {}, PERIOD, new Date('2026-10-04'));
  const q = qs.find((x) => x.type === 'photoRow');
  assert.ok(q);
  assert.equal(q.severity, 'blocking');
  assert.deepEqual(q.options.map((o) => o.name), ['王小明', '李小美']);
  assert.ok(q.detail.includes('右下角有點糊'));
});

test('只有一個人就不該問', () => {
  const pending = { rows: [{ name: '王小明', entries: [{ day: 1, code: '早' }] }], shifts: [], year: 2026, month: 10 };
  const qs = buildQuestions([{ id: 'a', name: '我', raw: '', hints: {}, overrides: {}, pending }], {}, PERIOD, new Date('2026-10-04'));
  assert.ok(!qs.some((x) => x.type === 'photoRow'));
});

test('提示有講到整組班表跟不要亂猜', () => {
  const prompt = buildPhotoPrompt(PERIOD);
  assert.ok(prompt.includes('每一個人'));
  assert.ok(prompt.includes('不要猜'));
  assert.ok(prompt.includes('"year": 2026'));
  assert.ok(prompt.includes('month=10'));
});

test('檔案大小顯示', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});

test('照片的「哪一列是你」要排在所有問題最前面', () => {
  const pending = { rows: [{ name: '甲', entries: [{ day: 1, code: '早' }] }, { name: '乙', entries: [{ day: 1, code: '休' }] }], shifts: [], year: 2026, month: 10 };
  const qs = buildQuestions([
    { id: 'a', name: '我', raw: '10/1 早\n10/2 ZZ', hints: {}, overrides: {} },
    { id: 'b', name: '她', raw: '', hints: {}, overrides: {}, pending },
  ], {}, PERIOD, new Date('2026-10-04'));
  assert.equal(qs[0].type, 'photoRow', `排第一的是 ${qs[0].type}`);
  assert.ok(qs.some((q) => q.type === 'shift'), '其他問題還是要在');
});
