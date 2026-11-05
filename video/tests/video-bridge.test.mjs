import assert from 'node:assert/strict';
import { createProject, createHistory, commit, undo, redo, reduceProject, readState } from '../video-state.mjs';
import { createEditorBridge, toEditorCommand } from '../video-bridge.mjs';

let count = 0;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const test = async (name, fn) => { await fn(); count++; console.log(`PASS ${count}: ${name}`); };

function harness() {
  let history = createHistory(createProject());
  const instanceId = 'instance-video-1';
  const state = () => history.present;
  const fakeWindow = {
    handlers: [],
    addEventListener(type, fn) { if (type === 'message') this.handlers.push(fn); },
    removeEventListener(type, fn) { this.handlers = this.handlers.filter(item => item !== fn); },
    emit(event) { for (const fn of [...this.handlers]) fn(event); }
  };
  const exportCalls = [];
  const exportJobs = new Map();
  const bridge = createEditorBridge({
    instanceId,
    getState: () => readState(state(), history, instanceId, { webm: true }),
    applyCommand: (command, context) => {
      const ids = [command.clipId, command.overlayId, command.clip?.id, command.overlay?.id].filter(Boolean);
      if (command.type === 'media.video.history.undo' || command.type === 'media.video.history.redo') {
        history = command.type.endsWith('.undo') ? undo(history) : redo(history);
        return { changedObjectIds: [] };
      }
      const next = reduceProject(state(), command);
      if (context?.commandId) next.lastCommandId = context.commandId;
      history = commit(history, next);
      return { changedObjectIds: [...new Set(ids)] };
    },
    exportStart: message => {
      exportCalls.push({ type: 'start', message });
      if (message.format !== 'webm') throw Object.assign(new Error('MP4 未验证'), { code: 'EXPORT_FORMAT_UNAVAILABLE' });
      const exportId = `export-${exportCalls.length}`;
      exportJobs.set(exportId, { editorKind: 'video', exportId, status: 'ready', artifactRef: `blob:${exportId}`, bytes: 1024, durationSeconds: 3, audio: true });
      return { editorKind: 'video', commandId: message.commandId, exportId, status: 'running' };
    },
    exportStatus: message => {
      exportCalls.push({ type: 'status', message });
      return exportJobs.get(message.exportId) || { editorKind: 'video', exportId: message.exportId, status: 'unknown' };
    },
    targetWindow: fakeWindow,
    expectedOrigin: 'http://127.0.0.1:1234'
  });
  const replies = [];
  const port = { onmessage: null, start() {}, close() {}, postMessage(message) { replies.push(message); } };
  const connect = () => fakeWindow.emit({ origin: 'http://127.0.0.1:1234', data: { type: 'dsh.editor.connect', requestId: 'connect-1' }, ports: [port] });
  const request = async message => { replies.length = 0; port.onmessage({ data: message }); await tick(); return replies[0]; };
  return { bridge, fakeWindow, port, connect, request, replies, state, exportCalls, get history() { return history; } };
}

await test('handshake returns ready envelope with contractVersion 1', async () => {
  const h = harness();
  h.connect();
  assert.deepEqual(h.replies[0], { requestId: 'connect-1', ok: true, result: { ready: true, contractVersion: 1, editorInstanceId: 'instance-video-1' } });
  assert.equal(h.bridge.connected, true);
  h.bridge.dispose();
});

await test('connect from a foreign origin is ignored', async () => {
  const h = harness();
  h.fakeWindow.emit({ origin: 'http://evil.test', data: { type: 'dsh.editor.connect', requestId: 'connect-x' }, ports: [h.port] });
  assert.equal(h.replies.length, 0);
  assert.equal(h.bridge.connected, false);
  h.bridge.dispose();
});

await test('read_state returns the editor-owned state summary', async () => {
  const h = harness();
  h.connect();
  const reply = await h.request({ type: 'editor.read_state', requestId: 'r1', editorInstanceId: 'instance-video-1' });
  assert.equal(reply.ok, true);
  assert.equal(reply.result.editorKind, 'video');
  assert.equal(reply.result.revision, 0);
  assert.equal(typeof reply.result.stateDigest, 'string');
  assert.equal(JSON.stringify(reply.result).includes('bytes'), false);
  h.bridge.dispose();
});

await test('stale expectedRevision is rejected and does not mutate', async () => {
  const h = harness();
  h.connect();
  const reply = await h.request({ type: 'editor.apply_command', requestId: 'a1', editorInstanceId: 'instance-video-1', documentId: h.state().projectId, expectedRevision: 99, commandId: 'cmd-1', command: { type: 'media.video.overlay.add', payload: { kind: 'text', text: '片头', startUs: 0, durationUs: 1000000 } } });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'REVISION_CONFLICT');
  assert.equal(h.state().revision, 0);
  assert.equal(h.state().overlays.length, 0);
  h.bridge.dispose();
});

await test('apply_command is idempotent by commandId and reports changed ids', async () => {
  const h = harness();
  h.connect();
  const command = { type: 'media.video.overlay.add', payload: { kind: 'text', text: '片头字幕', startUs: 0, durationUs: 2000000 } };
  const base = { editorInstanceId: 'instance-video-1', documentId: h.state().projectId, expectedRevision: 0, commandId: 'cmd-once', command };
  const first = await h.request({ type: 'editor.apply_command', requestId: 'a2', ...base });
  assert.equal(first.ok, true);
  assert.equal(first.result.revision, 1);
  assert.equal(first.result.commandId, 'cmd-once');
  assert.equal(first.result.changedObjectIds.length, 1);
  const second = await h.request({ type: 'editor.apply_command', requestId: 'a3', ...base });
  assert.equal(second.ok, true);
  assert.deepEqual(second.result, first.result);
  assert.equal(h.state().revision, 1);
  const result = await h.request({ type: 'editor.get_command_result', requestId: 'g1', editorInstanceId: 'instance-video-1', commandId: 'cmd-once' });
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'applied');
  assert.equal(result.result.originalResult.commandId, 'cmd-once');
  h.bridge.dispose();
});

await test('unknown commandId reports unknown instead of being replayed', async () => {
  const h = harness();
  h.connect();
  const reply = await h.request({ type: 'editor.get_command_result', requestId: 'g2', editorInstanceId: 'instance-video-1', commandId: 'never-seen' });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.result, { status: 'unknown', originalResult: null });
  assert.equal(h.state().revision, 0);
  h.bridge.dispose();
});

await test('microsecond payloads map to seconds without losing the single-track limit', () => {
  const add = toEditorCommand({ type: 'media.video.clip.add', payload: { sourceRef: 'local:a.webm', inUs: 1000000, outUs: 4000000 } });
  assert.equal(add.clip.in, 1);
  assert.equal(add.clip.out, 4);
  const trim = toEditorCommand({ type: 'media.video.clip.trim', payload: { clipId: 'c1', inUs: 2000000, outUs: 3000000 } });
  assert.deepEqual([trim.in, trim.out], [2, 3]);
  assert.throws(() => toEditorCommand({ type: 'layer.update_text', payload: {} }), /白名单/);
});

await test('clip.add honours trim boundaries and overlay.add honours start/end', () => {
  const withClip = reduceProject(createProject(), { type: 'media.video.clip.add', clip: { id: 'c9', sourceRef: 'local:c9', name: 'c9', duration: 10, in: 2, out: 6 } });
  assert.equal(withClip.tracks[0].clips[0].in, 2);
  assert.equal(withClip.tracks[0].clips[0].out, 6);
  const withOverlay = reduceProject(withClip, { type: 'media.video.overlay.add', overlay: { id: 'o9', kind: 'text', name: '标题', content: '标题', start: 1, end: 3 } });
  const overlay = withOverlay.overlays[0];
  assert.deepEqual([overlay.start, overlay.end], [1, 3]);
});

await test('a write that does not advance the revision exactly once is unknown, never applied', async () => {
  const fakeWindow = { handlers: [], addEventListener(type, fn) { if (type === 'message') this.handlers.push(fn); }, removeEventListener() {}, emit(event) { for (const fn of this.handlers) fn(event); } };
  let history = createHistory(createProject());
  const bridge = createEditorBridge({
    instanceId: 'instance-audit',
    getState: () => readState(history.present, history, 'instance-audit', { webm: true }),
    applyCommand: () => ({ changedObjectIds: [] }),
    targetWindow: fakeWindow,
    expectedOrigin: 'http://127.0.0.1:1234'
  });
  const replies = [];
  const port = { onmessage: null, start() {}, close() {}, postMessage(message) { replies.push(message); } };
  fakeWindow.emit({ origin: 'http://127.0.0.1:1234', data: { type: 'dsh.editor.connect', requestId: 'c' }, ports: [port] });
  port.onmessage({ data: { type: 'editor.apply_command', requestId: 'a', editorInstanceId: 'instance-audit', documentId: history.present.projectId, expectedRevision: 0, commandId: 'cmd-audit', command: { type: 'media.video.overlay.add', payload: { kind: 'text', text: 'x' } } } });
  await tick();
  const reply = replies.at(-1);
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'AUDIT_MISMATCH');
  assert.equal(reply.error.outcomeUnknown, true);
  bridge.dispose();
});

await test('targeted undo only succeeds while the original command is still on top', async () => {
  const h = harness();
  h.connect();
  const add = { type: 'media.video.overlay.add', payload: { kind: 'text', text: '片头' } };
  const first = await h.request({ type: 'editor.apply_command', requestId: 't1', editorInstanceId: 'instance-video-1', documentId: h.state().projectId, expectedRevision: 0, commandId: 'cmd-first', command: add });
  assert.equal(first.ok, true);
  assert.equal(first.result.revision, 1);
  assert.equal(typeof first.result.afterDigest, 'string');
  const undo = await h.request({ type: 'editor.apply_command', requestId: 't2', editorInstanceId: 'instance-video-1', documentId: h.state().projectId, expectedRevision: 1, commandId: 'cmd-undo', command: { type: 'media.video.history.undo', payload: { targetCommandId: 'cmd-first', afterDigest: first.result.afterDigest } } });
  assert.equal(undo.ok, true);
  assert.equal(undo.result.revision, 2);
  assert.equal(h.state().overlays.length, 0);
  const second = await h.request({ type: 'editor.apply_command', requestId: 't3', editorInstanceId: 'instance-video-1', documentId: h.state().projectId, expectedRevision: 2, commandId: 'cmd-later', command: add });
  assert.equal(second.ok, true);
  const stale = await h.request({ type: 'editor.apply_command', requestId: 't4', editorInstanceId: 'instance-video-1', documentId: h.state().projectId, expectedRevision: 3, commandId: 'cmd-undo-2', command: { type: 'media.video.history.undo', payload: { targetCommandId: 'cmd-first', afterDigest: first.result.afterDigest } } });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'HISTORY_CONFLICT');
  const plain = await h.request({ type: 'editor.apply_command', requestId: 't5', editorInstanceId: 'instance-video-1', documentId: h.state().projectId, expectedRevision: 3, commandId: 'cmd-undo-3', command: { type: 'media.video.history.undo', payload: {} } });
  assert.equal(plain.ok, true);
  h.bridge.dispose();
});

await test('export_start validates revision and format; export_status reports unknown ids', async () => {
  const h = harness();
  h.connect();
  const base = { editorInstanceId: 'instance-video-1', documentId: h.state().projectId };
  const stale = await h.request({ type: 'editor.export_start', requestId: 'e1', ...base, expectedRevision: 7, commandId: 'exp-1', format: 'webm' });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'REVISION_CONFLICT');
  const mp4 = await h.request({ type: 'editor.export_start', requestId: 'e2', ...base, expectedRevision: 0, commandId: 'exp-2', format: 'mp4' });
  assert.equal(mp4.ok, false);
  assert.equal(mp4.error.code, 'EXPORT_FORMAT_UNAVAILABLE');
  const started = await h.request({ type: 'editor.export_start', requestId: 'e3', ...base, expectedRevision: 0, commandId: 'exp-3', format: 'webm' });
  assert.equal(started.ok, true);
  assert.equal(started.result.status, 'running');
  assert.equal(typeof started.result.exportId, 'string');
  const status = await h.request({ type: 'editor.export_status', requestId: 'e4', ...base, exportId: started.result.exportId });
  assert.equal(status.ok, true);
  assert.equal(status.result.status, 'ready');
  assert.equal(typeof status.result.artifactRef, 'string');
  const missing = await h.request({ type: 'editor.export_status', requestId: 'e5', ...base, exportId: 'export-never' });
  assert.equal(missing.ok, true);
  assert.equal(missing.result.status, 'unknown');
  h.bridge.dispose();
});

console.log(JSON.stringify({ passed: count, scope: 'editor-side bridge + state mapping; browser MediaChannel/relay not exercised' }));
