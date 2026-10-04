// 直接從瀏覽器呼叫 Anthropic Messages API 讀班表照片。
//
// 為什麼不用官方 SDK：這個 App 的交付形式是「一個 HTML 檔，雙擊就能開」，
// 不能有 build step 也不想綁 CDN。改用 fetch，但 wire format 不是用猜的 ——
// header 名稱是從 @anthropic-ai/sdk 的 client.js 裡確認的：
// dangerouslyAllowBrowser: true 送出的就是 anthropic-dangerous-direct-browser-access: true。
// 圖片區塊形狀取自 SDK 的 Base64ImageSource / ImageBlockParam 型別定義。
//
// API key 只存在使用者自己的裝置（localStorage），只會送到 api.anthropic.com，
// 絕對不會進共用資料庫。

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2023-06-01';
export const MODEL = 'claude-opus-5-5';
export const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export function apiHeaders(apiKey) {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

/**
 * @param {Array<{mediaType: string, base64: string}>} images
 * @param {string} prompt
 */
export function buildRequest(images, prompt) {
  const content = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
  }));
  content.push({ type: 'text', text: prompt });
  return {
    model: MODEL,
    max_tokens: 16000,
    // Opus 5.5 的 thinking 永遠開著，送 thinking 參數會 400，用 effort 控制深度。
    output_config: { effort: 'high' },
    messages: [{ role: 'user', content }],
  };
}

/** 把回應裡的文字接起來。先擋 refusal，再擋空回應。 */
export function extractText(body) {
  if (!body || typeof body !== 'object') throw claudeError('bad_response', '回應格式看不懂');
  if (body.stop_reason === 'refusal') {
    throw claudeError('refused', `Claude 不願意處理這張圖${body.stop_details?.explanation ? `：${body.stop_details.explanation}` : ''}`);
  }
  const text = (Array.isArray(body.content) ? body.content : [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) throw claudeError('empty', 'Claude 沒有回傳任何文字');
  if (body.stop_reason === 'max_tokens') throw claudeError('truncated', '內容太長被截斷了，一次傳少一點');
  return text;
}

/** 容錯的 JSON 解析：整段、```json 區塊、或第一個 { 到最後一個 }。 */
export function parseJsonLoosely(text) {
  const attempts = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) attempts.push(fence[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));
  for (const candidate of attempts) {
    try {
      const value = JSON.parse(candidate.trim());
      if (value && typeof value === 'object') return value;
    } catch { /* 換下一種 */ }
  }
  throw claudeError('invalid_json', 'Claude 的回答不是乾淨的 JSON，再試一次或換一張清楚的照片');
}

export function claudeError(code, message) {
  return { code, message };
}

/** HTTP 狀態碼翻成看得懂的話。 */
export function describeHttpError(status, body) {
  const apiMessage = body?.error?.message ? `（${String(body.error.message).slice(0, 120)}）` : '';
  switch (status) {
    case 400: return claudeError('bad_request', `請求被拒絕${apiMessage}`);
    case 401: return claudeError('auth', 'API key 不對或已失效。到設定重新貼一次。');
    case 403: return claudeError('forbidden', '這把 key 沒有權限用這個模型。');
    case 404: return claudeError('not_found', `找不到這個模型${apiMessage}`);
    case 413: return claudeError('too_large', '圖片太大了，傳少一點或先縮圖。');
    case 429: return claudeError('rate_limited', '太頻繁或額度用完了，等一下再試。');
    case 529: return claudeError('overloaded', 'Anthropic 現在很忙，等一下再試。');
    default:
      if (status >= 500) return claudeError('server', `Anthropic 伺服器錯誤 ${status}，等一下再試。`);
      return claudeError('http', `HTTP ${status}${apiMessage}`);
  }
}

/**
 * 真正送出請求。fetchImpl 可注入，測試才跑得動。
 * @returns {Promise<object>} 解析過的 JSON
 */
export async function askClaudeDirect({ apiKey, images, prompt, signal, fetchImpl = globalThis.fetch }) {
  if (!apiKey || !/^sk-ant-/.test(apiKey.trim())) {
    throw claudeError('no_key', '還沒設定 API key。到「設定」貼上一把 sk-ant- 開頭的 key。');
  }
  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: apiHeaders(apiKey.trim()),
      body: JSON.stringify(buildRequest(images, prompt)),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw claudeError('cancelled', '取消了');
    throw claudeError('network', '連不上 api.anthropic.com。檢查一下網路。');
  }
  let body = null;
  try {
    body = await res.json();
  } catch { /* 可能回了非 JSON */ }
  if (!res.ok) throw describeHttpError(res.status, body);
  return parseJsonLoosely(extractText(body));
}
