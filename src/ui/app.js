// 主控：狀態、互動、匯出。
import { WORK, OFF, normalizeCode, mergeDictionary, resolveCode } from '../core/dict.js';
import { daysInMonth } from '../core/parse.js';
import { buildPersonSchedule, buildQuestions, learnShift, forgetShift } from '../core/clarify.js';
import { mergeSchedules, DEFAULT_SETTINGS } from '../core/merge.js';
import { buildIcs, buildTextSummary, buildBackup, parseBackup } from '../core/export.js';
import { createStore, saveFile, saveBlob, askClaude, hasClaudeHelp, LOCAL_KEY } from './storage.js';
import { esc, renderCalendar, renderStats, renderRuns, renderSlots, renderQuestions, renderDict, renderDayEditor } from './render.js';
import { renderPng } from './png.js';


const DEMO_A = `一 二 三 四 五 六 日
1 2 3 4 5 6 7
早 早 休 休 中 中 早
8 9 10 11 12 13 14
休 休 早 早 中 大夜 大夜
15 16 17 18 19 20 21
休 休 早 早 早 中 中
22 23 24 25 26 27 28
休 早 早 中 中 休 休
29 30 31
早 早 休`;

const DEMO_B = `10/1 休
10/2 小夜
10/3 休
10/4 休
10/5 休
10/6 早
10/7 早
10/8 休
10/9 休
10/10 小夜
10/11 小夜
10/12 休
10/13 早
10/14 早
10/15 休
10/16 休
10/17 小夜
10/18 小夜
10/19 休
10/20 早
10/21 早
10/22 休
10/23 休
10/24 小夜
10/25 小夜
10/26 休
10/27 休
10/28 早
10/29 早
10/30 休
10/31 休`;

function demoState() {
  return {
    version: 1,
    isDemo: true,
    period: { year: 2026, month: 10 },
    people: [
      { id: 'a', name: '我', raw: DEMO_A, hints: {}, overrides: {} },
      { id: 'b', name: '她', raw: DEMO_B, hints: {}, overrides: {} },
    ],
    learned: {},
    settings: { ...DEFAULT_SETTINGS },
    dismissed: {},
  };
}

function emptyState(today = new Date()) {
  return {
    version: 1,
    isDemo: false,
    period: { year: today.getFullYear(), month: today.getMonth() + 1 },
    people: [
      { id: 'a', name: '我', raw: '', hints: {}, overrides: {} },
      { id: 'b', name: '她', raw: '', hints: {}, overrides: {} },
    ],
    learned: {},
    settings: { ...DEFAULT_SETTINGS },
    dismissed: {},
  };
}

function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const people = Array.isArray(raw.people) && raw.people.length >= 2 ? raw.people : base.people;
  return {
    version: 1,
    isDemo: Boolean(raw.isDemo),
    period: {
      year: Number(raw.period?.year) || base.period.year,
      month: Math.min(12, Math.max(1, Number(raw.period?.month) || base.period.month)),
    },
    people: ['a', 'b'].map((id, i) => {
      const p = people.find((x) => x?.id === id) || people[i] || {};
      return {
        id,
        name: typeof p.name === 'string' && p.name.trim() ? p.name.slice(0, 10) : base.people[i].name,
        raw: typeof p.raw === 'string' ? p.raw : '',
        hints: p.hints && typeof p.hints === 'object' ? p.hints : {},
        overrides: p.overrides && typeof p.overrides === 'object' ? p.overrides : {},
      };
    }),
    learned: raw.learned && typeof raw.learned === 'object' ? raw.learned : {},
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    dismissed: raw.dismissed && typeof raw.dismissed === 'object' ? raw.dismissed : {},
  };
}

let state = emptyState();
let store = null;
let merged = null;
let questions = [];
let claudeHelp = false;
let tab = 'input';
let sheetDay = null;
let saveTimer = null;
let claudeBusy = false;

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- 計算

function names() {
  return { a: state.people[0].name, b: state.people[1].name };
}

function recompute() {
  const today = new Date();
  const schedA = buildPersonSchedule(state.people[0], state.learned, state.period, today);
  const schedB = buildPersonSchedule(state.people[1], state.learned, state.period, today);
  merged = mergeSchedules(schedA, schedB, state.period, state.settings);
  questions = buildQuestions(state.people, state.learned, state.period, today)
    .filter((q) => !state.dismissed[q.id]);
}

function pendingCount() {
  return questions.filter((q) => q.severity === 'blocking').length;
}

function hasInput() {
  return state.people.some((p) => (p.raw || '').trim().length > 0);
}

// ---------------------------------------------------------------- 儲存

function scheduleSave() {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
  } catch { /* 無痕模式之類的，就只留在記憶體 */ }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (store) await store.write(state);
  }, 700);
}

function mutate(fn, opts = {}) {
  fn(state);
  if (opts.notDemo !== false) state.isDemo = false;
  recompute();
  render();
  scheduleSave();
}

// ---------------------------------------------------------------- 畫面

function render() {
  renderSteps();
  renderModeBadge();
  $('#tab-input').innerHTML = inputTab();
  $('#tab-ask').innerHTML = askTab();
  $('#tab-result').innerHTML = resultTab();
  $('#tab-settings').innerHTML = settingsTab();
  for (const id of ['input', 'ask', 'result', 'settings']) {
    $(`#tab-${id}`).hidden = tab !== id;
  }
  renderSheet();
}

function renderModeBadge() {
  const badge = $('#mode');
  if (!store) {
    badge.textContent = '載入中…';
    return;
  }
  badge.dataset.sync = store.mode;
  badge.textContent = store.mode === 'shared' && store.canWrite ? '共用・兩人同步' : '單機・只存這台裝置';
  badge.title = store.note || '';
}

function renderSteps() {
  const blocking = pendingCount();
  const total = questions.length;
  const items = [
    { id: 'input', n: '1', label: '貼班表' },
    { id: 'ask', n: '2', label: '確認', pip: total > 0 ? String(total) : '✓', done: blocking === 0 },
    { id: 'result', n: '3', label: '共同班表' },
    { id: 'settings', n: '', label: '設定' },
  ];
  $('#steps').innerHTML = items.map((it) => `<button role="tab" aria-selected="${tab === it.id}" data-act="tab" data-tab="${it.id}">
    ${it.n ? `<span class="n">${it.n}</span>` : ''}${it.label}
    ${it.pip && hasInput() ? `<span class="pip" data-done="${it.done}">${it.pip}</span>` : ''}
  </button>`).join('');
}

function periodControl() {
  return `<span class="period">
    <button data-act="period" data-delta="-1" aria-label="上一個月">‹</button>
    <span class="label">${state.period.year} 年 ${state.period.month} 月</span>
    <button data-act="period" data-delta="1" aria-label="下一個月">›</button>
  </span>`;
}

const FORMAT_SAMPLES = `10/1 早班          ← 一行一天
10/2 休

1  2  3  4  5  6  7   ← 表格：日期一列
早 早 休 休 中 中 早      班別一列

早班：1,3,5,7,9     ← 班別對日期
休：2,4,6
大夜：10-13

10/5 08:00-17:00    ← 直接寫時間也行
早 早 休 休 中 ...  ← 只有代號，從 1 號排`;

function inputTab() {
  const demoNote = state.isDemo
    ? `<div class="card" style="border-color:color-mix(in srgb, var(--gold) 45%, var(--rule))">
        <header><h2>先看範例</h2><span class="spacer"></span><button class="btn" data-act="clear">清空，換我們的班表</button></header>
        <p class="hint">下面兩份是示範用的班表，你可以直接按上面那顆按鈕清掉，或是把內容整個選取換成你們的。</p>
      </div>`
    : '';
  return `${demoNote}
  <div class="card">
    <header><h2>這個月</h2><span class="spacer"></span>${periodControl()}</header>
    <p class="hint">兩個人的班表會排在同一個月上。班表裡如果寫了別的月份，我會問你要不要切過去。</p>
  </div>
  <div class="people">
    ${state.people.map((p) => personCard(p)).join('')}
  </div>
  <div class="card">
    <header><h2>看得懂哪些格式</h2></header>
    <div class="scroll-x"><pre style="font-family:var(--mono);font-size:11.5px;line-height:1.8;margin:0;color:var(--ink-dim)">${esc(FORMAT_SAMPLES)}</pre></div>
    <p class="hint" style="margin-top:10px">不確定格式對不對就先貼進去——讀不出來的地方我會在「確認」那一頁一個一個問你。全形、tab、Excel 直接複製都可以。</p>
  </div>
  <div class="row end" style="margin-top:14px">
    <button class="btn go" data-act="tab" data-tab="${questions.length > 0 ? 'ask' : 'result'}">
      ${questions.length > 0 ? `下一步：確認 ${questions.length} 件事` : '下一步：看共同班表'}
    </button>
  </div>`;
}

function personCard(p) {
  const sched = buildPersonSchedule(p, state.learned, state.period, new Date());
  const filled = sched.days.size;
  const status = (p.raw || '').trim()
    ? `讀到 ${filled} 天${sched.parsed.layoutName ? `・${esc(sched.parsed.layoutName)}` : ''}`
    : '還沒有貼上';
  return `<div class="card person-card" data-who="${p.id}">
    <header>
      <input class="name-input" data-f="name" data-person="${p.id}" value="${esc(p.name)}" maxlength="10" aria-label="名字">
      <span class="spacer"></span>
      <span class="eyebrow">${status}</span>
    </header>
    <textarea data-f="raw" data-person="${p.id}" placeholder="把班表貼進來，什麼格式都先試試看" spellcheck="false">${esc(p.raw)}</textarea>
    <div class="row" style="margin-top:8px">
      ${claudeHelp ? `<button class="btn tiny" data-act="askClaude" data-person="${p.id}" ${claudeBusy ? 'disabled' : ''}>${claudeBusy ? '讀取中…' : '讓 Claude 幫我讀'}</button>` : ''}
      <span class="spacer"></span>
      <button class="btn-link" data-act="clearPerson" data-person="${p.id}">清空這份</button>
    </div>
  </div>`;
}

function askTab() {
  if (!hasInput()) {
    return `<div class="card"><div class="q-empty">
      <div class="mark">—</div>
      <p>還沒有班表可以確認。<br>先到第一步把班表貼進來。</p>
      <div class="row" style="justify-content:center;margin-top:12px"><button class="btn primary" data-act="tab" data-tab="input">去貼班表</button></div>
    </div></div>`;
  }
  const blocking = pendingCount();
  return `<div class="card">
    <header>
      <h2>${questions.length > 0 ? `還有 ${questions.length} 件事想問你` : '都問完了'}</h2>
      <span class="spacer"></span>
      ${blocking > 0 ? `<span class="chip" data-kind="work">${blocking} 件會影響結果</span>` : ''}
    </header>
    <p class="hint">回答過的班別會被記住，下個月貼新班表就不會再問。左邊是深色線的是比較重要的。</p>
  </div>
  <div style="margin-top:14px">${renderQuestions(questions, { claudeHelp })}</div>`;
}

function resultTab() {
  if (!merged) return '';
  if (!hasInput()) {
    return `<div class="card"><div class="q-empty">
      <div class="mark">—</div>
      <p>還沒有班表。<br>貼進來之後這裡就會變成你們的共同班表。</p>
      <div class="row" style="justify-content:center;margin-top:12px"><button class="btn primary" data-act="tab" data-tab="input">去貼班表</button></div>
    </div></div>`;
  }
  const n = names();
  return `<div class="card">
    <header><h2>${state.period.year} 年 ${state.period.month} 月</h2><span class="spacer"></span>${periodControl()}</header>
    ${renderCalendar(merged, n)}
  </div>
  <div class="card"><header><h2>一起休假</h2></header>${renderRuns(merged)}</div>
  <div class="card"><header><h2>有空檔的時段</h2><span class="spacer"></span><span class="hint">扣掉通勤跟補眠之後，兩個人都空下來的時間</span></header>${renderSlots(merged)}</div>
  <div class="card"><header><h2>這個月的數字</h2></header>${renderStats(merged, n)}</div>
  <div class="card">
    <header><h2>帶走</h2></header>
    <div class="row">
      <button class="btn primary" data-act="png">存成圖片</button>
      <button class="btn" data-act="ics">加到行事曆（.ics）</button>
      <button class="btn" data-act="text">複製成文字</button>
    </div>
    <p class="hint" style="margin-top:10px">圖片適合直接傳給對方；.ics 匯入 Google 行事曆或 iPhone 行事曆後，會有兩個人的班、共同休假、和可以約的時段。</p>
  </div>`;
}

function settingsTab() {
  const s = state.settings;
  return `<div class="card">
    <header><h2>怎麼算「都有空」</h2></header>
    <p class="hint">共同空檔是從兩個人的清醒時間裡，扣掉上班、通勤、下大夜之後要補的眠，剩下的交集。</p>
    <div class="fields" style="margin-top:12px">
      <label class="field"><span>一天從</span><input type="time" data-s="awakeStart" value="${esc(s.awakeStart)}"></label>
      <label class="field"><span>到</span><input type="time" data-s="awakeEnd" value="${esc(s.awakeEnd)}"></label>
      <label class="field"><span>通勤（分）</span><input type="number" data-s="commuteMinutes" value="${s.commuteMinutes}" min="0" max="180" step="5"></label>
      <label class="field"><span>夜班後補眠（時）</span><input type="number" data-s="sleepAfterNightHours" value="${s.sleepAfterNightHours}" min="0" max="12" step="1"></label>
      <label class="field"><span>最短空檔（分）</span><input type="number" data-s="minBlockMinutes" value="${s.minBlockMinutes}" min="30" max="600" step="30"></label>
    </div>
  </div>
  <div class="card">
    <header><h2>學過的班別</h2><span class="spacer"></span><span class="hint">${Object.keys(state.learned).length} 個</span></header>
    ${renderDict(state.learned)}
    <div class="row" style="margin-top:12px">
      <button class="btn tiny" data-act="addDict">手動新增一個班別</button>
    </div>
  </div>
  <div class="card">
    <header><h2>備份與同步</h2></header>
    <p class="hint">把設定存成一個檔案傳給對方匯入，兩邊的班別字典就一樣了。${store?.mode === 'shared' && store.canWrite ? '（你們現在已經是共用模式，改動會自動同步。）' : ''}</p>
    <div class="row" style="margin-top:10px">
      <button class="btn" data-act="backup">匯出設定檔</button>
      <button class="btn" data-act="restore">匯入設定檔</button>
      <span class="spacer"></span>
      <button class="btn ghost" data-act="demo">載入範例班表</button>
      <button class="btn ghost" data-act="clear">全部清空</button>
    </div>
    <input type="file" id="restore-file" accept="application/json,.json" hidden>
  </div>`;
}

function renderSheet() {
  const host = $('#sheet-host');
  if (sheetDay === null || !merged) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML = `<div class="sheet" data-act="closeSheetBackdrop"><div class="sheet-inner" role="dialog" aria-modal="true">${renderDayEditor(sheetDay, merged, names(), state.learned)}</div></div>`;
}

let toastTimer = null;
function toast(message) {
  const host = $('#toast-host');
  host.innerHTML = `<div class="toast" role="status">${esc(message)}</div>`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { host.innerHTML = ''; }, 2600);
}

// ---------------------------------------------------------------- 互動

function closestQ(el) {
  return el.closest('.q');
}

function readFields(scope) {
  const out = {};
  for (const input of scope.querySelectorAll('[data-f]')) out[input.dataset.f] = input.value;
  return out;
}

function personById(id) {
  return state.people.find((p) => p.id === id);
}

const ACTIONS = {
  tab(el) {
    tab = el.dataset.tab;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  goto(el) {
    ACTIONS.tab(el);
  },
  period(el) {
    const delta = Number(el.dataset.delta);
    mutate((s) => {
      let m = s.period.month + delta;
      let y = s.period.year;
      if (m > 12) { m = 1; y += 1; }
      if (m < 1) { m = 12; y -= 1; }
      s.period = { year: y, month: m };
    }, { notDemo: false });
  },
  kind(el) {
    const q = closestQ(el);
    const kind = el.dataset.kind;
    for (const b of q.querySelectorAll('[data-act="kind"]')) b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
    for (const f of q.querySelectorAll('[data-only="work"]')) f.hidden = kind === 'off';
  },
  learn(el) {
    const q = closestQ(el);
    const fields = readFields(q);
    const kind = q.querySelector('[data-act="kind"][aria-pressed="true"]')?.dataset.kind === 'off' ? OFF : WORK;
    mutate((s) => {
      s.learned = learnShift(s.learned, el.dataset.key, {
        label: fields.label,
        kind,
        start: fields.start,
        end: fields.end,
      });
    });
    toast(`記住了：${fields.label || el.dataset.key}`);
  },
  times(el) {
    const q = closestQ(el);
    mutate((s) => {
      for (const row of q.querySelectorAll('.dict-row')) {
        const key = row.dataset.key;
        const dict = mergeDictionary(s.learned);
        const def = dict[normalizeCode(key)];
        if (!def) continue;
        s.learned = learnShift(s.learned, key, {
          ...def,
          start: row.querySelector('[data-f="start"]').value,
          end: row.querySelector('[data-f="end"]').value,
        });
      }
    });
    toast('時間記住了');
  },
  night(el) {
    const key = el.dataset.key;
    const offset = Number(el.dataset.offset);
    mutate((s) => {
      const def = mergeDictionary(s.learned)[normalizeCode(key)];
      if (def) s.learned = learnShift(s.learned, key, { ...def, dayOffset: offset });
    });
    toast(offset === 0 ? '算在上班那天' : '算成前一天晚上去上班');
  },
  blanks(el) {
    const fill = el.dataset.fill;
    const id = el.dataset.qid;
    mutate((s) => {
      const p = s.people.find((x) => x.id === el.dataset.person);
      if (p) p.hints = { ...p.hints, fillMissing: fill };
      if (fill === 'blank') s.dismissed[id] = true;
    });
  },
  conflict(el) {
    mutate((s) => {
      const p = s.people.find((x) => x.id === el.dataset.person);
      if (p) p.overrides = { ...p.overrides, [el.dataset.day]: el.dataset.code };
    });
  },
  setPeriod(el) {
    mutate((s) => {
      s.period = { year: Number(el.dataset.year), month: Number(el.dataset.month) };
    }, { notDemo: false });
  },
  periodForm(el) {
    const q = closestQ(el);
    const f = readFields(q);
    mutate((s) => {
      s.period = { year: Number(f.year) || s.period.year, month: Math.min(12, Math.max(1, Number(f.month) || s.period.month)) };
      s.dismissed[el.dataset.qid] = true;
    }, { notDemo: false });
  },
  layout(el) {
    mutate((s) => {
      const p = s.people.find((x) => x.id === el.dataset.person);
      if (p) p.hints = { ...p.hints, layout: el.dataset.layout };
      s.dismissed[el.dataset.qid] = true;
    });
  },
  startDay(el) {
    const q = closestQ(el);
    const f = readFields(q);
    mutate((s) => {
      const p = s.people.find((x) => x.id === el.dataset.person);
      if (p) p.hints = { ...p.hints, startDay: Math.max(1, Number(f.startDay) || 1) };
      s.dismissed[el.dataset.qid] = true;
    });
  },
  dismiss(el) {
    mutate((s) => { s.dismissed[el.dataset.qid] = true; }, { notDemo: false });
  },
  openDay(el) {
    sheetDay = Number(el.dataset.day);
    renderSheet();
  },
  closeSheet() {
    sheetDay = null;
    renderSheet();
  },
  closeSheetBackdrop(el, event) {
    if (event.target === el) ACTIONS.closeSheet();
  },
  setDay(el) {
    const day = el.dataset.day;
    const code = el.dataset.code;
    mutate((s) => {
      const p = s.people.find((x) => x.id === el.dataset.person);
      if (!p) return;
      p.overrides = { ...p.overrides, [day]: code === '' ? null : code };
    });
  },
  setDayFree(el) {
    const scope = el.closest('.card');
    const who = el.dataset.person;
    const code = scope.querySelector(`[data-f="code-${who}"]`)?.value?.trim() ?? '';
    mutate((s) => {
      const p = s.people.find((x) => x.id === who);
      if (!p) return;
      p.overrides = { ...p.overrides, [el.dataset.day]: code === '' ? null : code };
    });
    if (code && !resolveCode(mergeDictionary(state.learned), code)) {
      tab = 'ask';
      render();
      toast(`「${code}」還沒教過，到確認頁回答一下`);
    }
  },
  editDict(el) {
    const key = el.dataset.key;
    const def = state.learned[normalizeCode(key)];
    if (!def) return;
    sheetDay = null;
    const host = $('#sheet-host');
    host.innerHTML = `<div class="sheet" data-act="closeSheetBackdrop"><div class="sheet-inner" role="dialog" aria-modal="true">
      <h2>改「${esc(def.key)}」</h2>
      <div class="fields" style="margin-top:12px">
        <div class="seg" role="group">
          <button type="button" data-act="kindDict" data-kind="work" aria-pressed="${def.kind === WORK}">上班</button>
          <button type="button" data-act="kindDict" data-kind="off" aria-pressed="${def.kind === OFF}">休假</button>
        </div>
        <label class="field"><span>名稱</span><input type="text" data-f="label" value="${esc(def.label)}" maxlength="10"></label>
        <label class="field" data-only="work" ${def.kind === OFF ? 'hidden' : ''}><span>上班</span><input type="time" data-f="start" value="${esc(def.start || '09:00')}"></label>
        <label class="field" data-only="work" ${def.kind === OFF ? 'hidden' : ''}><span>下班</span><input type="time" data-f="end" value="${esc(def.end || '18:00')}"></label>
      </div>
      <div class="row end" style="margin-top:14px">
        <button class="btn" data-act="closeSheet">取消</button>
        <button class="btn primary" data-act="saveDict" data-key="${esc(def.key)}">存起來</button>
      </div>
    </div></div>`;
  },
  kindDict(el) {
    const scope = el.closest('.sheet-inner');
    for (const b of scope.querySelectorAll('[data-act="kindDict"]')) b.setAttribute('aria-pressed', String(b.dataset.kind === el.dataset.kind));
    for (const f of scope.querySelectorAll('[data-only="work"]')) f.hidden = el.dataset.kind === 'off';
  },
  saveDict(el) {
    const scope = el.closest('.sheet-inner');
    const f = readFields(scope);
    const kind = scope.querySelector('[data-act="kindDict"][aria-pressed="true"]')?.dataset.kind === 'off' ? OFF : WORK;
    mutate((s) => {
      s.learned = learnShift(s.learned, el.dataset.key, { label: f.label, kind, start: f.start, end: f.end });
    });
    $('#sheet-host').innerHTML = '';
    toast('改好了');
  },
  addDict() {
    const host = $('#sheet-host');
    host.innerHTML = `<div class="sheet" data-act="closeSheetBackdrop"><div class="sheet-inner" role="dialog" aria-modal="true">
      <h2>新增班別</h2>
      <p class="hint">代號就是班表上寫的那幾個字，例如 <code>G2</code>、<code>夜</code>、<code>OFF</code>。</p>
      <div class="fields" style="margin-top:12px">
        <label class="field"><span>代號</span><input type="text" data-f="key" value="" maxlength="12" placeholder="G2"></label>
        <div class="seg" role="group">
          <button type="button" data-act="kindDict" data-kind="work" aria-pressed="true">上班</button>
          <button type="button" data-act="kindDict" data-kind="off" aria-pressed="false">休假</button>
        </div>
        <label class="field"><span>名稱</span><input type="text" data-f="label" value="" maxlength="10" placeholder="小夜"></label>
        <label class="field" data-only="work"><span>上班</span><input type="time" data-f="start" value="09:00"></label>
        <label class="field" data-only="work"><span>下班</span><input type="time" data-f="end" value="18:00"></label>
      </div>
      <div class="row end" style="margin-top:14px">
        <button class="btn" data-act="closeSheet">取消</button>
        <button class="btn primary" data-act="createDict">新增</button>
      </div>
    </div></div>`;
  },
  createDict(el) {
    const scope = el.closest('.sheet-inner');
    const f = readFields(scope);
    if (!f.key?.trim()) {
      toast('要先填代號');
      return;
    }
    const kind = scope.querySelector('[data-act="kindDict"][aria-pressed="true"]')?.dataset.kind === 'off' ? OFF : WORK;
    mutate((s) => {
      s.learned = learnShift(s.learned, f.key, { label: f.label || f.key, kind, start: f.start, end: f.end });
    });
    $('#sheet-host').innerHTML = '';
    toast(`新增了「${f.key.trim()}」`);
  },
  forget(el) {
    mutate((s) => { s.learned = forgetShift(s.learned, el.dataset.key); });
    toast('忘掉了');
  },
  clearPerson(el) {
    mutate((s) => {
      const p = s.people.find((x) => x.id === el.dataset.person);
      if (p) {
        p.raw = '';
        p.overrides = {};
        p.hints = {};
      }
    });
  },
  clear() {
    mutate((s) => {
      const fresh = emptyState();
      s.isDemo = false;
      s.people = fresh.people.map((p, i) => ({ ...p, name: s.people[i]?.name || p.name }));
      s.dismissed = {};
    });
    tab = 'input';
    render();
    toast('清空了，字典還留著');
  },
  demo() {
    const keep = state.learned;
    state = demoState();
    state.learned = keep;
    tab = 'input';
    recompute();
    render();
    scheduleSave();
  },
  async ics() {
    const text = buildIcs(merged, { names: names() });
    const res = await saveFile(`shift-schedule-${state.period.year}-${String(state.period.month).padStart(2, '0')}.ics`, text, 'text/calendar;charset=utf-8');
    toast(res.ok ? '行事曆檔已產生，匯入後兩人的班都會出現' : res.reason === 'declined' ? '取消了' : '存檔失敗，改用「複製成文字」試試');
  },
  async png() {
    toast('正在畫圖…');
    try {
      const blob = await renderPng(merged, names());
      if (!blob) throw new Error('no blob');
      const res = await saveBlob(`shift-schedule-${state.period.year}-${String(state.period.month).padStart(2, '0')}.png`, blob);
      toast(res.ok ? '圖片好了' : res.reason === 'declined' ? '取消了' : '存圖失敗');
    } catch {
      toast('存圖失敗，可以改用截圖');
    }
  },
  async text() {
    const text = buildTextSummary(merged, { names: names() });
    try {
      await navigator.clipboard.writeText(text);
      toast('複製好了，可以直接貼到 LINE');
      return;
    } catch { /* 有些瀏覽器不給寫剪貼簿 */ }
    const host = $('#sheet-host');
    host.innerHTML = `<div class="sheet" data-act="closeSheetBackdrop"><div class="sheet-inner" role="dialog" aria-modal="true">
      <h2>複製這段文字</h2>
      <p class="hint">瀏覽器不讓我直接寫剪貼簿，手動選取複製就好。</p>
      <textarea class="out" readonly style="margin-top:10px">${esc(text)}</textarea>
      <div class="row end" style="margin-top:12px"><button class="btn" data-act="closeSheet">關閉</button></div>
    </div></div>`;
    host.querySelector('textarea')?.select();
  },
  async backup() {
    const res = await saveFile('shift-schedule-settings.json', buildBackup(state), 'application/json');
    toast(res.ok ? '設定檔好了，傳給對方匯入就同步了' : '匯出失敗');
  },
  restore() {
    $('#restore-file').click();
  },
  async askClaude(el) {
    const person = personById(el.dataset.person);
    if (!person || !(person.raw || '').trim()) {
      toast('先把班表貼進來');
      return;
    }
    claudeBusy = true;
    render();
    toast('Claude 正在讀這份班表…');
    try {
      const data = await askClaude(claudePrompt(person.raw, state.period));
      applyClaudeResult(person.id, data);
    } catch (err) {
      const code = err?.code;
      toast(code === 'not_granted' ? '你沒有同意讓這個頁面問 Claude' : code === 'rate_limited' ? '太頻繁了，等一下再試' : '這次讀不出來，可以手動點選那幾天');
    } finally {
      claudeBusy = false;
      render();
    }
  },
};

function claudePrompt(raw, period) {
  return `你是排班表解析器。下面三引號裡是某個人的班表原始文字，可能是從 Excel、LINE 或照片打字出來的，格式不固定。

請只輸出 JSON，不要有任何其他文字，格式如下：
{
  "year": 2026,
  "month": 10,
  "entries": [{"day": 1, "code": "早"}],
  "shifts": [{"code": "早", "label": "早班", "kind": "work", "start": "08:00", "end": "16:00"}],
  "note": "一句話說明你怎麼讀的"
}

規則：
- entries 要列出這份班表實際提到的每一天，day 是 1 到 31 的數字，code 照班表原文寫。
- shifts 要列出每一種出現過的 code：kind 只能是 "work" 或 "off"；work 要給 start / end（24 小時制 HH:MM），off 的 start / end 給 null。
- 看不出年月就把 year 設成 ${period.year}、month 設成 ${period.month}。
- 不確定的 code 就照原文放進 shifts，並在 note 裡說你不確定。

"""
${raw.slice(0, 4000)}
"""`;
}

function applyClaudeResult(personId, data) {
  if (!data || !Array.isArray(data.entries) || data.entries.length === 0) {
    toast('Claude 沒讀出可用的班表');
    return;
  }
  mutate((s) => {
    const p = s.people.find((x) => x.id === personId);
    if (!p) return;
    const overrides = { ...p.overrides };
    for (const e of data.entries) {
      const day = Number(e?.day);
      if (!Number.isInteger(day) || day < 1 || day > 31) continue;
      const code = String(e?.code ?? '').trim();
      if (code) overrides[day] = code;
    }
    p.overrides = overrides;
    for (const shift of Array.isArray(data.shifts) ? data.shifts : []) {
      const code = String(shift?.code ?? '').trim();
      if (!code) continue;
      s.learned = learnShift(s.learned, code, {
        label: String(shift.label || code).slice(0, 10),
        kind: shift.kind === 'off' ? OFF : WORK,
        start: shift.start || '09:00',
        end: shift.end || '18:00',
      });
    }
    const year = Number(data.year);
    const month = Number(data.month);
    if (Number.isInteger(month) && month >= 1 && month <= 12 && Number.isInteger(year)) {
      s.period = { year, month };
    }
  });
  toast(data.note ? `讀好了：${String(data.note).slice(0, 40)}` : '讀好了');
}

// ---------------------------------------------------------------- 綁定

function bind() {
  document.addEventListener('click', (event) => {
    const dayBtn = event.target.closest('.day[data-day]');
    if (dayBtn) {
      ACTIONS.openDay(dayBtn);
      return;
    }
    const el = event.target.closest('[data-act]');
    if (!el) return;
    const fn = ACTIONS[el.dataset.act];
    if (!fn) return;
    if (el.tagName === 'BUTTON') event.preventDefault();
    fn(el, event);
  });

  let inputTimer = null;
  document.addEventListener('input', (event) => {
    const el = event.target;
    if (el.dataset.s) {
      const key = el.dataset.s;
      const raw = el.type === 'number' ? Number(el.value) : el.value;
      mutate((s) => { s.settings = { ...s.settings, [key]: raw }; }, { notDemo: false });
      return;
    }
    if (el.dataset.f === 'raw' || el.dataset.f === 'name') {
      const person = personById(el.dataset.person);
      if (!person) return;
      const value = el.value;
      if (el.dataset.f === 'name') person.name = value.slice(0, 10);
      else {
        person.raw = value;
        person.overrides = {};
        person.hints = { ...person.hints, layout: undefined };
      }
      state.isDemo = false;
      if (inputTimer) clearTimeout(inputTimer);
      inputTimer = setTimeout(() => {
        inputTimer = null;
        const active = document.activeElement;
        const keep = active?.dataset?.f === 'raw' || active?.dataset?.f === 'name'
          ? { f: active.dataset.f, person: active.dataset.person, start: active.selectionStart, end: active.selectionEnd }
          : null;
        recompute();
        render();
        scheduleSave();
        if (keep) {
          const next = document.querySelector(`[data-f="${keep.f}"][data-person="${keep.person}"]`);
          if (next) {
            next.focus();
            if (keep.start !== null && next.setSelectionRange) next.setSelectionRange(keep.start, keep.end);
          }
        }
      }, 450);
    }
  });

  document.addEventListener('change', async (event) => {
    if (event.target.id !== 'restore-file') return;
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const data = parseBackup(await file.text());
      state = normalizeState({ ...data, isDemo: false });
      recompute();
      render();
      scheduleSave();
      toast('匯入好了');
    } catch (err) {
      toast(err?.message || '這個檔案讀不出來');
    } finally {
      event.target.value = '';
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('#sheet-host').innerHTML) {
      $('#sheet-host').innerHTML = '';
      sheetDay = null;
    }
  });
}

// ---------------------------------------------------------------- 啟動

function readLocalSync() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function start() {
  const local = readLocalSync();
  state = local ? normalizeState(local) : demoState();
  recompute();
  bind();
  render();

  (async () => {
    const [help, created] = await Promise.all([hasClaudeHelp(), createStore()]);
    claudeHelp = help;
    store = created;
    const remote = await store.read();
    if (remote && JSON.stringify(remote) !== JSON.stringify(state)) {
      const remoteFilled = countFilled(remote);
      const localFilled = countFilled(state);
      if (!local || remoteFilled >= localFilled) {
        state = normalizeState(remote);
        recompute();
      }
    }
    store.watch((event) => {
      if (event.type === 'remote') {
        const active = document.activeElement;
        if (active?.dataset?.f === 'raw') return; // 對方在打字時不要蓋掉自己正在改的
        state = normalizeState(event.state);
        recompute();
        render();
        return;
      }
      if (event.type === 'degraded') {
        renderModeBadge();
        toast('沒有共用資料的權限，改成只存在這台裝置');
      }
    });
    render();
  })();
}

function countFilled(s) {
  if (!s || !Array.isArray(s.people)) return 0;
  return s.people.reduce((n, p) => n + String(p?.raw || '').length, 0) + Object.keys(s.learned || {}).length * 50;
}
