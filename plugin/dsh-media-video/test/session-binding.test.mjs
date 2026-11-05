import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionBindings, trustedSessionId, createApprovalStore } from '../lib/gate.js';
import { registerMediaTools } from '../lib/tools.js';
import { COMMAND_VALIDATORS } from '../lib/bridge.js';
const exec = id => ({ agent: { id, session: { id } } });
const binding = { editorKind: 'video', projectId: 'p1', instanceId: 'i1', pageId: 'page1' };

test('identity uses matching live Agent.session only; string/name/self-reported identity rejected', () => {
  for (const value of [{}, { agent: 's1' }, { agent: { name: 's1' } }, { agent: { id: 's1' } }, { agent: { id: 's1', session: { id: 's2' } } }]) assert.throws(() => trustedSessionId(value), { code: 'SESSION_IDENTITY_REQUIRED' });
  assert.equal(trustedSessionId(exec('s1')), 's1');
});

test('Host register requires verified page ownership, then rejects cross-session, project omission and stale page', () => {
  let page = { pageId: 'page1', sessionId: 's1' };
  const registry = createSessionBindings({ resolvePage: () => page });
  assert.throws(() => registry.register(exec('s2'), binding), { code: 'SESSION_BINDING_MISMATCH' });
  registry.register(exec('s1'), binding);
  assert.equal(registry.assert(exec('s1'), 'video', binding).projectId, 'p1');
  assert.throws(() => registry.assert(exec('s2'), 'video', binding), { code: 'SESSION_BINDING_REQUIRED' });
  assert.throws(() => registry.assert(exec('s1'), 'video', { instanceId: 'i1' }), { code: 'SESSION_BINDING_MISMATCH' });
  assert.doesNotThrow(() => registry.assert(exec('s1'), 'video', binding));
  page = { pageId: 'page2', sessionId: 's1' };
  assert.throws(() => registry.assert(exec('s1'), 'video', binding), { code: 'SESSION_BINDING_STALE' });
  page.pageId = 'page1';
  assert.throws(() => registry.assert(exec('s1'), 'video', binding), { code: 'SESSION_BINDING_STALE' });
});

test('unwired production registration fails closed; no tool reaches editor without identity/binding', async () => {
  assert.throws(() => createSessionBindings().register(exec('s1'), binding), { code: 'SESSION_BINDING_UNAVAILABLE' });
  const tools = new Map(); let calls = 0;
  const bridge = { readState: async () => { calls++; throw new Error('must not reach'); } };
  registerMediaTools({ tools: { register: d => tools.set(d.name, d) } }, { bridge: bridge, approvals: createApprovalStore() });
  for (const [name, tool] of tools) {
    const kind = name.includes('image') ? 'image' : 'video';
    const args = { editorKind: kind, projectId: 'p1', instanceId: 'i1', commandId: 'c1', expectedRevision: 0, operation: kind === 'image' ? 'history.undo' : 'media.video.history.undo', params: {}, format: kind === 'image' ? 'png' : 'webm', exportId: 'x1' };
    for (const context of [{}, exec('s1')]) {
      const result = await tool.execute(args, context);
      assert.equal(result.status, 'rejected');
      assert.match(result.error.code, /^SESSION_(IDENTITY_REQUIRED|BINDING_REQUIRED)$/);
    }
  }
  assert.equal(calls, 0);
});

test('first batch commands validate video microseconds', () => {
  COMMAND_VALIDATORS.video({ type: 'media.video.history.undo', payload: {} });
  COMMAND_VALIDATORS.video({ type: 'media.video.overlay.add', payload: { kind: 'text', text: 'hi', startUs: 0, durationUs: 1000000 } });
  assert.throws(() => COMMAND_VALIDATORS.video({ type: 'media.video.overlay.add', payload: { kind: 'text', text: 'hi', startTime: 0, duration: 1 } }), { code: 'INVALID_REQUEST' });
  assert.throws(() => COMMAND_VALIDATORS.video({ type: 'media.video.clip.move', payload: { clipId: 'c', startUs: 1.5 } }), { code: 'INVALID_REQUEST' });
});
