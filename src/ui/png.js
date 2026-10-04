// 把共同班表畫成一張圖，方便直接傳給對方。
// 固定用淺色配色，貼到 LINE 比較好看。
import { WORK, OFF } from '../core/dict.js';
import { toMinutes, shiftDuration, WEEKDAY_LABELS } from '../core/merge.js';

const PALETTE = {
  bg: '#f3f5f3',
  surface: '#ffffff',
  ink: '#171b1a',
  inkDim: '#5a635f',
  inkFaint: '#9aa29c',
  rule: '#d8ded8',
  a: '#c14a28',
  b: '#15705f',
  gold: '#a7761a',
  goldSoft: '#f6ecd3',
};

export async function renderPng(merged, names, opts = {}) {
  const scale = opts.scale || 2;
  const pad = 28;
  const cellW = 136;
  const cellH = 104;
  const headerH = 104;
  const dowH = 26;
  const lead = merged.days[0].weekday;
  const rows = Math.ceil((lead + merged.dayCount) / 7);
  const gap = 6;
  const width = pad * 2 + cellW * 7 + gap * 6;
  const footerH = 86;
  const height = headerH + dowH + rows * (cellH + gap) + footerH + pad;

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const sans = '"Noto Sans TC", "PingFang TC", sans-serif';
  const serif = '"Noto Serif TC", serif';
  const mono = '"IBM Plex Mono", monospace';

  try {
    if (document.fonts?.ready) await document.fonts.ready;
  } catch { /* 字型沒載到就用系統字 */ }

  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, width, height);

  // 標頭
  ctx.fillStyle = PALETTE.ink;
  ctx.font = `700 34px ${serif}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${merged.year} 年 ${merged.month} 月　共同班表`, pad, pad + 32);
  ctx.font = `400 15px ${sans}`;
  ctx.fillStyle = PALETTE.inkDim;
  const s = merged.stats;
  ctx.fillText(`一起休假 ${s.bothOff} 天　最長連休 ${s.longestRun} 天　共同空檔 ${s.freeDays} 天 / ${s.freeHours} 小時`, pad, pad + 58);

  // 圖例
  let lx = pad;
  const ly = pad + 80;
  for (const [key, label] of [['a', `${names.a}上班`], ['b', `${names.b}上班`], ['gold', '都有空']]) {
    ctx.fillStyle = PALETTE[key];
    ctx.fillRect(lx, ly - 7, 18, key === 'gold' ? 3 : 7);
    ctx.fillStyle = PALETTE.inkDim;
    ctx.font = `400 13px ${sans}`;
    ctx.fillText(label, lx + 24, ly);
    lx += 24 + ctx.measureText(label).width + 22;
  }

  // 星期列
  ctx.font = `500 12px ${mono}`;
  ctx.textAlign = 'center';
  for (let i = 0; i < 7; i += 1) {
    ctx.fillStyle = i >= 5 ? PALETTE.a : PALETTE.inkFaint;
    ctx.fillText(WEEKDAY_LABELS[i], pad + i * (cellW + gap) + cellW / 2, headerH + 16);
  }
  ctx.textAlign = 'left';

  // 日格
  const gridTop = headerH + dowH;
  for (const d of merged.days) {
    const idx = lead + d.day - 1;
    const col = idx % 7;
    const row = Math.floor(idx / 7);
    const x = pad + col * (cellW + gap);
    const y = gridTop + row * (cellH + gap);

    roundRect(ctx, x, y, cellW, cellH, 10);
    ctx.fillStyle = d.status === 'both-off' ? PALETTE.goldSoft : PALETTE.surface;
    ctx.fill();
    ctx.strokeStyle = d.status === 'both-off' ? '#d8bd7e' : PALETTE.rule;
    ctx.lineWidth = 1;
    ctx.stroke();

    if (d.status === 'unknown') {
      ctx.save();
      roundRect(ctx, x, y, cellW, cellH, 10);
      ctx.clip();
      ctx.strokeStyle = PALETTE.rule;
      ctx.lineWidth = 1;
      for (let o = -cellH; o < cellW; o += 7) {
        ctx.beginPath();
        ctx.moveTo(x + o, y + cellH);
        ctx.lineTo(x + o + cellH, y);
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.fillStyle = d.weekday >= 5 ? PALETTE.a : PALETTE.ink;
    ctx.font = `600 16px ${mono}`;
    ctx.fillText(String(d.day), x + 10, y + 24);
    if (d.status === 'both-off') {
      ctx.fillStyle = PALETTE.gold;
      ctx.font = `600 11px ${sans}`;
      ctx.textAlign = 'right';
      ctx.fillText('一起休', x + cellW - 10, y + 23);
      ctx.textAlign = 'left';
    }

    let ty = y + 46;
    for (const who of ['a', 'b']) {
      const cell = d[who];
      const def = cell?.def;
      ctx.font = `500 13px ${sans}`;
      ctx.fillStyle = def ? (def.kind === WORK ? PALETTE[who] : PALETTE.inkFaint) : PALETTE.inkFaint;
      const text = !cell ? '—' : def ? def.label : `${cell.code}?`;
      ctx.fillText(clip(ctx, text, cellW - 20), x + 10, ty);
      ty += 18;
    }

    // 24 小時軸
    const axisX = x + 10;
    const axisW = cellW - 20;
    let ay = y + cellH - 20;
    for (const who of ['a', 'b']) {
      ctx.fillStyle = PALETTE.rule;
      roundRect(ctx, axisX, ay, axisW, 3, 1.5);
      ctx.fill();
      const def = d[who]?.def;
      if (def && def.kind === WORK) {
        const start = toMinutes(def.start);
        if (start !== null) {
          const dur = Math.min(shiftDuration(def), 1440 - start);
          ctx.fillStyle = PALETTE[who];
          roundRect(ctx, axisX + (start / 1440) * axisW, ay, Math.max(2, (dur / 1440) * axisW), 3, 1.5);
          ctx.fill();
        }
      }
      ay += 5;
    }
    for (const f of d.free) {
      const fs = toMinutes(f.start);
      const fe = toMinutes(f.end) || 1440;
      ctx.fillStyle = PALETTE.gold;
      roundRect(ctx, axisX + (fs / 1440) * axisW, ay + 1, Math.max(2, ((fe - fs) / 1440) * axisW), 2, 1);
      ctx.fill();
    }
  }

  // 頁尾：連休摘要
  const footY = gridTop + rows * (cellH + gap) + 18;
  ctx.fillStyle = PALETTE.ink;
  ctx.font = `700 15px ${serif}`;
  ctx.fillText('一起休假', pad, footY);
  ctx.font = `400 13px ${sans}`;
  ctx.fillStyle = PALETTE.inkDim;
  const runText = merged.runs.length
    ? merged.runs.map((r) => (r.length > 1 ? `${merged.month}/${r.start.day}–${r.end.day}（${r.length} 天）` : `${merged.month}/${r.start.day}`)).join('　')
    : '這個月沒有重疊的休假日';
  ctx.fillText(clip(ctx, runText, width - pad * 2), pad, footY + 22);
  ctx.fillStyle = PALETTE.inkFaint;
  ctx.font = `400 11px ${mono}`;
  ctx.fillText('共同班表', pad, footY + 46);

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function clip(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}

export { OFF };
