// 视频页只允许一个对话面：真实那份在宿主面板（lib/client.js 的 Conversation）。
// 页面里再挂一份，用户就会看到两个输入框——桌面端已经报过这个 bug，这条把它钉住。
// 归属：index.html / video.js / video.css 由 ODE 维护；这里只做只读断言，不改页面文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pageDir = fileURLToPath(new URL('../public/video/', import.meta.url));
const read = name => readFileSync(join(pageDir, name), 'utf8');

test('视频编辑器页面不再自带对话面板（真实会话只在宿主面板）', () => {
  const html = read('index.html');
  for (const marker of [
    'chatPanel', 'chat-panel', 'paneSplitter', 'pane-splitter',
    'data-chat-input', 'data-chat-send', 'chatSessionLabel',
  ]) {
    assert.equal(html.includes(marker), false, `页面不应再有 ${marker}`);
  }
  // 去重后保留的是只读审计行：真实回执写这里，不是模拟。
  assert.match(html, /id="auditDigest"/);
});

test('页面脚本不挂载对话，也不引用已删除的对话模块', () => {
  const js = read('video.js');
  assert.equal(/video-chat\.mjs|mountChat|chat\.append|chat\.showError/.test(js), false, '不能挂载页面内对话或引用已删除模块');
  // 删模块最容易漏的崩点：别处还在 import / 调用它的导出。
  assert.equal(existsSync(join(pageDir, 'video-chat.mjs')), false, 'video-chat.mjs 应已从页面目录移除');
  assert.equal(/formatMicros|summariseTool|renderMarkdownLite/.test(js), false, '原对话模块的导出不得再被引用');
});

test('界面文案不再自称“本地模拟”（插件跑的是真命令）', () => {
  // 撤销/重做/回读三处曾把真实操作写成“本地模拟”。页面初始文本是“等待操作”，
  // 所以只有点过一次才暴露；这条在源码层拦，不依赖人工点一遍。
  assert.equal(/本地模拟/.test(read('video.js')), false, 'video.js 不得再把真实操作写成“本地模拟”');
  assert.equal(/本地模拟/.test(read('index.html')), false, '页面文本不得出现“本地模拟”');
});

test('样式里不留对话与分栏的孤儿规则', () => {
  const css = read('video.css');
  for (const pattern of [/\.chat-/, /\.pane-splitter/]) {
    assert.equal(pattern.test(css), false, `孤儿样式应清掉：${pattern}`);
  }
});
