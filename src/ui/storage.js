// 儲存：在 claude.ai Artifact 裡用共用資料庫（兩個人看到同一份），
// 其他地方（本機開啟、GitHub Pages）退回 localStorage，功能照樣完整。
export const LOCAL_KEY = 'gongtong-banbiao-v1';
const DOC_PATH = 'shared/state';

function readLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeLocal(data) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

function localStore(note) {
  return {
    mode: 'local',
    canWrite: true,
    note,
    async read() {
      return readLocal();
    },
    async write(data) {
      return writeLocal(data);
    },
    watch() {
      return () => {};
    },
  };
}

async function sharedStore() {
  const claude = globalThis.claude;
  if (!claude || typeof claude.use !== 'function') return null;
  let db = null;
  let user = null;
  try {
    db = await claude.use('db');
  } catch {
    return null;
  }
  if (!db) return null;
  try {
    user = await claude.use('user');
  } catch {
    user = null;
  }
  let canWrite = true;
  try {
    const verdict = await user?.can?.('data.write');
    if (verdict === false) canWrite = false;
  } catch {
    canWrite = true;
  }

  const ref = db.doc(DOC_PATH);
  let degraded = false;
  const listeners = new Set();

  return {
    mode: 'shared',
    get canWrite() {
      return canWrite && !degraded;
    },
    note: canWrite ? '兩個人看到同一份' : '你只有檢視權限，改動只會留在這台裝置',
    async read() {
      try {
        const snap = await ref.get();
        return snap.exists ? snap.data()?.state ?? null : null;
      } catch {
        return readLocal();
      }
    },
    async write(data) {
      if (degraded || !canWrite) return writeLocal(data);
      try {
        await ref.set({ state: data, updatedAt: new Date().toISOString() });
        writeLocal(data); // 本機也留一份，離線還看得到
        return true;
      } catch (err) {
        if (err && (err.code === 'invalid_argument' || err.code === 'revoked' || err.code === 'not_granted')) {
          degraded = true;
          for (const fn of listeners) fn({ type: 'degraded' });
        }
        return writeLocal(data);
      }
    },
    watch(cb) {
      listeners.add(cb);
      let stop = () => {};
      try {
        stop = ref.onSnapshot(
          (snap) => {
            if (!snap.exists) return;
            if (snap.metadata?.hasPendingWrites) return; // 自己剛寫的就不用再套回來
            const state = snap.data()?.state;
            if (state) cb({ type: 'remote', state });
          },
          () => {
            degraded = true;
            cb({ type: 'degraded' });
          },
        );
      } catch {
        degraded = true;
      }
      return () => {
        listeners.delete(cb);
        stop();
      };
    },
  };
}

export async function createStore() {
  const shared = await Promise.race([
    sharedStore().catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), 12000)),
  ]);
  return shared || localStore('只存在這台裝置');
}

/** 下載檔案：Artifact 裡要走 downloads 能力，本機就用 <a download>。 */
export async function saveFile(filename, text, mime = 'text/plain;charset=utf-8') {
  const claude = globalThis.claude;
  if (claude && typeof claude.use === 'function') {
    try {
      const downloads = await claude.use('downloads');
      if (downloads) {
        await downloads.save({ filename, data: text });
        return { ok: true, via: 'claude' };
      }
    } catch (err) {
      if (err && err.code === 'declined') return { ok: false, reason: 'declined' };
      return { ok: false, reason: err?.code || 'failed' };
    }
  }
  try {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return { ok: true, via: 'anchor' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export async function saveBlob(filename, blob) {
  const claude = globalThis.claude;
  if (claude && typeof claude.use === 'function') {
    try {
      const downloads = await claude.use('downloads');
      if (downloads) {
        await downloads.save({ filename, data: blob });
        return { ok: true, via: 'claude' };
      }
    } catch (err) {
      if (err && err.code === 'declined') return { ok: false, reason: 'declined' };
      return { ok: false, reason: err?.code || 'failed' };
    }
  }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return { ok: true, via: 'anchor' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** 真的看不懂的班表，交給 Claude 幫忙讀（只有在 claude.ai 上才有）。 */
let samplePromise = null;
function getSample() {
  if (samplePromise) return samplePromise;
  const claude = globalThis.claude;
  if (!claude || typeof claude.use !== 'function') {
    samplePromise = Promise.resolve(null);
    return samplePromise;
  }
  samplePromise = claude.use('sample').catch(() => null);
  return samplePromise;
}

export async function askClaude(prompt, opts = {}) {
  const sample = await getSample();
  if (!sample) return null;
  return sample.json(prompt, opts);
}

export async function hasClaudeHelp() {
  return Boolean(await getSample());
}

/** 這台裝置 / 這個帳號能不能傳圖片給 Claude。問這個不花錢也不會跳同意視窗。 */
export async function claudeImageLimits() {
  const sample = await getSample();
  if (!sample || typeof sample.limits !== 'function') return null;
  try {
    const limits = await sample.limits();
    return limits?.images || null;
  } catch {
    return null;
  }
}

/** 把照片交給 Claude 讀。會丟出 {code, message} 形狀的錯誤。 */
export async function askClaudeWithImages(prompt, images, opts = {}) {
  const sample = await getSample();
  if (!sample) throw { code: 'not_declared', message: 'sample unavailable' };
  return sample.json(prompt, { images, modelTier: 'complex', ...opts });
}

/** 把錯誤碼翻成看得懂的話。 */
export function describeClaudeError(code) {
  switch (code) {
    case 'not_granted': return '你還沒同意讓這個頁面使用 Claude。重新整理後在跳出來的視窗按允許。';
    case 'rate_limited': return '用量到上限了，等一下再試。';
    case 'session_expired': return '登入過期了，重新登入 claude.ai 再試一次。';
    case 'image_rejected': return '這張圖片讀不了（格式不對或太大）。換一張，或先截圖。';
    case 'images_unavailable': return '這個環境不能傳圖片，請改用文字貼上。';
    case 'invalid_json': return 'Claude 讀了但沒給出乾淨的結果。再試一次，或換一張更清楚的照片。';
    case 'refused': return 'Claude 不願意處理這張圖。確認一下是不是班表？';
    case 'empty_completion': return 'Claude 沒讀出東西。照片可能太模糊了。';
    case 'prompt_too_large': return '內容太多了，分批處理看看。';
    case 'cancelled': return '取消了。';
    default: return '這次沒讀成功，可以再試一次，或改用文字貼上。';
  }
}
