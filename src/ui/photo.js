// 照片班表：把圖片整理好交給 Claude 讀，讀回來的東西再轉成文字，
// 走跟手動貼上完全一樣的流程 —— 這樣使用者看得到它讀到什麼，也改得動。
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 太大的照片先縮一下，4G 上傳才不會等到天荒地老。 */
export async function shrinkImage(file) {
  const bitmap = await loadBitmap(file);
  if (!bitmap) return { blob: file, shrunk: false };
  const { width, height } = bitmap;
  const longest = Math.max(width, height);
  if (longest <= MAX_EDGE && file.size <= 1.5 * 1024 * 1024) {
    bitmap.close?.();
    return { blob: file, shrunk: false };
  }
  const scale = Math.min(1, MAX_EDGE / longest);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((done) => canvas.toBlob(done, 'image/jpeg', JPEG_QUALITY));
  if (!blob) return { blob: file, shrunk: false };
  return { blob, shrunk: true };
}

async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      // iPhone 的照片常常是直的，orientation 要跟著轉
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* 格式不支援（例如 HEIC）就往下走 */ }
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * 檢查、縮圖、產生預覽網址。
 * @param {File[]} files
 * @param {object} limits sample.limits().images
 */
export async function prepareImages(files, limits) {
  const accepted = [];
  const errors = [];
  const maxCount = limits?.maxCount ?? 4;
  const maxBytes = limits?.maxInputBytes ?? 20 * 1024 * 1024;
  const types = limits?.mediaTypes ?? ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

  for (const file of files) {
    if (accepted.length >= maxCount) {
      errors.push(`一次最多 ${maxCount} 張，「${file.name}」先跳過了`);
      continue;
    }
    if (file.type && !types.includes(file.type) && !file.type.startsWith('image/')) {
      errors.push(`「${file.name}」不是圖片`);
      continue;
    }
    let blob = file;
    try {
      const result = await shrinkImage(file);
      blob = result.blob;
    } catch {
      errors.push(`「${file.name}」縮圖失敗，直接用原檔試試`);
    }
    if (blob.size > maxBytes) {
      errors.push(`「${file.name}」太大了（${formatBytes(blob.size)}），先截圖或縮小再傳`);
      continue;
    }
    if (blob.type && !types.includes(blob.type)) {
      errors.push(`「${file.name}」的格式讀不了（iPhone 的 HEIC 常這樣）。到「設定 → 相機 → 格式」選「最相容」重拍，或直接截圖。`);
      continue;
    }
    accepted.push({ blob, name: file.name || '照片', url: URL.createObjectURL(blob), size: blob.size });
  }
  return { images: accepted, errors };
}

/** 直連 API 要的是 base64（去掉 data: 前綴）。 */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve({ mediaType: blob.type || 'image/jpeg', base64: comma === -1 ? result : result.slice(comma + 1) });
    };
    reader.onerror = () => reject(new Error('讀不到這個檔案'));
    reader.readAsDataURL(blob);
  });
}

export function releaseImages(images) {
  for (const img of images || []) {
    try {
      URL.revokeObjectURL(img.url);
    } catch { /* 已經被收掉了 */ }
  }
}

/**
 * 給 Claude 的提示。重點：班表照片常常是「整組人」的，
 * 所以要它把每一列都讀出來，再由使用者選自己是哪一個。
 */
export function buildPhotoPrompt(period) {
  return `這幾張圖片是排班表（可能是拍照、截圖或掃描的）。請把它讀成結構化資料。

只輸出 JSON，不要有其他文字：
{
  "year": ${period.year},
  "month": ${period.month},
  "rows": [
    {"name": "王小明", "entries": [{"day": 1, "code": "早"}, {"day": 2, "code": "休"}]}
  ],
  "shifts": [
    {"code": "早", "label": "早班", "kind": "work", "start": "08:00", "end": "16:00"}
  ],
  "note": "一句話說明你怎麼讀的，以及哪裡看不清楚"
}

規則：
- 班表上**每一個人**都要是 rows 裡的一筆。只有一個人就只放一筆。
- name 用班表上寫的名字或代號；完全沒有名字就用 "第 1 列"、"第 2 列" 這樣編號。
- entries 的 day 是 1-31 的數字，code 照格子裡的原文抄，不要自己翻譯或正規化。
- 空白的格子就不要放進 entries，不要猜。
- shifts 要列出所有出現過的 code：kind 只能是 "work" 或 "off"。work 要給 24 小時制的 start / end；off 的 start 和 end 給 null。
- 如果圖上有寫班別對照表（例如「A=08:00-16:00」），以它為準。沒有的話就依常見排班慣例推，並在 note 裡講你推了什麼。
- 看不出年月就用 year=${period.year}、month=${period.month}。
- 哪裡模糊、被遮住、或你不確定，一定要寫在 note 裡，不要默默猜過去。`;
}

/** 把讀到的一列變成文字，塞回輸入框，讓使用者看得到也改得動。 */
export function rowToText(row, month) {
  const entries = [...(row?.entries || [])]
    .filter((e) => Number.isInteger(Number(e?.day)) && Number(e.day) >= 1 && Number(e.day) <= 31)
    .sort((a, b) => Number(a.day) - Number(b.day));
  return entries.map((e) => `${month}/${Number(e.day)} ${String(e.code ?? '').trim()}`).join('\n');
}

/** 把 Claude 回來的東西擋一下，壞資料不要進到狀態裡。 */
export function normalizePhotoResult(data, period) {
  if (!data || typeof data !== 'object') return null;
  const rows = (Array.isArray(data.rows) ? data.rows : [])
    .map((row, i) => ({
      name: String(row?.name ?? '').trim() || `第 ${i + 1} 列`,
      entries: (Array.isArray(row?.entries) ? row.entries : [])
        .map((e) => ({ day: Number(e?.day), code: String(e?.code ?? '').trim() }))
        .filter((e) => Number.isInteger(e.day) && e.day >= 1 && e.day <= 31 && e.code),
    }))
    .filter((row) => row.entries.length > 0);
  if (rows.length === 0) return null;

  const shifts = (Array.isArray(data.shifts) ? data.shifts : [])
    .map((s) => ({
      code: String(s?.code ?? '').trim(),
      label: String(s?.label ?? '').trim(),
      kind: s?.kind === 'off' ? 'off' : 'work',
      start: s?.start ? String(s.start) : null,
      end: s?.end ? String(s.end) : null,
    }))
    .filter((s) => s.code);

  const year = Number(data.year);
  const month = Number(data.month);
  return {
    rows,
    shifts,
    note: String(data.note ?? '').slice(0, 200),
    year: Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : period.year,
    month: Number.isInteger(month) && month >= 1 && month <= 12 ? month : period.month,
  };
}
