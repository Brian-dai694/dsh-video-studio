// The video package is video-only: its tools, schemas, adapter and relay must not
// accept image operations or kind, and every registered tool belongs to this editor family.
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { TOOL_KINDS } from '../lib/gate.js';
import { createMediaBridge } from '../lib/bridge.js';
import { createEditorRelay } from '../lib/relay.js';
import { registerMediaTools } from '../lib/tools.js';
import { createApprovalStore } from '../lib/gate.js';
import { fixtureBindings } from './host-fixture.mjs';

const exec = { agent: { id: 's1', session: { id: 's1' } } };

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

test('export renders carry the exportId/artifactRef the model needs; writes stay compact', async () => {
  const tools = new Map();
  const bridge = {
    editorKind: 'video',
    readState: async () => ({ editorKind: 'video', editorInstanceId: 'i1', documentId: 'p1', revision: 2, stateDigest: 'd2', timeline: { duration: 1, fps: 30, currentTime: 0 }, tracks: [], clips: [], overlays: [], capabilities: {} }),
    applyCommand: async input => ({ editorKind: 'video', documentId: 'p1', commandId: input.commandId, revision: 3, changedObjectIds: [], stateDigest: 'd3' }),
    startExport: async input => ({ editorKind: 'video', commandId: input.commandId, exportId: 'exp-1', status: 'ready', artifactRef: 'artifact://exp-1' }),
    getExportStatus: async () => ({ editorKind: 'video', exportId: 'exp-1', status: 'ready', artifactRef: 'artifact://exp-1' }),
  };
  registerMediaTools({ tools: { register: definition => tools.set(definition.name, definition), guard: () => {} } }, { bridge, approvals: createApprovalStore(), bindings: fixtureBindings });
  const render = (name, args, value) => tools.get(name).output.render(args, value).map(block => block.text).join('\n');
  const startArgs = { editorKind: 'video', projectId: 'p1', instanceId: 'i1', commandId: 'e-1', expectedRevision: 2, format: 'webm' };
  assert.match(render('media_video_export_start', startArgs, await tools.get('media_video_export_start').execute(startArgs, exec)), /exportId exp-1/);
  const statusArgs = { editorKind: 'video', projectId: 'p1', instanceId: 'i1', exportId: 'exp-1' };
  assert.match(render('media_video_export_status', statusArgs, await tools.get('media_video_export_status').execute(statusArgs, exec)), /artifactRef artifact:\/\/exp-1/);
  const applyArgs = { editorKind: 'video', projectId: 'p1', instanceId: 'i1', commandId: 'c-plain', expectedRevision: 2, operation: 'media.video.clip.move', params: {} };
  const applyText = render('media_video_apply_command', applyArgs, await tools.get('media_video_apply_command').execute(applyArgs, exec));
  assert.doesNotMatch(applyText, /exportId|artifactRef/);
});
