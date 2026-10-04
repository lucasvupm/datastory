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
export async function askClaude(prompt, opts = {}) {
  const claude = globalThis.claude;
  if (!claude || typeof claude.use !== 'function') return null;
  try {
    const sample = await claude.use('sample');
    if (!sample) return null;
    return await sample.json(prompt, opts);
  } catch (err) {
    throw err;
  }
}

export async function hasClaudeHelp() {
  const claude = globalThis.claude;
  if (!claude || typeof claude.use !== 'function') return false;
  try {
    return Boolean(await claude.use('sample'));
  } catch {
    return false;
  }
}
