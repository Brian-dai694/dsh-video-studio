// Video command validation parity with the image guarded-undo contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_VALIDATORS } from '../lib/bridge.js';
import { HIGH_RISK_OPERATIONS } from '../lib/gate.js';

const video = command => COMMAND_VALIDATORS.video({ type: 'media.video.history.undo', payload: {}, ...command });
const check = (type, payload) => COMMAND_VALIDATORS.video({ type, payload });

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

test('multi-track commands are allowlisted with typed payloads', () => {
  assert.doesNotThrow(() => check('media.video.track.add', { kind: 'audio', trackId: 'audio-2', name: '配音' }));
  assert.doesNotThrow(() => check('media.video.track.add', { kind: 'video' }));
  assert.throws(() => check('media.video.track.add', { kind: 'subtitle' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => check('media.video.track.add', { kind: 'video', trackId: '' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => check('media.video.track.remove', {}), { code: 'INVALID_REQUEST' });
  assert.doesNotThrow(() => check('media.video.track.remove', { trackId: 'audio-2' }));
  assert.doesNotThrow(() => check('media.video.track.update', { trackId: 'audio-2', volume: 1.5, mute: false, solo: true }));
  assert.throws(() => check('media.video.track.update', { trackId: 'audio-2', volume: 2.1 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => check('media.video.track.update', { trackId: 'audio-2', volume: -0.1 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => check('media.video.track.update', { trackId: 'audio-2', mute: 'yes' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => check('media.video.track.update', { trackId: 'audio-2' }), { code: 'INVALID_REQUEST' });
});

test('clip add/move accept multi-track placement but not ambiguous ranges', () => {
  assert.doesNotThrow(() => check('media.video.clip.add', { sourceRef: 'src-1' }));
  assert.doesNotThrow(() => check('media.video.clip.add', { sourceRef: 'src-1', trackId: 'video-2', startUs: 0, inUs: 0, outUs: 1000000 }));
  assert.throws(() => check('media.video.clip.add', { sourceRef: 'src-1', inUs: 0 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => check('media.video.clip.add', { sourceRef: 'src-1', inUs: 1000000, outUs: 1000000 }), { code: 'INVALID_REQUEST' });
  assert.doesNotThrow(() => check('media.video.clip.move', { clipId: 'c1', trackId: 'video-2' }));
  assert.doesNotThrow(() => check('media.video.clip.move', { clipId: 'c1', startUs: 500000 }));
  assert.throws(() => check('media.video.clip.move', { clipId: 'c1' }), { code: 'INVALID_REQUEST' });
});

test('removing a track is human-confirmed because it deletes its clips', () => {
  assert.equal(HIGH_RISK_OPERATIONS.video.has('media.video.track.remove'), true);
  assert.equal(HIGH_RISK_OPERATIONS.video.has('media.video.track.update'), false);
});
