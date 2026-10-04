// 把所有模組串成一個檔案，這樣就能直接用瀏覽器打開、或當成 Artifact 發佈。
// 做法很土但可控：按相依順序串接，拿掉 import / export 關鍵字，整包包進一個 IIFE。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 相依順序：被依賴的放前面
const MODULES = [
  'src/core/dict.js',
  'src/core/parse.js',
  'src/core/clarify.js',
  'src/core/merge.js',
  'src/core/export.js',
  'src/core/claude.js',
  'src/ui/storage.js',
  'src/ui/render.js',
  'src/ui/png.js',
  'src/ui/photo.js',
  'src/ui/app.js',
];

const IMPORT_RE = /^\s*import\s[^;]*?;\s*$/gm;
const EXPORT_DECL_RE = /^export\s+(?=(async\s+function|function|const|let|class)\b)/gm;
const EXPORT_LIST_RE = /^export\s*\{[^}]*\}\s*;?\s*$/gm;

async function stripModule(relPath) {
  const source = await readFile(resolve(root, relPath), 'utf8');
  const stripped = source
    .replace(IMPORT_RE, '')
    .replace(EXPORT_LIST_RE, '')
    .replace(EXPORT_DECL_RE, '');
  const leftovers = stripped.match(/^\s*(import|export)\s/gm);
  if (leftovers) {
    throw new Error(`${relPath} 還有處理不掉的 import/export：${leftovers.join(', ')}`);
  }
  return `// ===== ${relPath} =====\n${stripped.trim()}\n`;
}

/** 檢查有沒有重複的最上層名稱 — 串在一起之後會互相蓋掉。 */
function assertNoDuplicateTopLevel(chunks) {
  const seen = new Map();
  const declRe = /^(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const { path, code } of chunks) {
    for (const m of code.matchAll(declRe)) {
      const name = m[1];
      if (seen.has(name)) {
        throw new Error(`最上層名稱重複：${name}（${seen.get(name)} 與 ${path}）`);
      }
      seen.set(name, path);
    }
  }
}

export async function build() {
  const chunks = [];
  for (const path of MODULES) chunks.push({ path, code: await stripModule(path) });
  assertNoDuplicateTopLevel(chunks);

  const css = await readFile(resolve(root, 'src/styles.css'), 'utf8');
  const shell = await readFile(resolve(root, 'src/shell.html'), 'utf8');
  const script = `<script>\n(function () {\n'use strict';\n${chunks.map((c) => c.code).join('\n')}\nif (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);\nelse start();\n})();\n</script>`;
  const body = shell
    .replace('<!--STYLE-->', `<style>\n${css.trim()}\n</style>`)
    .replace('<!--SCRIPT-->', script);

  await mkdir(resolve(root, 'dist'), { recursive: true });
  // 給 Artifact 用的：只有 body 內容，發佈時會自動補上 <!doctype> 跟 head
  await writeFile(resolve(root, 'dist/artifact.html'), `${body.trim()}\n`, 'utf8');
  // 可以直接雙擊打開的完整網頁
  const standalone = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
</head>
<body style="margin:0">
${body.trim()}
</body>
</html>
`;
  await writeFile(resolve(root, 'dist/index.html'), standalone, 'utf8');
  return { bytes: standalone.length, modules: MODULES.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  build()
    .then((r) => console.log(`build ok：${r.modules} 個模組，dist/index.html ${(r.bytes / 1024).toFixed(1)} KB`))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
