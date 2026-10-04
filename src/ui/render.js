// 畫面產生：月曆、清單、統計、問題卡、班別字典。
// 全部回傳 HTML 字串，事件用委派處理（see app.js）。
import { WORK, OFF } from '../core/dict.js';
import { toMinutes, shiftDuration, WEEKDAY_LABELS } from '../core/merge.js';

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function barStyle(def) {
  const start = toMinutes(def.start);
  if (start === null) return null;
  const dur = Math.min(shiftDuration(def), 1440 - start);
  return `--s:${((start / 1440) * 100).toFixed(2)}%;--w:${((dur / 1440) * 100).toFixed(2)}%`;
}

function freeStyle(slot) {
  const s = toMinutes(slot.start);
  const e = toMinutes(slot.end) || 1440;
  return `--s:${((s / 1440) * 100).toFixed(2)}%;--w:${(((e - s) / 1440) * 100).toFixed(2)}%`;
}

function cellText(cell) {
  if (!cell) return '<span class="code-line" data-off="true">·</span>';
  const def = cell.def;
  if (!def) return `<span class="code-line" data-off="true">${esc(cell.code)} ?</span>`;
  if (def.kind === OFF) return `<span class="code-line" data-off="true">${esc(def.label)}</span>`;
  return `${esc(def.label)}`;
}

// ---------------------------------------------------------------- 月曆

export function renderCalendar(merged, names, today = new Date()) {
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const lead = merged.days[0].weekday; // 0 = 週一
  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push('<div class="day pad" aria-hidden="true"></div>');

  for (const d of merged.days) {
    const weekend = d.weekday >= 5;
    const lanes = [];
    for (const who of ['a', 'b']) {
      const cell = d[who];
      const def = cell?.def;
      const bar = def && def.kind === WORK ? barStyle(def) : null;
      lanes.push(`<div class="lane" data-who="${who}">${bar ? `<i style="${bar}"></i>` : ''}</div>`);
    }
    lanes.push(`<div class="lane" data-who="free">${d.free.map((f) => `<i style="${freeStyle(f)}"></i>`).join('')}</div>`);

    const lines = ['a', 'b'].map((who) => {
      const cell = d[who];
      const def = cell?.def;
      const off = !def || def.kind !== WORK;
      const text = !cell ? '·' : def ? def.label : `${cell.code}?`;
      return `<span class="code-line" data-who="${who}" data-off="${off}">${esc(text)}</span>`;
    }).join('');

    const star = d.status === 'both-off' ? '<span class="star" aria-hidden="true">●</span>' : '';
    const aria = `${merged.month} 月 ${d.day} 日 週${d.weekdayLabel}，${names.a}${describeCell(d.a)}，${names.b}${describeCell(d.b)}${d.free.length ? `，一起有空 ${d.free.map((f) => `${f.start} 到 ${f.end}`).join('、')}` : ''}`;
    cells.push(
      `<button type="button" class="day" data-day="${d.day}" data-status="${d.status}" data-weekend="${weekend}" data-today="${d.date === todayIso}" aria-label="${esc(aria)}">`
      + `<span class="day-head"><span class="dnum">${d.day}</span><span class="dow-mini">${d.weekdayLabel}</span>${star}</span>`
      + `<span class="codes">${lines}</span>`
      + `<span class="axis">${lanes.join('')}</span>`
      + '</button>',
    );
  }

  return `<div class="cal">
    <div class="cal-dow">${WEEKDAY_LABELS.map((w, i) => `<span data-weekend="${i >= 5}">${w}</span>`).join('')}</div>
    <div class="cal-grid">${cells.join('')}</div>
    <div class="legend">
      <span><i class="swatch" data-k="a"></i>${esc(names.a)}上班</span>
      <span><i class="swatch" data-k="b"></i>${esc(names.b)}上班</span>
      <span><i class="swatch" data-k="free"></i>都有空的時段</span>
      <span><i class="swatch" data-k="bothoff"></i>一起休假</span>
      <span><i class="swatch" data-k="unknown"></i>還沒有資料</span>
      <span class="hint">每格下面那三條是 0 點到 24 點的時間軸，點一下可以改那天的班。</span>
    </div>
  </div>`;
}

function describeCell(cell) {
  if (!cell) return '沒有資料';
  if (!cell.def) return `${cell.code}（未設定）`;
  return cell.def.kind === WORK ? `${cell.def.label} ${cell.def.start}-${cell.def.end}` : cell.def.label;
}

// ---------------------------------------------------------------- 統計 + 清單

export function renderStats(merged, names) {
  const s = merged.stats;
  return `<div class="stats">
    <div class="stat" data-k="gold"><b>${s.bothOff}</b><span>天一起休假</span></div>
    <div class="stat" data-k="gold"><b>${s.longestRun || 0}</b><span>天最長連休</span></div>
    <div class="stat"><b>${s.freeDays}</b><span>天有共同空檔</span></div>
    <div class="stat"><b>${s.freeHours}</b><span>小時可以在一起</span></div>
    <div class="stat" data-k="a"><b>${s.workA}</b><span>${esc(names.a)}上班天數</span></div>
    <div class="stat" data-k="b"><b>${s.workB}</b><span>${esc(names.b)}上班天數</span></div>
    ${s.unknown > 0 ? `<div class="stat"><b>${s.unknown}</b><span>天還沒有資料</span></div>` : ''}
  </div>`;
}

export function renderRuns(merged) {
  const month = merged.month;
  if (merged.runs.length === 0) {
    return '<p class="empty-note">這個月沒有兩個人都休假的日子。往下看「有空檔的時段」，晚上還是約得到。</p>';
  }
  const items = merged.runs
    .slice()
    .sort((x, y) => y.length - x.length || x.start.day - y.start.day)
    .map((run) => {
      const when = run.length > 1
        ? `${month}/${run.start.day}（${run.start.weekdayLabel}）– ${month}/${run.end.day}（${run.end.weekdayLabel}）`
        : `${month}/${run.start.day}（${run.start.weekdayLabel}）`;
      const tag = run.length >= 3 ? '可以出去玩' : run.length === 2 ? '兩天連休' : '單日';
      return `<li><span class="when">${esc(when)}</span><span class="tag">${tag}</span></li>`;
    });
  return `<ul class="runs">${items.join('')}</ul>`;
}

export function renderSlots(merged) {
  const month = merged.month;
  const rows = merged.days.filter((d) => d.status !== 'both-off' && d.free.length > 0);
  if (rows.length === 0) return '<p class="empty-note">沒有兩個人都空下來的時段。可以到「設定」把通勤緩衝或補眠時間調短一點再看看。</p>';
  return `<ul class="runs">${rows.map((d) => `<li>
      <span class="when">${month}/${d.day}（${d.weekdayLabel}）</span>
      <span class="slots">${d.free.map((f) => `${f.start}–${f.end}`).join('　')}</span>
    </li>`).join('')}</ul>`;
}

// ---------------------------------------------------------------- 問題卡

export function renderQuestions(questions, ctx) {
  if (questions.length === 0) {
    return `<div class="q-empty">
      <div class="mark">✓</div>
      <p>沒有要問的了。<br>班表都讀懂了，直接看共同班表吧。</p>
      <div class="row" style="justify-content:center;margin-top:12px"><button class="btn go" data-act="goto" data-tab="result">看共同班表</button></div>
    </div>`;
  }
  return questions.map((q) => `<div class="q" data-sev="${q.severity}" data-qid="${esc(q.id)}">
    <h3>${esc(q.title)}</h3>
    ${q.detail ? `<p class="detail">${esc(q.detail)}</p>` : ''}
    ${questionBody(q, ctx)}
  </div>`).join('');
}

function questionBody(q, ctx) {
  switch (q.type) {
    case 'shift':
      return shiftForm(q);
    case 'times':
      return timesForm(q);
    case 'nightAnchor':
      return `<div class="answers">
        <button class="btn primary" data-act="night" data-qid="${esc(q.id)}" data-key="${esc(q.key)}" data-offset="0">那天去上班</button>
        <button class="btn" data-act="night" data-qid="${esc(q.id)}" data-key="${esc(q.key)}" data-offset="1">前一天晚上去，那天早上下班</button>
      </div>`;
    case 'blanks':
      return `<div class="answers">
        <button class="btn ${q.suggestion === 'off' ? 'primary' : ''}" data-act="blanks" data-qid="${esc(q.id)}" data-person="${esc(q.personId)}" data-fill="off">這些都是休假</button>
        <button class="btn ${q.suggestion === 'off' ? '' : 'primary'}" data-act="blanks" data-qid="${esc(q.id)}" data-person="${esc(q.personId)}" data-fill="blank">班表只有這些，其餘留白</button>
      </div>`;
    case 'conflict':
      return `<div class="answers">${q.options.map((code) => `<button class="btn" data-act="conflict" data-qid="${esc(q.id)}" data-person="${esc(q.personId)}" data-day="${q.day}" data-code="${esc(code)}">用「${esc(code)}」</button>`).join('')}</div>`;
    case 'monthMismatch':
      return `<div class="answers">
        <button class="btn primary" data-act="setPeriod" data-qid="${esc(q.id)}" data-year="${q.value.year}" data-month="${q.value.month}">切到 ${q.value.month} 月</button>
        <button class="btn" data-act="dismiss" data-qid="${esc(q.id)}">不用，維持現在的月份</button>
      </div>`;
    case 'period':
      return `<div class="fields">
        <label class="field"><span>年</span><input type="number" data-f="year" value="${q.value.year}" min="2020" max="2100" step="1"></label>
        <label class="field"><span>月</span><input type="number" data-f="month" value="${q.value.month}" min="1" max="12" step="1"></label>
        <button class="btn primary" data-act="periodForm" data-qid="${esc(q.id)}">就是這個月</button>
      </div>`;
    case 'layout':
      return `<div class="answers">${q.options.map((o) => `<button class="btn ${o.layout === q.value.layout ? 'primary' : ''}" data-act="layout" data-qid="${esc(q.id)}" data-person="${esc(q.personId)}" data-layout="${esc(o.layout)}">${esc(o.name)}（${o.count} 天）</button>`).join('')}</div>`;
    case 'startDay':
      return `<div class="fields">
        <label class="field"><span>第一個代號是幾號</span><input type="number" data-f="startDay" value="${q.value.startDay}" min="1" max="${q.max}" step="1"></label>
        <button class="btn primary" data-act="startDay" data-qid="${esc(q.id)}" data-person="${esc(q.personId)}">就這樣排</button>
      </div>`;
    case 'unreadable':
      return `<div class="answers">
        <button class="btn" data-act="goto" data-tab="input">回去改貼上的內容</button>
        ${ctx.claudeHelp ? `<button class="btn primary" data-act="askClaude" data-person="${esc(q.personId)}">讓 Claude 幫我讀這份班表</button>` : ''}
      </div>`;
    case 'photoRow':
      return `<div class="answers">
        ${q.options.map((o) => `<button class="btn" data-act="pickRow" data-person="${esc(q.personId)}" data-index="${o.index}">${esc(o.name)}　<span class="muted">${o.count} 天</span></button>`).join('')}
        <button class="btn ghost" data-act="dropPending" data-person="${esc(q.personId)}">都不是，重傳一張</button>
      </div>`;
    case 'note':
      return `<div class="answers"><button class="btn" data-act="dismiss" data-qid="${esc(q.id)}">知道了</button></div>`;
    default:
      return '';
  }
}

function shiftForm(q) {
  const v = q.value;
  const isOff = v.kind === OFF;
  return `${q.hintText ? `<p class="detail">${esc(q.hintText)}</p>` : ''}
  <div class="fields">
    <div class="seg" role="group" aria-label="上班還是休假">
      <button type="button" data-act="kind" data-kind="work" aria-pressed="${!isOff}">上班</button>
      <button type="button" data-act="kind" data-kind="off" aria-pressed="${isOff}">休假</button>
    </div>
    <label class="field"><span>怎麼叫它</span><input type="text" data-f="label" value="${esc(v.label)}" maxlength="10"></label>
    <label class="field" data-only="work" ${isOff ? 'hidden' : ''}><span>上班</span><input type="time" data-f="start" value="${esc(v.start || '09:00')}"></label>
    <label class="field" data-only="work" ${isOff ? 'hidden' : ''}><span>下班</span><input type="time" data-f="end" value="${esc(v.end || '18:00')}"></label>
    <button class="btn primary" data-act="learn" data-qid="${esc(q.id)}" data-key="${esc(q.key)}">記住</button>
  </div>`;
}

function timesForm(q) {
  return `<div class="dict">${q.items.map((item) => `<div class="dict-row" data-key="${esc(item.key)}">
      <span class="key">${esc(item.code)}</span>
      <span class="chip" data-kind="${item.def.kind}">${esc(item.def.label)}</span>
      <label class="field"><span>上班</span><input type="time" data-f="start" value="${esc(item.def.start || '09:00')}"></label>
      <label class="field"><span>下班</span><input type="time" data-f="end" value="${esc(item.def.end || '18:00')}"></label>
    </div>`).join('')}</div>
  <div class="answers">
    <button class="btn primary" data-act="times" data-qid="${esc(q.id)}">時間就這樣，記住</button>
  </div>`;
}

// ---------------------------------------------------------------- 班別字典

export function renderDict(learned) {
  const rows = Object.values(learned || {});
  if (rows.length === 0) {
    return '<p class="empty-note">還沒有教過任何班別。在「確認」那一頁回答問題，答案就會存到這裡，以後貼新的班表就自動認得。</p>';
  }
  rows.sort((a, b) => (a.kind === b.kind ? String(a.key).localeCompare(String(b.key)) : a.kind === WORK ? -1 : 1));
  return `<div class="dict">${rows.map((def) => `<div class="dict-row" data-key="${esc(def.key)}">
      <span class="key">${esc(def.key)}</span>
      <span class="chip" data-kind="${esc(def.kind)}">${esc(def.label)}</span>
      ${def.kind === WORK ? `<span class="meta">${esc(def.start)}–${esc(def.end)}${def.dayOffset ? '（隔天下班）' : ''}</span>` : '<span class="meta">不上班</span>'}
      <span class="spacer"></span>
      <button class="btn tiny ghost" data-act="editDict" data-key="${esc(def.key)}">改</button>
      <button class="btn tiny ghost" data-act="forget" data-key="${esc(def.key)}">忘掉</button>
    </div>`).join('')}</div>`;
}

export function renderDayEditor(day, merged, names, learned) {
  const d = merged.days.find((x) => x.day === day);
  if (!d) return '';
  const options = suggestCodes(learned);
  const pick = (who) => {
    const cell = d[who];
    const current = cell?.code || '';
    return `<div class="card" style="box-shadow:none;margin-top:10px">
      <header><h3 style="color:var(--${who})">${esc(names[who])}</h3><span class="spacer"></span><span class="hint">${esc(describeCell(cell))}</span></header>
      <div class="answers">
        ${options.map((o) => `<button class="btn tiny ${o === current ? 'primary' : ''}" data-act="setDay" data-person="${who}" data-day="${day}" data-code="${esc(o)}">${esc(o)}</button>`).join('')}
        <button class="btn tiny" data-act="setDay" data-person="${who}" data-day="${day}" data-code="">清空</button>
      </div>
      <div class="fields" style="margin-top:8px">
        <label class="field"><span>或直接打代號</span><input type="text" data-f="code-${who}" value="${esc(current)}" maxlength="12" placeholder="例如 G2 或 0800-1700"></label>
        <button class="btn tiny" data-act="setDayFree" data-person="${who}" data-day="${day}">套用</button>
      </div>
    </div>`;
  };
  return `<h2>${merged.month}/${d.day}（週${d.weekdayLabel}）</h2>
    <p class="hint">${d.free.length ? `一起有空：${d.free.map((f) => `${f.start}–${f.end}`).join('、')}` : '這天沒有共同空檔'}</p>
    ${pick('a')}${pick('b')}
    <div class="row end" style="margin-top:12px"><button class="btn" data-act="closeSheet">關閉</button></div>`;
}

function suggestCodes(learned) {
  const base = ['早', '中', '小夜', '大夜', '休', '例'];
  const extra = Object.values(learned || {}).map((d) => d.key).filter((k) => !base.includes(k));
  return [...base, ...extra].slice(0, 16);
}
