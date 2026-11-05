// 内容摘要与 UI 态拆分（docs/version-dag.md 前置）：拖播放头不改内容版本。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProject, createTrack, contentDigest, viewState, reduceProject, readState, stateDigest,
} from '../public/video/video-state.mjs';

const seed = () => {
  const base = createProject();
  const track = Object.assign(createTrack('video', 0), { id: 'v1' });
  const withClip = reduceProject({ ...base, tracks: [track] }, {
    type: 'media.video.clip.add',
    clip: { trackId: 'v1', sourceRef: 'src-1', name: 'clip', duration: 4, start: 0, in: 0, out: 4 },
  });
  return withClip;
};

test('只拖播放头：revision 与 contentDigest 都不变', () => {
  const project = seed();
  const before = { revision: project.revision, digest: contentDigest(project) };
  const seeked = reduceProject(project, { type: 'media.video.timeline.seek', time: 2 });
  assert.equal(seeked.revision, before.revision, 'seek 不应涨 revision');
  assert.equal(contentDigest(seeked), before.digest, 'seek 不应改内容摘要');
  assert.equal(viewState(seeked).currentTime, 2, '播放头属于 viewState');
});

test('改轨道音量/静音：contentDigest 必须变', () => {
  const project = seed();
  const before = contentDigest(project);
  const volume = reduceProject(project, { type: 'media.video.track.update', trackId: 'v1', patch: { volume: 0.5 } });
  assert.notEqual(contentDigest(volume), before);
  const muted = reduceProject(project, { type: 'media.video.track.update', trackId: 'v1', patch: { mute: true } });
  assert.notEqual(contentDigest(muted), before);
  const soloed = reduceProject(project, { type: 'media.video.track.update', trackId: 'v1', patch: { solo: true } });
  assert.notEqual(contentDigest(soloed), before);
});

test('加/删片段：revision 与 contentDigest 都变', () => {
  const project = seed();
  const before = { revision: project.revision, digest: contentDigest(project) };
  const added = reduceProject(project, { type: 'media.video.track.add', track: { kind: 'audio', id: 'a1' } });
  assert.notEqual(added.revision, before.revision);
  assert.notEqual(contentDigest(added), before.digest);
});

test('字幕轨文字进入内容摘要', () => {
  const withText = reduceProject(
    reduceProject(seed(), { type: 'media.video.track.add', track: { kind: 'text', id: 't1' } }),
    { type: 'media.video.clip.add', clip: { trackId: 't1', text: '字幕一', start: 0, duration: 2 } },
  );
  const changed = reduceProject(withText, { type: 'media.video.clip.trim', clipId: withText.selection, in: 0.2, out: 1.5 });
  assert.notEqual(contentDigest(changed), contentDigest(withText));
});

test('read_state 同时给 contentDigest 与 viewState，stateDigest 仍是兼容别名', () => {
  const project = seed();
  const state = readState(project, { past: [], present: project, future: [] }, 'i1');
  assert.equal(typeof state.contentDigest, 'string');
  assert.equal(state.contentDigest, state.stateDigest, 'stateDigest 暂为兼容别名');
  assert.equal(state.viewState.currentTime, 0);
  assert.equal(stateDigest(project), contentDigest(project));
});
