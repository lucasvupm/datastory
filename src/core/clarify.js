// 詢問引擎：解析完之後，把所有「我不確定」的地方變成一張張問題卡。
// 回答過的東西會寫回字典 / 覆寫表，所以同樣的問題不會問第二次。
import { WORK, OFF, normalizeCode, guessShift, mergeDictionary, resolveCode, hueFromStart } from './dict.js';
import { parseSchedule, daysInMonth, isoDate } from './parse.js';

export const UNKNOWN_DEF = { key: '?', label: '未填', kind: 'unknown', start: null, end: null, hue: 0 };

/**
 * 把一個人的原始貼上內容，加上他回答過的設定，算出整月班表。
 * period = { year, month }：整個 App 共用一個月份，兩邊才對得起來。
 */
export function buildPersonSchedule(person, learned = {}, period = null, today = new Date()) {
  const hints = person.hints || {};
  const parsed = parseSchedule(person.raw || '', {
    year: period?.year,
    month: period?.month,
    layout: hints.layout,
    learned,
    today,
  });
  const dict = mergeDictionary(learned);
  const offset = (hints.startDay || 1) - 1;
  const dayCount = parsed.dayCount;
  const days = new Map();

  for (const entry of parsed.entries) {
    const day = parsed.layout === 'sequence' ? entry.day + offset : entry.day;
    if (day < 1 || day > dayCount) continue;
    days.set(day, { day, code: entry.code, def: entry.def, source: 'parsed' });
  }

  // 使用者手改的那幾天永遠贏
  for (const [rawDay, code] of Object.entries(person.overrides || {})) {
    const day = Number(rawDay);
    if (!Number.isInteger(day) || day < 1 || day > dayCount) continue;
    if (code === null || code === '') {
      days.delete(day);
      continue;
    }
    days.set(day, { day, code, def: resolveCode(dict, code), source: 'manual' });
  }

  // 沒資料的日子：使用者說過要當休假就補上，否則留白
  const blanks = [];
  for (let d = 1; d <= dayCount; d += 1) if (!days.has(d)) blanks.push(d);
  if (hints.fillMissing === 'off') {
    const offDef = resolveCode(dict, '休');
    for (const d of blanks) days.set(d, { day: d, code: '休', def: offDef, source: 'filled' });
  }

  return {
    personId: person.id,
    year: parsed.year,
    month: parsed.month,
    dayCount,
    parsed,
    days,
    blanks: hints.fillMissing === 'off' ? [] : blanks,
    filledCount: hints.fillMissing === 'off' ? blanks.length : 0,
  };
}

function suggestFill(parsed) {
  if (parsed.entries.length === 0) return 'ask';
  const hasOff = parsed.entries.some((e) => e.def && e.def.kind === OFF);
  const coverage = parsed.entries.length / parsed.dayCount;
  if (!hasOff && coverage < 0.85) return 'off';
  return 'blank';
}

/**
 * 產生問題卡。
 * @param {Array} people [{id, name, raw, hints, overrides}]
 * @param {object} learned 學過的字典
 */
export function buildQuestions(people, learned = {}, period = null, today = new Date()) {
  const questions = [];
  const assumedBuckets = new Map();
  let anyMonthInText = false;

  for (const person of people) {
    const who = person.name || (person.id === 'a' ? '你' : '對方');

    // 照片讀回來有好幾個人的班（醫院、賣場的班表通常是整組的），先問哪一個是他
    const pending = person.pending;
    if (pending && Array.isArray(pending.rows) && pending.rows.length > 1) {
      questions.push({
        id: `${person.id}:photoRow`,
        personId: person.id,
        type: 'photoRow',
        severity: 'blocking',
        title: `照片裡有 ${pending.rows.length} 個人的班，哪一個是${who}？`,
        detail: pending.note ? `Claude 的備註：${pending.note}` : '選一個，那一列就會填進去，填完還可以自己改。',
        options: pending.rows.map((row, index) => ({ index, name: row.name, count: row.entries.length })),
      });
      continue;
    }

    if (!(person.raw || '').trim()) continue;
    const sched = buildPersonSchedule(person, learned, period, today);
    if (sched.parsed.detected) anyMonthInText = true;
    const p = sched.parsed;

    const otherMonth = p.detected && p.detected.month !== p.month
      ? p.detected.month
      : (p.entries.length === 0 && p.otherMonths.length === 1 ? p.otherMonths[0] : null);
    if (otherMonth !== null) {
      questions.push({
        id: `${person.id}:monthMismatch`,
        personId: person.id,
        type: 'monthMismatch',
        severity: 'blocking',
        title: `${who}貼的好像是 ${otherMonth} 月的班表`,
        detail: `現在看的是 ${p.year} 年 ${p.month} 月。要把整份共同班表切到 ${otherMonth} 月，還是這份其實就是 ${p.month} 月的？`,
        value: { year: p.detected?.year ?? p.year, month: otherMonth },
      });
      continue;
    }

    if (p.entries.length === 0) {
      questions.push({
        id: `${person.id}:empty`,
        personId: person.id,
        type: 'unreadable',
        severity: 'blocking',
        title: `${who}的班表我讀不出來`,
        detail: `貼進來的 ${p.lineCount} 行裡我找不到「日期 + 班別」的組合。可以告訴我它長什麼樣子，或者直接用手動模式一天一天點。`,
      });
      continue;
    }

    if (p.confidence < 0.65 && p.alternates.length > 0) {
      questions.push({
        id: `${person.id}:layout`,
        personId: person.id,
        type: 'layout',
        severity: 'check',
        title: `${who}的班表格式我不太確定`,
        detail: `我把它當成「${p.layoutName}」來讀，抓到 ${p.entries.length} 天。換一種讀法試試？`,
        options: [
          { layout: p.layout, name: p.layoutName, count: p.entries.length },
          ...p.alternates.map((a) => ({ layout: a.layout, name: a.name, count: a.count })),
        ],
        value: { layout: p.layout },
      });
    }

    if (p.layout === 'sequence') {
      const first = p.entries[0];
      questions.push({
        id: `${person.id}:startDay`,
        personId: person.id,
        type: 'startDay',
        severity: 'check',
        title: `${who}的第一個代號「${first?.code ?? '?'}」是 ${p.month}/${person.hints?.startDay || 1} 嗎？`,
        detail: '這份班表只有代號沒有日期，所以我從月初開始排。如果起始日不同，改一下就好。',
        value: { startDay: person.hints?.startDay || 1 },
        max: p.dayCount,
      });
    }

    for (const unknown of p.unknownCodes) {
      const guess = guessShift(unknown.code, mergeDictionary(learned));
      questions.push({
        id: `code:${unknown.key}`,
        personId: person.id,
        type: 'shift',
        severity: 'blocking',
        title: `「${unknown.code}」是什麼班？`,
        detail: `${who}的班表出現 ${unknown.days.length} 次（${formatDays(unknown.days, p.month)}）。回答一次，以後都會自動認得。`,
        code: unknown.code,
        key: unknown.key,
        value: { ...guess, label: guess.label === unknown.key ? unknown.code : guess.label },
        hintText: guess.borrowedFrom ? `看起來跟「${guess.borrowedFrom}」很像，時間先借來用。` : null,
      });
    }

    for (const amb of p.ambiguousCodes) {
      questions.push({
        id: `code:${amb.key}`,
        personId: person.id,
        type: 'shift',
        severity: 'blocking',
        title: `「${amb.code}」我猜是${amb.def.label}，對嗎？`,
        detail: `數字代號每間公司不一樣，確認一次就好（出現在 ${formatDays(amb.days, p.month)}）。`,
        code: amb.code,
        key: amb.key,
        value: { ...amb.def, guess: true },
      });
    }

    for (const assumed of p.assumedCodes) {
      const bucket = assumedBuckets.get(assumed.key) || { key: assumed.key, code: assumed.code, def: assumed.def, people: [] };
      if (!bucket.people.includes(who)) bucket.people.push(who);
      assumedBuckets.set(assumed.key, bucket);
    }

    for (const conflict of p.conflicts) {
      questions.push({
        id: `${person.id}:conflict:${conflict.day}`,
        personId: person.id,
        type: 'conflict',
        severity: 'blocking',
        title: `${who} ${p.month}/${conflict.day} 有兩筆資料，要用哪個？`,
        detail: conflict.codes.join('　/　'),
        day: conflict.day,
        options: conflict.codes,
      });
    }

    if (sched.blanks.length > 0) {
      const suggestion = suggestFill(p);
      questions.push({
        id: `${person.id}:blanks`,
        personId: person.id,
        type: 'blanks',
        severity: sched.blanks.length > p.dayCount / 2 ? 'blocking' : 'check',
        title: `${who}有 ${sched.blanks.length} 天沒有資料`,
        detail: `${formatDays(sched.blanks, p.month)}。這些是休假，還是班表就只給到這裡？`,
        days: sched.blanks,
        suggestion,
      });
    }

    if (p.extraDays.length > 0) {
      questions.push({
        id: `${person.id}:extra`,
        personId: person.id,
        type: 'note',
        severity: 'check',
        title: `${who}的班表有 ${p.month} 月不存在的日期`,
        detail: `${p.extraDays.join('、')} 號超出 ${p.month} 月（共 ${p.dayCount} 天），這幾筆被跳過了。月份選錯了嗎？`,
      });
    }

    for (const note of p.notes) {
      questions.push({
        id: `${person.id}:note:${hashString(note)}`,
        personId: person.id,
        type: 'note',
        severity: 'check',
        title: `${who}的班表有一點怪`,
        detail: note,
      });
    }
  }

  if (!anyMonthInText && people.some((p) => (p.raw || '').trim()) && period) {
    questions.push({
      id: 'period:confirm',
      type: 'period',
      severity: 'check',
      title: `這是 ${period.year} 年 ${period.month} 月的班表嗎？`,
      detail: '兩份班表上都沒寫月份，所以我用你選的月份排。',
      value: { year: period.year, month: period.month },
    });
  }

  const nightShifts = new Map();
  for (const person of people) {
    if (!(person.raw || '').trim()) continue;
    const sched = buildPersonSchedule(person, learned, period, today);
    for (const cell of sched.days.values()) {
      const def = cell.def;
      if (!def || def.kind !== WORK || !def.start) continue;
      const startHour = Number(String(def.start).slice(0, 2));
      if (startHour > 6) continue; // 只有凌晨開始的班才有這個歧義
      if (def.dayOffset !== undefined) continue; // 已經回答過
      if (!nightShifts.has(def.key)) nightShifts.set(def.key, { key: def.key, def, code: cell.code });
    }
  }
  for (const night of nightShifts.values()) {
    questions.push({
      id: `night:${night.key}`,
      type: 'nightAnchor',
      severity: 'check',
      title: `「${night.code}」寫在某一天，是指那天去上班嗎？`,
      detail: `${night.def.label} 是 ${night.def.start}-${night.def.end}。有的班表寫 10/5 大夜是指 10/5 凌晨下班（也就是 10/4 晚上去上班），有的是指 10/5 晚上去上班。選錯會讓共同空檔整個差一天。`,
      key: night.key,
      def: night.def,
    });
  }

  if (assumedBuckets.size > 0) {
    questions.push({
      id: 'times:confirm',
      type: 'times',
      severity: 'check',
      title: '這些班別的上下班時間對嗎？',
      detail: '時間用來算「哪天晚上你們都有空」，所以值得確認一次。',
      items: [...assumedBuckets.values()].map((b) => ({ key: b.key, code: b.code, def: b.def, people: b.people })),
    });
  }

  const order = { blocking: 0, check: 1 };
  questions.sort((a, b) => order[a.severity] - order[b.severity]);
  return dedupe(questions);
}

function dedupe(questions) {
  const seen = new Set();
  return questions.filter((q) => {
    if (seen.has(q.id)) return false;
    seen.add(q.id);
    return true;
  });
}

export function formatDays(days, month) {
  const list = [...days].sort((a, b) => a - b);
  const ranges = [];
  let start = null;
  let prev = null;
  for (const d of list) {
    if (start === null) {
      start = d;
    } else if (d !== prev + 1) {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = d;
    }
    prev = d;
  }
  if (start !== null) ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  const shown = ranges.slice(0, 6).join('、');
  const suffix = ranges.length > 6 ? ` 等 ${list.length} 天` : '';
  return `${month}/${shown}${suffix}`;
}

/** 把答案寫成字典條目（這就是「學會」的動作）。 */
export function learnShift(learned, key, def) {
  const k = normalizeCode(key || def.key);
  if (!k) return learned;
  const kind = def.kind === OFF ? OFF : WORK;
  return {
    ...learned,
    [k]: {
      key: k,
      label: (def.label || k).trim() || k,
      kind,
      start: kind === WORK ? def.start || '09:00' : null,
      end: kind === WORK ? def.end || '18:00' : null,
      hue: Number.isFinite(def.hue) ? def.hue : kind === WORK ? hueFromStart(def.start || '09:00') : 150,
      dayOffset: kind === WORK && Number.isFinite(def.dayOffset) ? def.dayOffset : 0,
      note: def.note || '',
    },
  };
}

export function forgetShift(learned, key) {
  const next = { ...learned };
  delete next[normalizeCode(key)];
  return next;
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

export { daysInMonth, isoDate };
