// 匯出：行事曆 (.ics)、貼到 LINE 的純文字、以及設定備份。
import { WORK, OFF } from './dict.js';
import { toMinutes, fromMinutes, shiftDuration, WEEKDAY_LABELS } from './merge.js';

function pad(n) {
  return String(n).padStart(2, '0');
}

function icsDate(year, month, day) {
  return `${year}${pad(month)}${pad(day)}`;
}

function icsDateTime(year, month, day, minutes) {
  const base = Date.UTC(year, month - 1, day) + minutes * 60000;
  const d = new Date(base);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`;
}

function escapeIcs(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function fold(line) {
  if (line.length <= 73) return line;
  const chunks = [line.slice(0, 73)];
  let rest = line.slice(73);
  while (rest.length > 72) {
    chunks.push(` ${rest.slice(0, 72)}`);
    rest = rest.slice(72);
  }
  if (rest) chunks.push(` ${rest}`);
  return chunks.join('\r\n');
}

let uidCounter = 0;
function uid(prefix) {
  uidCounter += 1;
  return `${prefix}-${uidCounter}-${Date.now().toString(36)}@gongtongbanbiao`;
}

/**
 * @param {object} merged mergeSchedules 的結果
 * @param {object} opts { names:{a,b}, include:{shiftsA, shiftsB, bothOff, freeSlots} }
 */
export function buildIcs(merged, opts = {}) {
  const names = opts.names || { a: '我', b: '對方' };
  const include = { shiftsA: true, shiftsB: true, bothOff: true, freeSlots: true, ...(opts.include || {}) };
  const { year, month } = merged;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//共同班表//ZH-TW//',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcs(`共同班表 ${year}/${pad(month)}`)}`,
  ];
  const stamp = icsDateTime(year, month, 1, 0);

  const pushShift = (day, cell, who, enabled) => {
    if (!enabled || !cell?.def || cell.def.kind !== WORK) return;
    const startMin = toMinutes(cell.def.start);
    if (startMin === null) return;
    const anchorDay = day + (cell.def.dayOffset || 0);
    const dur = shiftDuration(cell.def);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid('shift')}`,
      `DTSTAMP:${stamp}Z`,
      `SUMMARY:${escapeIcs(`${who} ${cell.def.label}`)}`,
      `DTSTART:${icsDateTime(year, month, anchorDay, startMin)}`,
      `DTEND:${icsDateTime(year, month, anchorDay, startMin + dur)}`,
      `DESCRIPTION:${escapeIcs(`班表代號：${cell.code}`)}`,
      'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  };

  for (const d of merged.days) {
    pushShift(d.day, d.a, names.a, include.shiftsA);
    pushShift(d.day, d.b, names.b, include.shiftsB);
  }

  if (include.bothOff) {
    for (const run of merged.runs) {
      const start = run.start.day;
      const endExclusive = run.end.day + 1;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${uid('bothoff')}`,
        `DTSTAMP:${stamp}Z`,
        `SUMMARY:${escapeIcs(run.length > 1 ? `一起休假 ${run.length} 天` : '一起休假')}`,
        `DTSTART;VALUE=DATE:${icsDate(year, month, start)}`,
        `DTEND;VALUE=DATE:${icsDate(year, month, endExclusive)}`,
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
      );
    }
  }

  if (include.freeSlots) {
    for (const d of merged.days) {
      if (d.status === 'both-off') continue; // 整天都有空就不用再排時段
      for (const f of d.free) {
        lines.push(
          'BEGIN:VEVENT',
          `UID:${uid('free')}`,
          `DTSTAMP:${stamp}Z`,
          `SUMMARY:${escapeIcs(`都有空 ${f.start}-${f.end}`)}`,
          `DTSTART:${icsDateTime(year, month, d.day, toMinutes(f.start))}`,
          `DTEND:${icsDateTime(year, month, d.day, toMinutes(f.end))}`,
          'TRANSP:TRANSPARENT',
          'END:VEVENT',
        );
      }
    }
  }

  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n');
}

/** 可以直接貼到 LINE 的摘要。 */
export function buildTextSummary(merged, opts = {}) {
  const names = opts.names || { a: '我', b: '對方' };
  const { year, month, stats } = merged;
  const out = [];
  out.push(`${year} 年 ${month} 月 共同班表`);
  out.push(`${names.a} 上班 ${stats.workA} 天 ・ ${names.b} 上班 ${stats.workB} 天`);
  out.push('');

  const label = (d) => `${month}/${d.day}（${d.weekdayLabel}）`;

  if (merged.runs.length > 0) {
    out.push(`[一起休假] ${stats.bothOff} 天`);
    for (const run of merged.runs) {
      out.push(run.length > 1
        ? `  ${label(run.start)} ~ ${label(run.end)}　連休 ${run.length} 天`
        : `  ${label(run.start)}`);
    }
    out.push('');
  } else {
    out.push('[一起休假] 這個月沒有重疊的休假日');
    out.push('');
  }

  const slots = merged.days.filter((d) => d.status !== 'both-off' && d.free.length > 0);
  if (slots.length > 0) {
    out.push(`[有空檔的日子] ${slots.length} 天`);
    for (const d of slots) {
      out.push(`  ${label(d)} ${d.free.map((f) => `${f.start}-${f.end}`).join('、')}`);
    }
    out.push('');
  }

  const noOverlap = merged.days.filter((d) => d.status === 'both-work' && d.free.length === 0);
  if (noOverlap.length > 0) {
    out.push(`[完全對不上] ${noOverlap.map((d) => `${month}/${d.day}`).join('、')}`);
    out.push('');
  }

  if (stats.unknown > 0) {
    const missing = merged.days.filter((d) => d.status === 'unknown').map((d) => `${month}/${d.day}`);
    out.push(`[還沒有資料] ${missing.join('、')}`);
  }
  return out.join('\n').trim();
}

/** 整份設定備份，可以傳給另一半匯入，字典就同步了。 */
export function buildBackup(state) {
  return JSON.stringify({
    app: '共同班表',
    version: 1,
    exportedAt: new Date().toISOString(),
    people: state.people,
    learned: state.learned,
    settings: state.settings,
    period: state.period,
  }, null, 2);
}

export function parseBackup(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object') throw new Error('檔案看起來不是共同班表的備份');
  if (!data.people && !data.learned) throw new Error('備份裡找不到班表或班別字典');
  return data;
}

export { WEEKDAY_LABELS, OFF };
