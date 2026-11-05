// Video command validation parity with the image guarded-undo contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_VALIDATORS } from '../lib/bridge.js';

const video = command => COMMAND_VALIDATORS.video({ type: 'media.video.history.undo', payload: {}, ...command });

test('video guarded undo accepts the target/digest pair and rejects a half pair', () => {
  assert.doesNotThrow(() => video({ payload: {} }));
  assert.doesNotThrow(() => video({ payload: { targetCommandId: 'cmd-1', afterDigest: 'fnv1a32-00000001' } }));
  assert.throws(() => video({ payload: { targetCommandId: 'cmd-1' } }), { code: 'INVALID_REQUEST' });
  assert.throws(() => video({ payload: { afterDigest: 'fnv1a32-00000001' } }), { code: 'INVALID_REQUEST' });
  assert.throws(() => video({ payload: { targetCommandId: '', afterDigest: 'fnv1a32-00000001' } }), { code: 'INVALID_REQUEST' });
  assert.throws(() => video({ payload: { targetCommandId: 'cmd-1', afterDigest: 'd', extra: true } }), { code: 'INVALID_REQUEST' });
});

test('video redo stays empty, matching the image contract', () => {
  assert.doesNotThrow(() => COMMAND_VALIDATORS.video({ type: 'media.video.history.redo', payload: {} }));
  assert.throws(() => COMMAND_VALIDATORS.video({ type: 'media.video.history.redo', payload: { targetCommandId: 'c1' } }), { code: 'INVALID_REQUEST' });
  assert.throws(() => COMMAND_VALIDATORS.video({ type: 'media.video.history.redo', payload: { afterDigest: 'd1' } }), { code: 'INVALID_REQUEST' });
});


test('video allowlist still rejects unknown operation names', () => {
  assert.throws(() => COMMAND_VALIDATORS.video({ type: 'media.video.history.rewind', payload: {} }), { code: 'UNSUPPORTED_COMMAND' });
});
