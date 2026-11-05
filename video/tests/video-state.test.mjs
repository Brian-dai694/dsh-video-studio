import assert from 'node:assert/strict';
import { createHistory, createProject, commit, undo, redo, reduceProject, readState, snapshotProject, stateDigest } from '../video-state.mjs';

let count = 0;
const test = (name, fn) => { fn(); count++; console.log(`PASS ${count}: ${name}`); };

const initial = createProject();
let history = createHistory(initial);
let state = initial;
const dispatch = command => { const next = reduceProject(state, command); history = commit(history, next); state = history.present; };

test('single clip add and trim are revisioned commands', () => {
  dispatch({ type: 'media.video.clip.add', clip: { id: 'clip-1', sourceRef: 'local:clip-1', name: 'sample.webm', duration: 12 } });
  assert.equal(state.revision, 1);
  dispatch({ type: 'media.video.clip.trim', clipId: 'clip-1', in: 2, out: 9 });
  assert.equal(state.revision, 2);
  assert.equal(state.timeline.duration, 7);
});
test('move/remove and overlay changes are undoable', () => {
  dispatch({ type: 'media.video.clip.move', clipId: 'clip-1', start: 3 });
  dispatch({ type: 'media.video.overlay.add', overlay: { id: 'title-1', kind: 'text', name: '标题', content: '片头' } });
  const changed = stateDigest(state);
  history = undo(history); state = history.present;
  assert.equal(state.overlays.length, 0);
  assert.notEqual(stateDigest(state), changed);
  history = redo(history); state = history.present;
  assert.equal(stateDigest(state), changed);
  dispatch({ type: 'media.video.clip.remove', clipId: 'clip-1' });
  assert.equal(state.tracks[0].clips.length, 0);
});
test('read state reports stable summary and history, without embedding media', () => {
  const snapshot = readState(state, history, 'instance-1');
  assert.equal(snapshot.editorKind, 'video');
  assert.equal(snapshot.editorInstanceId, 'instance-1');
  assert.equal(snapshot.history.canUndo, true);
  assert.equal(typeof snapshot.stateDigest, 'string');
  assert.equal('bytes' in snapshot, false);
});
test('snapshot restoration retains structure but media remains external', () => {
  const withMedia = reduceProject(createProject(), { type: 'media.video.clip.add', clip: { id: 'saved-clip', sourceRef: 'local:saved', name: 'saved.mp4', duration: 4 } });
  const saved = snapshotProject(withMedia);
  const restored = reduceProject(createProject(), { type: 'media.video.project.restore', project: saved.project });
  assert.deepEqual(restored, withMedia);
  assert.equal(saved.media.embedded, false);
});
test('reject second clip and invalid overlay kinds', () => {
  const withClip = reduceProject(initial, { type: 'media.video.clip.add', clip: { id: 'a', sourceRef: 'local:a', name: 'a', duration: 2 } });
  assert.throws(() => reduceProject(withClip, { type: 'media.video.clip.add', clip: { id: 'b', sourceRef: 'local:b', name: 'b', duration: 2 } }), /仅支持一个/);
  assert.throws(() => reduceProject(initial, { type: 'media.video.overlay.add', overlay: { id: 'x', kind: 'script' } }), /不支持/);
});
test('playback seek does not change content revision or create undo entry', () => {
  const base = reduceProject(initial, { type: 'media.video.clip.add', clip: { id: 'seek-clip', sourceRef: 'local:seek', name: 'seek', duration: 5 } });
  const h = createHistory(base);
  const seeked = reduceProject(base, { type: 'media.video.timeline.seek', time: 2 });
  assert.equal(seeked.revision, base.revision);
  assert.equal(seeked.timeline.currentTime, 2);
  const playbackHistory = { ...h, present: seeked };
  assert.equal(playbackHistory.past.length, 0);
  assert.equal(playbackHistory.present.timeline.currentTime, 2);
});
test('undo and redo revisions remain monotonic; restore creates a new revision', () => {
  let h = createHistory(initial);
  h = commit(h, reduceProject(h.present, { type: 'media.video.clip.add', clip: { id: 'rev-clip', sourceRef: 'local:rev', name: 'rev', duration: 5 } }));
  h = commit(h, reduceProject(h.present, { type: 'media.video.clip.move', clipId: 'rev-clip', start: 1 }));
  h = undo(h);
  assert.equal(h.present.revision, 3);
  h = redo(h);
  assert.equal(h.present.revision, 4);
  const restored = reduceProject(h.present, { type: 'media.video.project.restore', project: snapshotProject(initial).project });
  assert.equal(restored.revision, 5);
});
test('one-sided trim preserves the omitted boundary without NaN', () => {
  const base = reduceProject(createProject(), { type: 'media.video.clip.add', clip: { id: 'one', sourceRef: 'local:one', name: 'one', duration: 12 } });
  const trimmed = reduceProject(base, { type: 'media.video.clip.trim', clipId: 'one', in: 2 });
  assert.equal(trimmed.tracks[0].clips[0].out, 12);
  const endOnly = reduceProject(trimmed, { type: 'media.video.clip.trim', clipId: 'one', out: 8 });
  assert.equal(endOnly.tracks[0].clips[0].in, 2);
  assert.equal(endOnly.timeline.duration, 6);
});
console.log(JSON.stringify({ passed: count, scope: 'pure state/history; browser media APIs not exercised' }));
