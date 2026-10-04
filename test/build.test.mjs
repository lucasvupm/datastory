import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from '../scripts/build.mjs';

const SOURCES = [
  'src/core/dict.js', 'src/core/parse.js', 'src/core/clarify.js', 'src/core/merge.js',
  'src/core/export.js', 'src/core/claude.js', 'src/ui/storage.js', 'src/ui/render.js',
  'src/ui/png.js', 'src/ui/photo.js', 'src/ui/app.js',
];

async function built() {
  await build();
  return readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
}

test('打包不會吃掉 $ —— String.replace 的替換字串會把 $$ 當跳脫字元', async () => {
  const html = await built();
  let sourceCount = 0;
  for (const path of SOURCES) {
    const src = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    sourceCount += (src.match(/\$\$/g) || []).length;
  }
  assert.ok(sourceCount > 0, '測試本身要有東西可驗');
  const builtCount = (html.match(/\$\$/g) || []).length;
  assert.equal(builtCount, sourceCount, `原始碼有 ${sourceCount} 個 $$，打包後剩 ${builtCount}`);
  assert.ok(html.includes('`$${usd.toFixed(2)}`'), '金額格式化的錢字號不見了');
});

test('打包後沒有殘留的 import / export', async () => {
  const html = await built();
  const script = html.slice(html.indexOf("<script>"), html.lastIndexOf('</script>'));
  assert.equal(script.match(/^\s*(import|export)\s/gm), null);
});

test('所有模組都進了打包檔', async () => {
  const html = await built();
  for (const path of SOURCES) assert.ok(html.includes(`// ===== ${path} =====`), `少了 ${path}`);
});

test('單檔版是完整的 HTML 文件，artifact 版不是', async () => {
  await build();
  const standalone = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  const artifact = await readFile(new URL('../dist/artifact.html', import.meta.url), 'utf8');
  assert.ok(standalone.startsWith('<!doctype html>'));
  assert.ok(!/<!doctype|<html|<head>|<body>/i.test(artifact), 'artifact 版不能有骨架，發佈時會自動補');
  assert.ok(artifact.startsWith('<title>'));
});
