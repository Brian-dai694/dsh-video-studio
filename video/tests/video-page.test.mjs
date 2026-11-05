import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

let count = 0;
const test = (name, fn) => { fn(); count++; console.log(`PASS ${count}: ${name}`); };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFile(resolve(root, name), 'utf8');
const idsOf = html => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const refsOf = js => new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]));
// Ids rendered by the script itself (preview panel) are legitimate targets too.
const dynamicIdsOf = js => new Set([...js.matchAll(/\bid="([^"$]+)"/g)].map(match => match[1]));

const editorHtml = await read('index.html');
const editorJs = await read('video.js');
const hostHtml = await read('host.html');
const hostJs = await read('host.js');
const css = await read('video.css');

test('every element id used by the video page exists in index.html', () => {
  const known = new Set([...idsOf(editorHtml), ...dynamicIdsOf(editorJs)]);
  const missing = [...refsOf(editorJs)].filter(id => !known.has(id));
  assert.deepEqual(missing, [], `video.js 引用了不存在的元素：${missing.join(', ')}`);
});
test('every element id used by the host wrapper exists in host.html', () => {
  const known = new Set([...idsOf(hostHtml), ...dynamicIdsOf(hostJs)]);
  const missing = [...refsOf(hostJs)].filter(id => !known.has(id));
  assert.deepEqual(missing, [], `host.js 引用了不存在的元素：${missing.join(', ')}`);
});
test('file inputs are bound with addEventListener, not onchange assignment', () => {
  for (const id of ['videoInput', 'emptyVideoInput', 'imageInput', 'projectInput']) {
    assert.equal(new RegExp(`\\$\\('${id}'\\)\\.onchange`).test(editorJs), false, `${id} 不得再用 onchange 赋值`);
    assert.match(editorHtml, new RegExp(`id="${id}"`));
  }
  assert.match(editorJs, /addEventListener\('change'/);
});
test('import binds media events before assigning src', () => {
  const body = editorJs.slice(editorJs.indexOf('function importVideo'), editorJs.indexOf('function makeIntent'));
  assert.ok(body.indexOf('onloadedmetadata') < body.indexOf('video.src = videoUrl'), '必须先绑定 onloadedmetadata/onerror 再设置 src');
  assert.ok(body.indexOf('onerror') < body.indexOf('video.src = videoUrl'));
});
test('webm capability is probed on load and never renders an endless 检测中', () => {
  assert.match(editorJs, /render\(\);\s*\n\s*probeCapabilities\(\);/);
  assert.match(editorJs, /webmCapability\.status === 'checking' \? '检测中'/);
  assert.match(editorJs, /probeCapabilities\(\)/);
});
test('page declares module scripts and local assets only', () => {
  assert.match(editorHtml, /<script type="module" src="video\.js"><\/script>/);
  assert.match(hostHtml, /<script type="module" src="host\.js"><\/script>/);
  assert.equal(/https?:\/\//.test(editorHtml.replace(/lang="zh-CN"/, '')), false);
  assert.equal(/https?:\/\//.test(css), false);
});
test('host wrapper talks only to the real plugin routes', () => {
  assert.match(hostJs, /baseUrl: '\/media\/video-relay',\s+editorKind: 'video'/);
  assert.match(hostJs, /fetch\('\/media\/boot'/);
  assert.equal(/\/video-tools|['"]\/video-relay['"]|['"]\/boot['"]/.test(hostJs), false, '不得再用原型期的 /video-relay、/boot 或 /video-tools 路由');
  assert.match(hostJs, /\/media\/host\/iframe-transport\.mjs/);
  assert.match(hostJs, /\/media\/host\/browser-relay\.mjs/);
});
test('host wrapper auto-connects on load and answers the binding probe', () => {
  assert.match(hostJs, /\$\('editor'\)\.addEventListener\('load'/, '必须在 iframe load 后自动连接');
  assert.match(hostJs, /connectWithRetry/, '自动连接失败要重试再报错');
  assert.match(hostJs, /media\.binding\.read/);
  assert.match(hostJs, /media\.binding\.result/);
  assert.match(hostJs, /editorKind: 'video', projectId: state\.documentId/, '绑定回执必须带 video 身份与真实文档');
});
test('page copy keeps the local-simulation boundary visible', () => {
  assert.match(editorHtml, /本地模拟/);
  assert.match(hostHtml, /真实插件路由/);
  assert.match(hostHtml, /media_video_/);
});

test('every video module parses as ESM (node --check on .js misses this)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-esm-'));
  try {
    for (const file of ['video.js', 'host.js', 'video-state.mjs', 'video-bridge.mjs', 'video-capabilities.mjs', 'video-export.mjs']) {
      const target = join(dir, file.replace(/\.js$/, '.mjs'));
      writeFileSync(target, readFileSync(resolve(root, file)));
      assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' }), `${file} 不是合法 ESM`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('page copy is valid UTF-8 Chinese text, not mojibake', () => {
  for (const [file, text] of [['video.js', '正在载入视频…'], ['index.html', '视频剪辑工作台'], ['video-bridge.mjs', '缺少 commandId'], ['host.js', '已绑定 video relay'], ['host.html', 'DSH 协作宿主']]) {
    const content = readFileSync(resolve(root, file), 'utf8');
    assert.equal(/\uFFFD/.test(content), false, `${file} 含替换字符`);
    assert.ok(content.includes(text), `${file} 缺少中文串「${text}」`);
  }
});
console.log(JSON.stringify({ passed: count, scope: 'static wiring checks; no browser execution' }));
