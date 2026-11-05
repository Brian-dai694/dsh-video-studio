// The video package is video-only: its tools, schemas, adapter and relay must not
// accept image operations or kind, and every registered tool belongs to this editor family.
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { TOOL_KINDS } from '../lib/gate.js';
import { createMediaBridge } from '../lib/bridge.js';
import { createEditorRelay } from '../lib/relay.js';

function makeContext() {
  const tools = new Map();
  const guards = [];
  const ctx = {
    tools: {
      register: definition => { tools.set(definition.name, definition); return () => {}; },
      guard: guard => { guards.push(guard); return () => {}; },
    },
    webServer: { register: () => () => {} },
    approval: { request: async () => 'allowed-once' },
    effect: (factory) => { const dispose = factory(); return () => { if (typeof dispose === 'function') dispose(); }; },
  };
  return { ctx, tools, guards };
}

test('every registered tool and metric kind belongs to the video editor', () => {
  const { ctx, tools } = makeContext();
  apply(ctx, { dataDir: 'C:/tmp/video-scope' });
  assert.equal(tools.size, 5);
  for (const name of tools.keys()) assert.match(name, /^media_video_/);
  assert.deepEqual([...new Set(Object.values(TOOL_KINDS))], ['video']);
  for (const definition of tools.values()) {
    assert.deepEqual(definition.parameters.properties.editorKind.enum, ['video']);
  }
  assert.deepEqual(tools.get('media_video_export_start').parameters.properties.format.enum, ['webm', 'mp4']);
});

test('the guard accepts only video operations and still denies image ones', () => {
  const { ctx, guards } = makeContext();
  apply(ctx, { dataDir: 'C:/tmp/video-scope' });
  const guard = guards[0];
  const check = operation => guard({ name: 'media_video_apply_command', arguments: { editorKind: 'video', operation } });
  for (const operation of ['media.video.clip.add', 'media.video.clip.trim', 'media.video.clip.move', 'media.video.clip.remove', 'media.video.overlay.add', 'media.video.overlay.update', 'media.video.history.undo', 'media.video.history.redo']) assert.equal(check(operation), undefined, operation);
  for (const operation of ['layer.add_text', 'canvas.crop', 'history.undo', 'media.video', 'clip.add']) assert.match(check(operation), /media\.video\.\*/, operation);
  assert.match(guard({ name: 'media_video_apply_command', arguments: { editorKind: 'image', operation: 'layer.add_text' } }), /targets the video editor/);
});

test('the relay defaults to the video kind and still refuses the image kind', () => {
  const relay = createEditorRelay();
  const page = relay.register({ editorInstanceId: 'default-kind' });
  assert.equal(page.kind, 'video');
  assert.equal(relay.getPage('default-kind').kind, 'video');
  relay.close();
  assert.throws(() => createEditorRelay({ editorKind: 'image' }), { name: 'TypeError' });
});

test('the bridge defaults to the video kind and still refuses the image kind', () => {
  const bridge = createMediaBridge({ relay: { request: async () => ({}) } });
  assert.equal(bridge.editorKind, 'video');
  assert.throws(() => createMediaBridge({ relay: { request: async () => ({}) }, editorKind: 'image' }), { name: 'TypeError' });
});
