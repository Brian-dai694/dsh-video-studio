// 对话面板的纯函数守卫：转义、摘要、时间格式、绝不出现裸 JSON。
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownLite, summariseTool, formatMicros } from '../public/video/video-chat.mjs';

test('Markdown 渲染先转义：脚本/标签不会变成 DOM', () => {
  const html = renderMarkdownLite('<img src=x onerror=alert(1)> **粗** `code`');
  assert.ok(!html.includes('<img'), '原始标签必须被转义');
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('<strong>粗</strong>'));
  assert.ok(html.includes('<code>code</code>'));
});

test('代码块与列表按结构渲染，且内容仍被转义', () => {
  const html = renderMarkdownLite('前\n\n```js\nconst a = "<b>";\n```\n\n- 一\n- 二');
  assert.ok(html.includes('<pre><code>const a = &quot;&lt;b&gt;&quot;;</code></pre>'));
  assert.ok(html.includes('<li>一</li>'));
  assert.ok(html.includes('<li>二</li>'));
});

test('工具卡片摘要带身份字段，且不含 JSON 花括号', () => {
  const text = summariseTool({ name: 'media.video.clip.add', trackId: 'video-main-1', clipId: 'clip-abcdef12', startMicros: 0, endMicros: 4232000 });
  assert.ok(text.includes('media.video.clip.add'));
  assert.ok(text.includes('轨道 video-'));
  assert.ok(text.includes('片段 clip-a'));
  assert.ok(text.includes('00:00.000–00:04.232'));
  assert.equal(/[{}]/.test(text), false, '摘要里不能出现 JSON 花括号');
});

test('微秒格式：非法值给破折号，不猜 0', () => {
  assert.equal(formatMicros(1500000), '00:01.500');
  assert.equal(formatMicros(4232000), '00:04.232');
  assert.equal(formatMicros(null), '—');
  assert.equal(formatMicros(-1), '—');
  assert.equal(formatMicros('abc'), '—');
});

test('链接只放行 http(s)，且带 noopener', () => {
  const html = renderMarkdownLite('[文档](https://example.com/a)');
  assert.ok(html.includes('target="_blank"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes('href="https://example.com/a"'));
  assert.equal(renderMarkdownLite('[x](javascript:alert(1))').includes('href="javascript:'), false);
});
