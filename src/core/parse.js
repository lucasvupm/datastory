// 班表解析：同一份文字會用好幾種版型去試，挑最有把握的那個，
// 其餘保留成 alternates，讓使用者可以手動換一種解讀方式。
import { normalizeCode, mergeDictionary, resolveCode, parseTimeRangeCode } from './dict.js';

const WEEKDAY_ORDER = ['一', '二', '三', '四', '五', '六', '日'];
const WEEKDAY_ALIASES = { 天: '日', MON: '一', TUE: '二', WED: '三', THU: '四', FRI: '五', SAT: '六', SUN: '日' };

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function weekdayOf(year, month, day) {
  // 0 = 週一 … 6 = 週日
  const js = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (js + 6) % 7;
}

function toHalfWidth(text) {
  return String(text)
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/[～〜]/g, '~')
    .replace(/[–—−]/g, '-');
}

export function splitLines(text) {
  return toHalfWidth(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function tokenize(line) {
  return line
    .split(/[\s,，、|；;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function stripWeekday(text) {
  return text
    .replace(/[（(【\[]?\s*(週|星期|禮拜)?[一二三四五六日天]\s*[）)】\]]?/g, (m) => (/[（(【\[]/.test(m) || /週|星期|禮拜/.test(m) ? '' : m))
    .replace(/\b(MON|TUE|WED|THU|FRI|SAT|SUN)[A-Z]*\b/gi, '')
    .trim();
}

function isWeekdayRow(tokens) {
  if (tokens.length < 3) return false;
  const letters = tokens.map((t) => {
    const clean = normalizeCode(t).replace(/^(週|星期|禮拜)/, '');
    return WEEKDAY_ALIASES[clean] || clean;
  });
  if (!letters.every((l) => WEEKDAY_ORDER.includes(l))) return false;
  const startIdx = WEEKDAY_ORDER.indexOf(letters[0]);
  return letters.every((l, i) => l === WEEKDAY_ORDER[(startIdx + i) % 7]);
}

function isHeaderRow(tokens) {
  const joined = tokens.join('');
  return /^(日期|date|星期|班別|班表|shift|姓名|name)/i.test(joined) && tokens.length <= 4;
}

function asDayNumber(token) {
  const m = normalizeCode(token).match(/^(\d{1,2})(日|TH|ST|ND|RD)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 31 ? n : null;
}

function isNumberRow(tokens) {
  if (tokens.length < 3) return false;
  const nums = tokens.map(asDayNumber);
  if (nums.some((n) => n === null)) return false;
  for (let i = 1; i < nums.length; i += 1) {
    if (nums[i] !== nums[i - 1] + 1) return false;
  }
  return true;
}

// ---------------------------------------------------------------- 年月偵測

const MONTH_PATTERNS = [
  /(20\d{2})\s*[年\/\-\.]\s*(\d{1,2})\s*月?/,
  /(\d{1,2})\s*月份?/,
];

export function detectMonth(text, today = new Date()) {
  const flat = toHalfWidth(text);
  for (const re of MONTH_PATTERNS) {
    const m = flat.match(re);
    if (!m) continue;
    if (m.length === 3 && m[1].length === 4) {
      const month = Number(m[2]);
      if (month >= 1 && month <= 12) return { year: Number(m[1]), month, source: 'text' };
    } else {
      const month = Number(m[1]);
      if (month >= 1 && month <= 12) return { year: inferYear(month, today), month, source: 'text-month-only' };
    }
  }
  // 退而求其次：看有沒有一堆 10/1 10/2 這種日期
  const slash = [...flat.matchAll(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/g)];
  if (slash.length >= 2) {
    const counts = new Map();
    for (const m of slash) {
      const mm = Number(m[1]);
      if (mm >= 1 && mm <= 12) counts.set(mm, (counts.get(mm) || 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) return { year: inferYear(best[0], today), month: best[0], source: 'dates' };
  }
  return null;
}

export function inferYear(month, today = new Date()) {
  const y = today.getFullYear();
  const m = today.getMonth() + 1;
  if (month < m - 6) return y + 1;
  if (month > m + 6) return y - 1;
  return y;
}

// ---------------------------------------------------------------- 版型 1：每行一個日期

// 前後加邊界，否則 "0800-1700" 裡的 "00-17" 會被誤認成日期。
const DATE_IN_LINE = /(^|[^\d:\-~])(?:(20\d{2})\s*[年\/\-\.]\s*)?(\d{1,2})\s*[\/\-\.月]\s*(\d{1,2})(?![\d:])\s*日?/g;

function layoutDated(lines) {
  const entries = [];
  let matchedLines = 0;
  for (const line of lines) {
    const found = [...line.matchAll(DATE_IN_LINE)];
    if (found.length === 0) continue;
    let used = false;
    for (let i = 0; i < found.length; i += 1) {
      const m = found[i];
      const month = Number(m[3]);
      const day = Number(m[4]);
      if (month < 1 || month > 12 || day < 1 || day > 31) continue;
      const sliceEnd = i + 1 < found.length ? found[i + 1].index + found[i + 1][1].length : line.length;
      const rest = stripWeekday(line.slice(m.index + m[0].length, sliceEnd));
      const code = cleanCode(rest);
      if (!code) continue;
      entries.push({ day, month, year: m[2] ? Number(m[2]) : null, code, raw: line.trim() });
      used = true;
    }
    if (used) matchedLines += 1;
  }
  const confidence = lines.length ? Math.min(1, (matchedLines / lines.length) * 1.1) : 0;
  return { layout: 'dated', name: '每行一天（有日期）', entries, confidence, notes: [] };
}

// ---------------------------------------------------------------- 版型 2：兩欄（日期 / 班別）

function layoutTwoColumn(lines) {
  const entries = [];
  let matched = 0;
  for (const line of lines) {
    const tokens = tokenize(line);
    if (tokens.length < 2 || tokens.length > 3) continue;
    if (isHeaderRow(tokens)) continue;
    const day = asDayNumber(tokens[0]);
    if (day === null) continue;
    const rest = cleanCode(stripWeekday(tokens.slice(1).join(' ')));
    if (!rest || asDayNumber(rest) !== null) continue;
    entries.push({ day, month: null, year: null, code: rest, raw: line.trim() });
    matched += 1;
  }
  const confidence = lines.length ? Math.min(1, (matched / lines.length) * 1.05) : 0;
  return { layout: 'twoColumn', name: '兩欄（日 + 班別）', entries, confidence, notes: [] };
}

// ---------------------------------------------------------------- 版型 3：表格（日期列 + 班別列）

function layoutGrid(lines) {
  const entries = [];
  const notes = [];
  let pairs = 0;
  const rows = lines.map(tokenize);
  for (let i = 0; i < rows.length; i += 1) {
    if (!isNumberRow(rows[i])) continue;
    let j = i + 1;
    while (j < rows.length && (isWeekdayRow(rows[j]) || isHeaderRow(rows[j]))) j += 1;
    if (j >= rows.length || isNumberRow(rows[j])) continue;
    const days = rows[i].map(asDayNumber);
    const codes = rows[j];
    if (codes.length !== days.length) {
      notes.push(`第 ${i + 1} 列有 ${days.length} 天，但班別只有 ${codes.length} 格，多出來的會被當成沒資料。`);
    }
    const n = Math.min(days.length, codes.length);
    for (let k = 0; k < n; k += 1) {
      const code = cleanCode(codes[k]);
      if (!code) continue;
      entries.push({ day: days[k], month: null, year: null, code, raw: `${days[k]} → ${codes[k]}` });
    }
    pairs += 1;
    i = j;
  }
  const confidence = pairs === 0 ? 0 : Math.min(0.98, 0.6 + pairs * 0.12);
  return { layout: 'grid', name: '表格（日期一列、班別一列）', entries, confidence, notes };
}

// ---------------------------------------------------------------- 版型 4：班別 → 日期清單

function layoutCodeToDays(lines) {
  const entries = [];
  let matched = 0;
  for (const line of lines) {
    const m = line.match(/^(.{1,8}?)\s*[:：]\s*(.+)$/);
    const head = m ? m[1] : null;
    const tail = m ? m[2] : null;
    if (!head || !tail) continue;
    const code = cleanCode(head);
    if (!code || asDayNumber(code) !== null) continue;
    const days = tokenize(tail).map(asDayNumber).filter((d) => d !== null);
    const expanded = days.length >= 2 ? days : expandRanges(tail);
    if (expanded.length < 2) continue;
    for (const day of expanded) entries.push({ day, month: null, year: null, code, raw: line.trim() });
    matched += 1;
  }
  const confidence = matched >= 2 ? Math.min(0.95, 0.55 + matched * 0.1) : 0;
  return { layout: 'codeToDays', name: '班別：日期清單', entries, confidence, notes: [] };
}

function expandRanges(text) {
  const out = [];
  for (const part of text.split(/[,，、\s]+/)) {
    const m = part.match(/^(\d{1,2})\s*[-~]\s*(\d{1,2})$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a >= 1 && b <= 31 && a <= b) for (let d = a; d <= b; d += 1) out.push(d);
      continue;
    }
    const day = asDayNumber(part);
    if (day !== null) out.push(day);
  }
  return out;
}

// ---------------------------------------------------------------- 版型 5：純代號序列

function layoutSequence(lines, expectedDays) {
  const tokens = [];
  for (const line of lines) {
    const row = tokenize(line);
    if (isWeekdayRow(row) || isNumberRow(row) || isHeaderRow(row)) continue;
    for (const t of row) {
      const code = cleanCode(t);
      if (code) tokens.push(code);
    }
  }
  if (tokens.length < 7) return { layout: 'sequence', name: '純代號序列', entries: [], confidence: 0, notes: [] };
  const entries = tokens.slice(0, 31).map((code, i) => ({ day: i + 1, month: null, year: null, code, raw: code }));
  const fit = expectedDays ? 1 - Math.min(1, Math.abs(tokens.length - expectedDays) / expectedDays) : 0.5;
  const confidence = Math.max(0, Math.min(0.75, fit * 0.75));
  const notes = expectedDays && tokens.length !== expectedDays
    ? [`抓到 ${tokens.length} 個代號，但這個月有 ${expectedDays} 天，數量對不上。`]
    : [];
  return { layout: 'sequence', name: '純代號序列（從 1 號開始排）', entries, confidence, notes };
}

function cleanCode(text) {
  let s = toHalfWidth(String(text || '')).trim();
  s = s.replace(/^[:：=\-\s]+/, '').replace(/[,，、。;；]+$/, '').trim();
  if (!s) return '';
  if (s.length > 12) s = s.slice(0, 12);
  return s;
}

/** 代號本身就寫著時間（0800-1700），那就不必問了。 */
export function deriveFromTimeRange(code) {
  const range = parseTimeRangeCode(normalizeCode(code));
  if (!range) return null;
  return { key: normalizeCode(code), ...range, assumed: false, builtin: false, ambiguous: false, derived: true };
}

// ---------------------------------------------------------------- 主入口

/**
 * @param {string} text 使用者貼上的原始班表
 * @param {object} opts { year, month, learned, today, layout }
 */
export function parseSchedule(text, opts = {}) {
  const lines = splitLines(text || '');
  const today = opts.today || new Date();
  const detected = detectMonth(text || '', today);
  const year = opts.year ?? detected?.year ?? today.getFullYear();
  const month = opts.month ?? detected?.month ?? today.getMonth() + 1;
  const dayCount = daysInMonth(year, month);

  const candidates = [
    layoutDated(lines),
    layoutTwoColumn(lines),
    layoutGrid(lines),
    layoutCodeToDays(lines),
    layoutSequence(lines, dayCount),
  ].filter((c) => c.entries.length > 0);

  candidates.sort((a, b) => b.confidence - a.confidence || b.entries.length - a.entries.length);
  const chosen = opts.layout ? candidates.find((c) => c.layout === opts.layout) || candidates[0] : candidates[0];

  const dict = mergeDictionary(opts.learned || {});
  const result = {
    year,
    month,
    dayCount,
    monthSource: opts.month ? 'user' : detected?.source || 'guess',
    detected: detected || null,
    layout: chosen?.layout || null,
    layoutName: chosen?.name || null,
    confidence: chosen?.confidence || 0,
    alternates: candidates.filter((c) => c !== chosen).map((c) => ({ layout: c.layout, name: c.name, count: c.entries.length, confidence: c.confidence })),
    notes: chosen?.notes ? [...chosen.notes] : [],
    entries: [],
    conflicts: [],
    unknownCodes: [],
    ambiguousCodes: [],
    assumedCodes: [],
    missingDays: [],
    extraDays: [],
    otherMonths: [],
    lineCount: lines.length,
  };
  if (!chosen) return result;

  const byDay = new Map();
  for (const raw of chosen.entries) {
    if (raw.day < 1 || raw.day > dayCount) {
      if (!result.extraDays.includes(raw.day)) result.extraDays.push(raw.day);
      continue;
    }
    if (raw.month && raw.month !== month) {
      if (!result.otherMonths.includes(raw.month)) result.otherMonths.push(raw.month);
      continue;
    }
    const prev = byDay.get(raw.day);
    if (prev && normalizeCode(prev.code) !== normalizeCode(raw.code)) {
      const conflict = result.conflicts.find((c) => c.day === raw.day);
      if (conflict) {
        if (!conflict.codes.includes(raw.code)) conflict.codes.push(raw.code);
      } else {
        result.conflicts.push({ day: raw.day, codes: [prev.code, raw.code] });
      }
      continue;
    }
    byDay.set(raw.day, raw);
  }

  const unknown = new Map();
  const ambiguous = new Map();
  const assumed = new Map();
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const raw = byDay.get(day);
    const def = resolveCode(dict, raw.code) || deriveFromTimeRange(raw.code);
    result.entries.push({
      date: isoDate(year, month, day),
      day,
      code: raw.code,
      normalized: normalizeCode(raw.code),
      def: def || null,
      raw: raw.raw,
    });
    const key = normalizeCode(raw.code);
    if (!def) {
      if (!unknown.has(key)) unknown.set(key, { code: raw.code, key, days: [] });
      unknown.get(key).days.push(day);
    } else {
      if (def.ambiguous) {
        if (!ambiguous.has(key)) ambiguous.set(key, { code: raw.code, key, def, days: [] });
        ambiguous.get(key).days.push(day);
      }
      if (def.assumed && !def.ambiguous) {
        if (!assumed.has(key)) assumed.set(key, { code: raw.code, key, def, days: [] });
        assumed.get(key).days.push(day);
      }
    }
  }
  result.unknownCodes = [...unknown.values()];
  result.ambiguousCodes = [...ambiguous.values()];
  result.assumedCodes = [...assumed.values()];
  for (let d = 1; d <= dayCount; d += 1) if (!byDay.has(d)) result.missingDays.push(d);
  return result;
}
