// 班別字典：內建常見台灣班表代號，加上使用者教過的自訂代號。
// 每個班別定義 (ShiftDef)：
//   { key, label, kind: 'work' | 'off', start, end, hue, assumed, builtin }
//   start / end 為 "HH:MM"，kind 為 'off' 時兩者皆 null。
//   assumed=true 代表時間是我們猜的，App 應該找機會向使用者確認一次。

export const WORK = 'work';
export const OFF = 'off';

// 色相（0-360）依時段分配：清晨偏黃、午後偏橘、夜間偏紫藍、休假偏綠。
const BUILTIN_SHIFTS = [
  { label: '早班', kind: WORK, start: '08:00', end: '16:00', hue: 42, aliases: ['早', '早班', '白', '白班', '日', '日班', 'D', 'DAY', 'A', 'A班', '早A', 'am', 'AM'] },
  { label: '中班', kind: WORK, start: '12:00', end: '20:00', hue: 20, aliases: ['中', '中班', '午', '午班', 'M', 'MID'] },
  { label: '小夜', kind: WORK, start: '16:00', end: '00:00', hue: 282, aliases: ['小夜', '小夜班', '小', '晚', '晚班', 'E', 'EVE', 'B', 'B班', 'pm', 'PM'] },
  { label: '大夜', kind: WORK, start: '00:00', end: '08:00', hue: 232, aliases: ['大夜', '大夜班', '大', '夜', '夜班', 'N', 'NIGHT', 'C', 'C班'] },
  { label: '常日班', kind: WORK, start: '08:00', end: '17:00', hue: 58, aliases: ['常日', '常日班', '行政', '行政班', 'G', 'G1', 'OFFICE'] },
  { label: '開店班', kind: WORK, start: '09:00', end: '18:00', hue: 36, aliases: ['開', '開店', '開班', 'OPEN'] },
  { label: '關店班', kind: WORK, start: '13:00', end: '22:00', hue: 300, aliases: ['關', '關店', '關班', 'CLOSE'] },
  { label: '全天班', kind: WORK, start: '08:00', end: '20:00', hue: 4, aliases: ['全', '全天', '長班', '長', 'F', 'FULL'] },
  { label: '半天班', kind: WORK, start: '09:00', end: '13:00', hue: 70, aliases: ['半', '半班', '半天', 'H', 'HALF'] },
  { label: '上班', kind: WORK, start: '09:00', end: '18:00', hue: 14, aliases: ['班', '上', '上班', 'W', 'WORK', 'V'] },

  { label: '休假', kind: OFF, aliases: ['休', '休假', 'O', 'OF', 'OFF', 'X', '×', '✕', '-', '–', '—', '/', '／', 'R', 'REST', '空'] },
  { label: '例假', kind: OFF, aliases: ['例', '例假', '例休'] },
  { label: '國定假日', kind: OFF, aliases: ['國', '國定', '國假', '節', '節日', 'HOL'] },
  { label: '特休', kind: OFF, aliases: ['特', '特休', '年假', '年休'] },
  { label: '補休', kind: OFF, aliases: ['補', '補休', '補假'] },
  { label: '病假', kind: OFF, aliases: ['病', '病假', 'S', 'SICK'] },
  { label: '事假', kind: OFF, aliases: ['事', '事假'] },
  { label: '產檢/家庭', kind: OFF, aliases: ['家', '家庭', '陪產', '產檢'] },
];

// 數字代號（1/2/3）在很多醫院班表代表早/小夜/大夜，但也可能是日期，
// 所以標成 ambiguous，解析後一定要問一次。
const NUMERIC_SHIFTS = [
  { label: '早班', code: '1', kind: WORK, start: '08:00', end: '16:00', hue: 42 },
  { label: '小夜', code: '2', kind: WORK, start: '16:00', end: '00:00', hue: 282 },
  { label: '大夜', code: '3', kind: WORK, start: '00:00', end: '08:00', hue: 232 },
  { label: '休假', code: '0', kind: OFF, hue: 150 },
];

const FULLWIDTH_OFFSET = 0xfee0;

/** 全形轉半形、去空白、英文轉大寫，給字典查詢用。 */
export function normalizeCode(raw) {
  if (raw == null) return '';
  let s = String(raw);
  s = s.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - FULLWIDTH_OFFSET));
  s = s.replace(/　/g, ' ');
  s = s.replace(/[\s​]+/g, '');
  s = s.replace(/[（）()【】\[\]「」]/g, '');
  return s.toUpperCase();
}

/** 查字典時依序嘗試的幾種寫法：原樣、去掉「班」、去掉「假」。 */
export function lookupKeys(raw) {
  const base = normalizeCode(raw);
  const keys = [base];
  if (base.length > 1 && base.endsWith('班')) keys.push(base.slice(0, -1));
  if (base.length > 1 && base.endsWith('假')) keys.push(base.slice(0, -1));
  if (base.length > 1 && base.endsWith('休')) keys.push(base.slice(0, -1));
  return keys.filter((k, i) => k && keys.indexOf(k) === i);
}

/** 建內建字典：alias -> ShiftDef。 */
export function builtinDictionary() {
  const dict = {};
  for (const shift of BUILTIN_SHIFTS) {
    for (const alias of shift.aliases) {
      const key = normalizeCode(alias);
      if (!key || dict[key]) continue;
      dict[key] = {
        key,
        label: shift.label,
        kind: shift.kind,
        start: shift.kind === WORK ? shift.start : null,
        end: shift.kind === WORK ? shift.end : null,
        hue: shift.hue ?? 150,
        assumed: shift.kind === WORK,
        builtin: true,
        ambiguous: false,
      };
    }
  }
  for (const shift of NUMERIC_SHIFTS) {
    const key = normalizeCode(shift.code);
    dict[key] = {
      key,
      label: shift.label,
      kind: shift.kind,
      start: shift.kind === WORK ? shift.start : null,
      end: shift.kind === WORK ? shift.end : null,
      hue: shift.hue,
      assumed: true,
      builtin: true,
      ambiguous: true,
    };
  }
  return dict;
}

/** 內建字典 + 學過的字典（學過的優先）。 */
export function mergeDictionary(learned = {}) {
  const dict = builtinDictionary();
  for (const [rawKey, def] of Object.entries(learned)) {
    const key = normalizeCode(rawKey);
    if (!key || !def) continue;
    dict[key] = { ...def, key, builtin: false, assumed: false };
  }
  return dict;
}

export function resolveCode(dict, raw) {
  for (const key of lookupKeys(raw)) {
    if (dict[key]) return dict[key];
  }
  return null;
}

const OFF_HINTS = ['休', '假', '例', '放', 'OFF', 'REST', '排休'];
const TIME_HINTS = [
  { re: /(早|白|日|晨|MORN|^A)/, start: '08:00', end: '16:00', label: '早班', hue: 42 },
  { re: /(中|午|MID|^M)/, start: '12:00', end: '20:00', label: '中班', hue: 20 },
  { re: /(小夜|晚|EVE|^E|^B)/, start: '16:00', end: '00:00', label: '小夜', hue: 282 },
  { re: /(大夜|夜|NIGHT|^N|^C)/, start: '00:00', end: '08:00', label: '大夜', hue: 232 },
  { re: /(長|全|FULL|^F)/, start: '08:00', end: '20:00', label: '全天班', hue: 4 },
];

/**
 * 猜一個沒見過的代號可能是什麼班，用來當詢問卡的預設值。
 * 回傳 ShiftDef 草稿（guess=true），絕不直接寫進字典。
 */
export function guessShift(raw, dict = {}) {
  const key = normalizeCode(raw);
  const base = { key, label: key || '未知班別', kind: WORK, start: '09:00', end: '18:00', hue: 14, guess: true, assumed: true };

  const timeRange = parseTimeRangeCode(key);
  if (timeRange) return { ...base, ...timeRange, label: timeRange.label || key };

  if (OFF_HINTS.some((h) => key.includes(h))) {
    return { ...base, kind: OFF, start: null, end: null, hue: 150, label: key || '休假' };
  }
  for (const hint of TIME_HINTS) {
    if (hint.re.test(key)) {
      return { ...base, kind: WORK, start: hint.start, end: hint.end, hue: hint.hue, label: key.length <= 2 ? hint.label : key };
    }
  }
  // 跟字典裡已知代號只差一個字，就借用它的時間（例如 G2 借 G1）。
  const neighbour = nearestKnown(key, dict);
  if (neighbour) {
    return { ...base, kind: neighbour.kind, start: neighbour.start, end: neighbour.end, hue: (neighbour.hue + 24) % 360, label: key, borrowedFrom: neighbour.key };
  }
  return base;
}

/** "0800-1700"、"8-17"、"08:00~17:00" 這類代號直接讀出時間。 */
export function parseTimeRangeCode(key) {
  const m = key.match(/^(\d{1,2})(?::?(\d{2}))?\s*[-~–—至到]\s*(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return null;
  const h1 = Number(m[1]);
  const h2 = Number(m[3]);
  if (h1 > 24 || h2 > 24) return null;
  const start = `${String(h1 % 24).padStart(2, '0')}:${m[2] ?? '00'}`;
  const end = `${String(h2 % 24).padStart(2, '0')}:${m[4] ?? '00'}`;
  return { kind: WORK, start, end, hue: hueFromStart(start), label: `${start}-${end}` };
}

export function hueFromStart(start) {
  const h = Number(String(start).slice(0, 2)) || 0;
  return Math.round((h / 24) * 300 + 20) % 360;
}

function nearestKnown(key, dict) {
  if (!key) return null;
  let best = null;
  for (const def of Object.values(dict)) {
    if (!def || !def.key) continue;
    const d = editDistance(key, def.key);
    if (d === 1 && (!best || def.key.length > best.key.length)) best = def;
  }
  return best;
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 9;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}
