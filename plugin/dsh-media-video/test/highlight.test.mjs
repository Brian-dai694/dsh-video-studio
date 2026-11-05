// 编辑器侧桥：editor.highlight 只改描边（不碰 revision/历史），selection_changed 通知有 100ms 节流。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorBridge } from '../public/video/video-bridge.mjs';

function harness({ highlight } = {}) {
  const listeners = new Map();
  const targetWindow = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: () => {},
  };
  const state = { editorKind: 'video', documentId: 'd1', revision: 7, clips: [{ id: 'c1' }], overlays: [], tracks: [{ id: 't1' }] };
  const posted = [];
  const port = { postMessage: message => posted.push(message), start() {}, close() {} };
  let applies = 0;
  const bridge = createEditorBridge({
    instanceId: 'i1',
    getState: () => state,
    applyCommand: () => { applies += 1; return { changedObjectIds: [] }; },
    highlight,
    targetWindow,
  });
  listeners.get('message')({ origin: 'http://example.test', ports: [port], data: { type: 'dsh.editor.connect', requestId: 'connect-1' } });
  posted.length = 0; // 丢弃握手应答，只看后续
  return { bridge, posted, port, state, applied: () => applies };
}

const send = (port, message) => new Promise(resolve => {
  port.onmessage({ data: message });
  setTimeout(() => resolve(), 20);
});

test('editor.highlight 只加描边：命中/缺失都返回，revision 与写入都不动', async () => {
  const seen = [];
  const { posted, port, state, applied } = harness({
    highlight: ({ objectIds, ttlMs }) => { seen.push({ objectIds, ttlMs }); return { matched: ['c1'], missing: ['nope'] }; },
  });
  await send(port, { type: 'editor.highlight', requestId: 'h1', objectIds: ['c1', 'nope'], ttlMs: 800 });
  const reply = posted.find(message => message.requestId === 'h1');
  assert.ok(reply, '必须有应答');
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.result, { matched: ['c1'], missing: ['nope'] });
  assert.deepEqual(seen[0], { objectIds: ['c1', 'nope'], ttlMs: 800 });
  assert.equal(state.revision, 7, '高亮不能 bump revision');
  assert.equal(applied(), 0, '高亮不能触发写入');
  assert.equal('documentId' in state && state.documentId, 'd1');
});

test('没有高亮能力时明确报 HIGHLIGHT_UNAVAILABLE，不假装成功', async () => {
  const { posted, port } = harness();
  await send(port, { type: 'editor.highlight', requestId: 'h2', objectIds: ['c1'] });
  const reply = posted.find(message => message.requestId === 'h2');
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'HIGHLIGHT_UNAVAILABLE');
});

test('objectIds 非法时拒绝，且不调用高亮', async () => {
  let called = 0;
  const { posted, port } = harness({ highlight: () => { called += 1; return {}; } });
  await send(port, { type: 'editor.highlight', requestId: 'h3', objectIds: [] });
  const reply = posted.find(message => message.requestId === 'h3');
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'INVALID_REQUEST');
  assert.equal(called, 0);
});

test('editor.selection_changed 通知带 revision 与选中，节流到 ≥100ms 一条并保留最后的值', async () => {
  const { bridge, posted } = harness();
  const at = [];
  bridge.notifySelection({ selectedObjectIds: ['c1'], objectKind: 'clip' });
  bridge.notifySelection({ selectedObjectIds: ['c2'], objectKind: 'clip' });
  bridge.notifySelection({ selectedObjectIds: ['c3'], objectKind: 'clip' });
  await new Promise(resolve => setTimeout(resolve, 130));
  const notes = posted.filter(message => message.type === 'editor.selection_changed');
  // 前导一次 + 尾部一次（≤100ms 窗口内 3 次调用合并成 2 条），且间隔不小于节流窗口。
  assert.ok(notes.length >= 1 && notes.length <= 2, `节流后不应超过 2 条，实际 ${notes.length}`);
  assert.equal(notes.at(-1).revision, 7);
  assert.deepEqual(notes.at(-1).selectedObjectIds, ['c3'], '应保留最后一次的值');
  assert.equal(notes.at(-1).requestId, undefined, '通知不是请求，不能带 requestId');
});
