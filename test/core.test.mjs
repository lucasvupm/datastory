import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, daysInMonth, weekdayOf, detectMonth } from '../src/core/parse.js';
import { normalizeCode, guessShift, mergeDictionary, resolveCode, parseTimeRangeCode } from '../src/core/dict.js';
import { buildPersonSchedule, buildQuestions, learnShift, forgetShift, formatDays } from '../src/core/clarify.js';
import { mergeSchedules, DEFAULT_SETTINGS, toMinutes, fromMinutes, shiftDuration, bothOffRuns } from '../src/core/merge.js';
import { buildIcs, buildTextSummary, buildBackup, parseBackup } from '../src/core/export.js';

const TODAY = new Date('2026-10-04T00:00:00Z');
const PERIOD = { year: 2026, month: 10 };
const person = (raw, extra = {}) => ({ id: 'a', name: '我', raw, hints: {}, overrides: {}, ...extra });

// ---------------------------------------------------------------- 日期工具

test('daysInMonth 算得出閏年', () => {
  assert.equal(daysInMonth(2026, 10), 31);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2028, 2), 29);
});

test('weekdayOf 以週一為 0', () => {
  assert.equal(weekdayOf(2026, 10, 1), 3); // 2026/10/1 是週四
  assert.equal(weekdayOf(2026, 10, 4), 6); // 週日
});

// ---------------------------------------------------------------- 代號

test('normalizeCode 處理全形與空白', () => {
  assert.equal(normalizeCode('　早 班 '), '早班');
  assert.equal(normalizeCode('ｇ２'), 'G2');
  assert.equal(normalizeCode('(休)'), '休');
});

test('時間區間代號不用問就能讀', () => {
  assert.deepEqual(parseTimeRangeCode('0800-1700'), { kind: 'work', start: '08:00', end: '17:00', hue: parseTimeRangeCode('0800-1700').hue, label: '08:00-17:00' });
  assert.equal(parseTimeRangeCode('16:00~00:00').start, '16:00');
  assert.equal(parseTimeRangeCode('早班'), null);
});

test('沒見過的代號會給合理的猜測', () => {
  const dict = mergeDictionary({});
  assert.equal(guessShift('晚班', dict).start, '16:00');
  assert.equal(guessShift('排休', dict).kind, 'off');
  assert.equal(guessShift('G2', dict).borrowedFrom, 'G1'); // 跟 G1 只差一個字
});

// ---------------------------------------------------------------- 版型

test('每行一天（有日期）', () => {
  const r = parseSchedule('10/1 早\n10/2 休\n10/3(五) 小夜', { ...PERIOD, today: TODAY });
  assert.equal(r.layout, 'dated');
  assert.deepEqual(r.entries.map((e) => [e.day, e.code]), [[1, '早'], [2, '休'], [3, '小夜']]);
});

test('時間區間不會被誤讀成日期', () => {
  const r = parseSchedule('10/5 0800-1700\n10/6 休', { ...PERIOD, today: TODAY });
  assert.equal(r.entries[0].code, '0800-1700');
  assert.equal(r.entries[0].def.start, '08:00');
});

test('表格（星期列 + 日期列 + 班別列）', () => {
  const r = parseSchedule('一 二 三 四 五 六 日\n1 2 3 4 5 6 7\n早 早 休 休 中 中 早', { ...PERIOD, today: TODAY });
  assert.equal(r.layout, 'grid');
  assert.equal(r.entries.length, 7);
  assert.equal(r.entries[6].code, '早');
});

test('班別：日期清單，含範圍', () => {
  const r = parseSchedule('早班：1,3,5\n休：2,4\n大夜：10-13', { ...PERIOD, today: TODAY });
  assert.equal(r.layout, 'codeToDays');
  assert.equal(r.entries.length, 9);
  assert.equal(r.entries.find((e) => e.day === 12).def.label, '大夜');
});

test('兩欄（日 + 班別）', () => {
  const r = parseSchedule('日期\t班別\n1\t早\n2\t休\n3\t小夜', { ...PERIOD, today: TODAY });
  assert.ok(['twoColumn', 'grid'].includes(r.layout));
  assert.equal(r.entries.length, 3);
});

test('只有代號的序列', () => {
  const codes = Array.from({ length: 31 }, (_, i) => (i % 3 === 2 ? '休' : '早')).join(' ');
  const r = parseSchedule(codes, { ...PERIOD, today: TODAY });
  assert.equal(r.layout, 'sequence');
  assert.equal(r.entries.length, 31);
});

test('同一天兩筆不同資料會被當成衝突', () => {
  const r = parseSchedule('10/1 早\n10/1 休\n10/2 休', { ...PERIOD, today: TODAY });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].day, 1);
});

test('超出該月天數的日期會被擋下來', () => {
  const r = parseSchedule('2/28 早\n2/30 早', { year: 2026, month: 2, today: TODAY });
  assert.deepEqual(r.extraDays, [30]);
});

test('detectMonth 讀得出年月', () => {
  assert.deepEqual(detectMonth('2026年10月班表', TODAY), { year: 2026, month: 10, source: 'text' });
  assert.equal(detectMonth('11月份', TODAY).month, 11);
  assert.equal(detectMonth('沒有月份', TODAY), null);
});

// ---------------------------------------------------------------- 詢問

test('不認得的代號會變成問題，回答後就不再問', () => {
  const people = [person('10/1 早\n10/2 G2\n10/3 G2')];
  const before = buildQuestions(people, {}, PERIOD, TODAY);
  assert.ok(before.some((q) => q.type === 'shift' && q.key === 'G2'));

  const learned = learnShift({}, 'G2', { label: '假日班', kind: 'work', start: '10:00', end: '19:00' });
  const after = buildQuestions(people, learned, PERIOD, TODAY);
  assert.ok(!after.some((q) => q.type === 'shift' && q.key === 'G2'));
  assert.equal(learned.G2.start, '10:00');
  assert.deepEqual(forgetShift(learned, 'G2'), {});
});

test('貼到別的月份會被問要不要切過去', () => {
  const qs = buildQuestions([person('11/1 早\n11/2 休')], {}, PERIOD, TODAY);
  const q = qs.find((x) => x.type === 'monthMismatch');
  assert.ok(q, '應該要問月份');
  assert.equal(q.value.month, 11);
});

test('數字代號一定會先確認一次', () => {
  const qs = buildQuestions([person('10/1 1\n10/2 2\n10/3 0')], {}, PERIOD, TODAY);
  assert.ok(qs.some((q) => q.type === 'shift' && q.key === '1'));
});

test('跨午夜的班會問日期算哪一天', () => {
  const qs = buildQuestions([person('10/1 大夜\n10/2 大夜\n10/3 休')], {}, PERIOD, TODAY);
  assert.ok(qs.some((q) => q.type === 'nightAnchor'));
  const learned = learnShift({}, '大夜', { label: '大夜', kind: 'work', start: '00:00', end: '08:00', dayOffset: 1 });
  assert.ok(!buildQuestions([person('10/1 大夜\n10/2 大夜\n10/3 休')], learned, PERIOD, TODAY).some((q) => q.type === 'nightAnchor'));
});

test('沒資料的日子會問，說是休假就補上', () => {
  const p = person('10/1 早\n10/2 早');
  assert.ok(buildQuestions([p], {}, PERIOD, TODAY).some((q) => q.type === 'blanks'));
  const filled = buildPersonSchedule({ ...p, hints: { fillMissing: 'off' } }, {}, PERIOD, TODAY);
  assert.equal(filled.days.size, 31);
  assert.equal(filled.days.get(20).def.kind, 'off');
});

test('手動覆寫永遠贏過解析結果', () => {
  const sched = buildPersonSchedule(person('10/1 早\n10/2 早', { overrides: { 2: '休', 3: '小夜' } }), {}, PERIOD, TODAY);
  assert.equal(sched.days.get(2).def.label, '休假');
  assert.equal(sched.days.get(3).def.label, '小夜');
});

test('純序列可以指定從幾號開始', () => {
  const sched = buildPersonSchedule(person('早 早 休 休 中 中 早 早 早 休', { hints: { startDay: 5 } }), {}, PERIOD, TODAY);
  assert.equal(sched.days.get(5).code, '早');
  assert.equal(sched.days.get(7).code, '休');
  assert.equal(sched.days.has(1), false);
});

test('formatDays 把連續日期縮成區間', () => {
  assert.equal(formatDays([1, 2, 3, 7, 9, 10], 10), '10/1-3、7、9-10');
});

// ---------------------------------------------------------------- 合併

test('時間工具', () => {
  assert.equal(toMinutes('08:30'), 510);
  assert.equal(fromMinutes(510), '08:30');
  assert.equal(shiftDuration({ start: '16:00', end: '00:00' }), 480);
  assert.equal(shiftDuration({ start: '22:00', end: '06:00' }), 480);
});

test('兩人都休才算共同休假，沒資料不算', () => {
  const a = buildPersonSchedule(person('10/1 休\n10/2 休\n10/3 早'), {}, PERIOD, TODAY);
  const b = buildPersonSchedule({ ...person('10/1 休\n10/2 早\n10/3 休'), id: 'b' }, {}, PERIOD, TODAY);
  const m = mergeSchedules(a, b, PERIOD);
  assert.equal(m.days[0].status, 'both-off');
  assert.equal(m.days[1].status, 'one-off');
  assert.equal(m.days[3].status, 'unknown');
  assert.equal(m.stats.bothOff, 1);
});

test('沒資料的日子不會被當成有空', () => {
  const a = buildPersonSchedule(person('10/1 休'), {}, PERIOD, TODAY);
  const b = buildPersonSchedule({ ...person('10/1 休'), id: 'b' }, {}, PERIOD, TODAY);
  const m = mergeSchedules(a, b, PERIOD);
  assert.equal(m.stats.freeDays, 1);
  assert.equal(m.days[5].free.length, 0);
});

test('早班配小夜根本沒交集', () => {
  const a = buildPersonSchedule(person('10/1 早'), {}, PERIOD, TODAY);
  const b = buildPersonSchedule({ ...person('10/1 小夜'), id: 'b' }, {}, PERIOD, TODAY);
  const m = mergeSchedules(a, b, PERIOD);
  assert.equal(m.days[0].free.length, 0);
  assert.equal(m.days[0].status, 'both-work');
});

test('大夜下班後要補眠，空檔從下午才開始', () => {
  const a = buildPersonSchedule(person('10/1 大夜'), {}, PERIOD, TODAY);
  const b = buildPersonSchedule({ ...person('10/1 休'), id: 'b' }, {}, PERIOD, TODAY);
  const m = mergeSchedules(a, b, PERIOD);
  assert.deepEqual(m.days[0].free.map((f) => [f.start, f.end]), [['14:30', '23:00']]);
});

test('dayOffset 會把夜班挪到隔天', () => {
  const learned = learnShift({}, '大夜', { label: '大夜', kind: 'work', start: '00:00', end: '08:00', dayOffset: 1 });
  const a = buildPersonSchedule(person('10/1 大夜\n10/2 休'), learned, PERIOD, TODAY);
  const b = buildPersonSchedule({ ...person('10/1 休\n10/2 休'), id: 'b' }, {}, PERIOD, TODAY);
  const m = mergeSchedules(a, b, PERIOD);
  assert.equal(m.days[0].free[0].end, '23:00', '10/1 整天空著');
  assert.equal(m.days[1].free[0].start, '14:30', '班挪到 10/2 凌晨，所以下午才有空');
});

test('設定改了，空檔也跟著變', () => {
  const a = buildPersonSchedule(person('10/1 早'), {}, PERIOD, TODAY);
  const b = buildPersonSchedule({ ...person('10/1 休'), id: 'b' }, {}, PERIOD, TODAY);
  const tight = mergeSchedules(a, b, PERIOD, { ...DEFAULT_SETTINGS, commuteMinutes: 0 });
  assert.equal(tight.days[0].free[0].start, '16:00');
  const loose = mergeSchedules(a, b, PERIOD, { ...DEFAULT_SETTINGS, commuteMinutes: 90 });
  assert.equal(loose.days[0].free[0].start, '17:30');
  const strict = mergeSchedules(a, b, PERIOD, { ...DEFAULT_SETTINGS, minBlockMinutes: 600 });
  assert.equal(strict.days[0].free.length, 0);
});

test('連續共同休假會被串成一段', () => {
  const days = [
    { status: 'both-off', day: 1 }, { status: 'both-off', day: 2 },
    { status: 'one-off', day: 3 },
    { status: 'both-off', day: 4 }, { status: 'both-off', day: 5 }, { status: 'both-off', day: 6 },
  ];
  const runs = bothOffRuns(days);
  assert.deepEqual(runs.map((r) => r.length), [2, 3]);
  assert.equal(runs[1].start.day, 4);
});

// ---------------------------------------------------------------- 匯出

function sample() {
  const a = buildPersonSchedule(person('10/1 早\n10/2 休\n10/3 休'), {}, PERIOD, TODAY);
  const b = buildPersonSchedule({ ...person('10/1 小夜\n10/2 休\n10/3 休'), id: 'b' }, {}, PERIOD, TODAY);
  return mergeSchedules(a, b, PERIOD);
}

test('ICS 結構完整，CRLF 換行', () => {
  const ics = buildIcs(sample(), { names: { a: '我', b: '小美' } });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, (ics.match(/END:VEVENT/g) || []).length);
  assert.ok(ics.includes('SUMMARY:我 早班'));
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20261002'));
  assert.ok(ics.includes('DTEND;VALUE=DATE:20261004'), '全天事件的結束日要加一天');
});

test('ICS 把小夜的跨日時間算對', () => {
  const ics = buildIcs(sample(), { names: { a: '我', b: '小美' }, include: { shiftsA: false, bothOff: false, freeSlots: false } });
  assert.ok(ics.includes('DTSTART:20261001T160000'));
  assert.ok(ics.includes('DTEND:20261002T000000'));
});

test('文字摘要可以直接貼到 LINE', () => {
  const text = buildTextSummary(sample(), { names: { a: '我', b: '小美' } });
  assert.ok(text.includes('2026 年 10 月 共同班表'));
  assert.ok(text.includes('10/2（五） ~ 10/3（六）'));
  assert.ok(text.includes('[還沒有資料]'));
});

test('備份可以存出來再讀回去', () => {
  const state = { people: [person('10/1 早')], learned: { G2: { key: 'G2', label: '假日班', kind: 'work', start: '10:00', end: '19:00' } }, settings: DEFAULT_SETTINGS, period: PERIOD };
  const restored = parseBackup(buildBackup(state));
  assert.equal(restored.learned.G2.label, '假日班');
  assert.equal(restored.period.month, 10);
  assert.throws(() => parseBackup('{"nope":1}'), /找不到/);
  assert.throws(() => parseBackup('not json'));
});
