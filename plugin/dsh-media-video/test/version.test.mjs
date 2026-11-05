// 版本号单一来源：包 package.json → boot 响应 + 页面顶栏徽标（服务端注入）。
// 这里守三件事：①VERSION 就是 package.json 的版本；②占位符替换不掉链；
// ③真的走 HTTP 路由取回来的 HTML 里已经是版本号，而不是 __DSH_STUDIO_VERSION__。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { VERSION, VERSION_TOKEN, injectStudioVersion } from '../lib/version.js';
import { createMediaRouter } from '../lib/http.js';

const pkgUrl = new URL('../package.json', import.meta.url);
const pageUrl = new URL('../public/video/index.html', import.meta.url);

test('VERSION 与 package.json 的 version 一致（不在页面手写第二份）', async () => {
  const pkg = JSON.parse(await readFile(pkgUrl, 'utf8'));
  assert.equal(VERSION, pkg.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('injectStudioVersion 替换全部占位符，没有残留', () => {
  const html = `<meta content="${VERSION_TOKEN}"><span>v${VERSION_TOKEN}</span>`;
  const out = injectStudioVersion(html, '9.9.9');
  assert.equal(out.includes(VERSION_TOKEN), false);
  assert.equal(out, '<meta content="9.9.9"><span>v9.9.9</span>');
});

test('页面模板用占位符，不含写死的版本号', async () => {
  const html = await readFile(pageUrl, 'utf8');
  assert.ok(html.includes(VERSION_TOKEN), 'index.html 必须有版本占位符');
  assert.ok(!/v?\d+\.\d+\.\d+/.test(html.replaceAll(VERSION_TOKEN, '')), 'index.html 不应写死版本号');
});

test('经路由取回的编辑器页面已注入版本（真实 HTML 服务路径）', async () => {
  const router = createMediaRouter({
    relay: { register() {}, poll() {}, respond() {}, disconnect() {} },
    editorKind: 'video',
    prefix: '/media-video',
    token: 'test-token',
    publicDir: fileURLToPath(new URL('../public/', import.meta.url)),
    editorRoot: fileURLToPath(new URL('../public/video/', import.meta.url)),
  });
  let status = 0;
  let body = '';
  const res = {
    writeHead(code) { status = code; },
    end(value) { body = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? ''); },
  };
  const handled = await router({ url: '/media-video/video/index.html', method: 'GET', headers: {} }, res);
  assert.equal(handled, true);
  assert.equal(status, 200);
  assert.equal(body.includes(VERSION_TOKEN), false, '出站 HTML 不应残留占位符');
  assert.ok(body.includes(`v${VERSION}`), `顶栏应显示 v${VERSION}`);
  assert.ok(body.includes(`content="${VERSION}"`), 'meta 里应带版本号');
});

test('boot 响应带 editorVersion，供宿主与审计对齐', async () => {
  const router = createMediaRouter({
    relay: {}, editorKind: 'video', prefix: '/media-video', token: 'tok',
    publicDir: fileURLToPath(new URL('../public/', import.meta.url)),
    editorRoot: fileURLToPath(new URL('../public/video/', import.meta.url)),
  });
  let body = '';
  const res = { writeHead() {}, end(value) { body = String(value); } };
  await router({
    url: '/media-video/boot', method: 'GET',
    headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' },
  }, res);
  const parsed = JSON.parse(body);
  assert.equal(parsed.editorVersion, VERSION);
  assert.deepEqual(parsed.editorKinds, ['video']);
});
