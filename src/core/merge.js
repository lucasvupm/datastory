// 合併兩個人的班表，算出共同休假、一起有空的時段、以及統計數字。
import { OFF, WORK } from './dict.js';
import { daysInMonth, isoDate, weekdayOf } from './parse.js';

export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

export const DEFAULT_SETTINGS = {
  awakeStart: '09:00',   // 一天從幾點算起才算「可以約」
  awakeEnd: '23:00',     // 到幾點為止
  commuteMinutes: 30,    // 上下班通勤緩衝
  sleepAfterNightHours: 6, // 大夜下班後要補眠幾小時
  minBlockMinutes: 120,  // 短於這個的空檔不算「約得起來」
};

export function toMinutes(hhmm) {
  if (!hhmm) return null;
  const m = String(hhmm).match(/^(\d{1,2}):?(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function fromMinutes(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function shiftDuration(def) {
  const s = toMinutes(def.start);
  const e = toMinutes(def.end);
  if (s === null || e === null) return 0;
  return ((e - s + 1440) % 1440) || 1440;
}

/** 把一個人整個月的「忙碌區間」攤平成以月初為原點的絕對分鐘數。 */
export function busyIntervals(schedule, settings = DEFAULT_SETTINGS) {
  const out = [];
  for (const [day, cell] of schedule.days) {
    const def = cell.def;
    if (!def || def.kind !== WORK) continue;
    const startMin = toMinutes(def.start);
    if (startMin === null) continue;
    const dur = shiftDuration(def);
    // dayOffset：班表上的日期是「上班那天」(0) 還是「下班那天」(1)。
    const anchorDay = day + (def.dayOffset || 0);
    let s = (anchorDay - 1) * 1440 + startMin - settings.commuteMinutes;
    let e = s + dur + settings.commuteMinutes * 2;
    // 下班時間落在深夜或清晨的話，下班後要補眠
    const endClock = (((startMin + dur) % 1440) + 1440) % 1440;
    if (endClock <= 10 * 60 || endClock >= 23 * 60) e += settings.sleepAfterNightHours * 60;
    out.push({ start: s, end: e, day, def });
  }
  return mergeIntervals(out);
}

export function mergeIntervals(list) {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ start: iv.start, end: iv.end });
  }
  return out;
}

function subtract(windows, busy) {
  let result = windows.map((w) => ({ ...w }));
  for (const b of busy) {
    const next = [];
    for (const w of result) {
      if (b.end <= w.start || b.start >= w.end) {
        next.push(w);
        continue;
      }
      if (b.start > w.start) next.push({ start: w.start, end: b.start });
      if (b.end < w.end) next.push({ start: b.end, end: w.end });
    }
    result = next;
  }
  return result.filter((w) => w.end > w.start);
}

function intersect(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (end > start) out.push({ start, end });
    if (a[i].end < b[j].end) i += 1;
    else j += 1;
  }
  return out;
}

/**
 * 合併兩人班表。
 * @param {object} a buildPersonSchedule 的結果
 * @param {object} b 同上（可為 null）
 */
export function mergeSchedules(a, b, period, settings = DEFAULT_SETTINGS) {
  const year = period.year;
  const month = period.month;
  const dayCount = daysInMonth(year, month);
  const awakeStart = toMinutes(settings.awakeStart) ?? 540;
  const awakeEnd = toMinutes(settings.awakeEnd) ?? 1380;

  // 只有兩邊都有資料的日子才算得出共同空檔；沒資料就不要假裝有空。
  const isKnown = (sched, d) => {
    const cell = sched?.days.get(d);
    return Boolean(cell && cell.def && (cell.def.kind === OFF || cell.def.kind === WORK));
  };
  const awakeWindows = [];
  for (let d = 1; d <= dayCount; d += 1) {
    if (!isKnown(a, d) || !isKnown(b, d)) continue;
    awakeWindows.push({ start: (d - 1) * 1440 + awakeStart, end: (d - 1) * 1440 + awakeEnd });
  }
  const freeA = subtract(awakeWindows, a ? busyIntervals(a, settings) : []);
  const freeB = subtract(awakeWindows, b ? busyIntervals(b, settings) : []);
  const commonFree = intersect(freeA, freeB).filter((w) => w.end - w.start >= settings.minBlockMinutes);

  const freeByDay = new Map();
  for (const w of commonFree) {
    const day = Math.floor(w.start / 1440) + 1;
    const list = freeByDay.get(day) || [];
    list.push({
      start: fromMinutes(w.start),
      end: fromMinutes(w.end),
      minutes: w.end - w.start,
    });
    freeByDay.set(day, list);
  }

  const days = [];
  for (let d = 1; d <= dayCount; d += 1) {
    const cellA = a?.days.get(d) || null;
    const cellB = b?.days.get(d) || null;
    const kindA = cellA?.def?.kind ?? null;
    const kindB = cellB?.def?.kind ?? null;
    const known = (x, cell) => (cell ? (x === OFF || x === WORK ? x : 'unknown') : 'none');
    const kA = known(kindA, cellA);
    const kB = known(kindB, cellB);
    let status;
    if (kA === 'none' || kB === 'none' || kA === 'unknown' || kB === 'unknown') status = 'unknown';
    else if (kA === OFF && kB === OFF) status = 'both-off';
    else if (kA === OFF || kB === OFF) status = 'one-off';
    else status = 'both-work';
    days.push({
      day: d,
      date: isoDate(year, month, d),
      weekday: weekdayOf(year, month, d),
      weekdayLabel: WEEKDAY_LABELS[weekdayOf(year, month, d)],
      a: cellA,
      b: cellB,
      status,
      free: freeByDay.get(d) || [],
    });
  }

  return {
    year,
    month,
    dayCount,
    days,
    stats: buildStats(days, settings),
    runs: bothOffRuns(days),
  };
}

function buildStats(days, settings) {
  const count = (cell, kind) => (cell?.def?.kind === kind ? 1 : 0);
  let workA = 0;
  let workB = 0;
  let offA = 0;
  let offB = 0;
  let bothOff = 0;
  let bothWork = 0;
  let unknown = 0;
  let eveningDates = [];
  let freeMinutes = 0;

  for (const d of days) {
    workA += count(d.a, WORK);
    workB += count(d.b, WORK);
    offA += count(d.a, OFF);
    offB += count(d.b, OFF);
    if (d.status === 'both-off') bothOff += 1;
    if (d.status === 'both-work') bothWork += 1;
    if (d.status === 'unknown') unknown += 1;
    for (const f of d.free) {
      freeMinutes += f.minutes;
      const startMin = toMinutes(f.start);
      const endMin = toMinutes(f.end);
      if (endMin > 17 * 60 && startMin < 23 * 60 && Math.min(endMin, 23 * 60) - Math.max(startMin, 17 * 60) >= settings.minBlockMinutes) {
        if (!eveningDates.includes(d.date)) eveningDates.push(d.date);
      }
    }
  }
  const runs = bothOffRuns(days);
  return {
    workA,
    workB,
    offA,
    offB,
    bothOff,
    bothWork,
    unknown,
    freeDays: days.filter((d) => d.free.length > 0).length,
    freeHours: Math.round((freeMinutes / 60) * 10) / 10,
    eveningDates,
    longestRun: runs.reduce((max, r) => Math.max(max, r.days.length), 0),
  };
}

/** 連續的共同休假（可以安排出遊的那種）。 */
export function bothOffRuns(days) {
  const runs = [];
  let current = null;
  for (const d of days) {
    if (d.status === 'both-off') {
      if (!current) {
        current = { days: [] };
        runs.push(current);
      }
      current.days.push(d);
    } else {
      current = null;
    }
  }
  return runs.map((r) => ({
    days: r.days,
    start: r.days[0],
    end: r.days[r.days.length - 1],
    length: r.days.length,
  }));
}
