import { readFileSync as readUi } from 'node:fs';
// 音频路由契约：视频轨音量真正生效、同一素材不允许两处发声、回执同时给 peak 与 peakDb。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createProject, createTrack, compositePlan, reduceProject, readState } from '../public/video/video-state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const exportSource = readFileSync(join(here, '../public/video/video-export.mjs'), 'utf8');
const stateSource = readFileSync(join(here, '../public/video/video-state.mjs'), 'utf8');

const ids = { video: 'video-1', audio: 'audio-1' };
function seeded() {
  const base = createProject();
  const video = Object.assign(createTrack('video', 0), { id: ids.video });
  const audio = Object.assign(createTrack('audio', 1), { id: ids.audio });
  return { ...base, tracks: [video, audio] };
}
const addClip = (project, trackId, sourceRef) => reduceProject(project, {
  type: 'media.video.clip.add',
  clip: { trackId, sourceRef, name: 'clip', duration: 4, start: 0, in: 0, out: 4 },
});

test('视频轨的 volume 进入 read_state 的 effective.gain，不再报 null', () => {
  let project = seeded();
  const quiet = reduceProject(project, { type: 'media.video.track.update', trackId: ids.video, patch: { volume: 0.5 } });
  const state = readState(quiet, { past: [], present: quiet, future: [] }, 'i1');
  const videoTrack = state.tracks.find(track => track.kind === 'video');
  assert.equal(videoTrack.effective.gain, 0.5, '视频轨音量必须可被 read_state 看到');
  assert.equal(videoTrack.effective.audible, true);
});

test('导出音频链按视频轨自身 volume 接入，不再写死 1', () => {
  assert.match(exportSource, /attachOnce\(clip\.sourceRef, track\.volume \?\? 1\)/, '视频/音频轨都必须用轨道音量');
  assert.equal(/attach\(elements\.get\(clip\.sourceRef\), 1\)/.test(exportSource), false, '不许再写死 1');
});

test('同一素材不允许两条轨道同时发声：写入即拒 DUPLICATE_AUDIO_SOURCE', () => {
  const project = addClip(seeded(), ids.video, 'src-1');
  assert.throws(
    () => addClip(project, ids.audio, 'src-1'),
    error => error.code === 'DUPLICATE_AUDIO_SOURCE',
  );
});

test('原轨静音后允许另一轨引用同一素材（解法在错误信息里给出）', () => {
  const project = addClip(seeded(), ids.video, 'src-1');
  const muted = reduceProject(project, { type: 'media.video.track.update', trackId: ids.video, patch: { mute: true } });
  assert.doesNotThrow(() => addClip(muted, ids.audio, 'src-1'));
});

test('导出期还有一道保险：重复音频源直接抛错，不做求和兜底', () => {
  assert.match(exportSource, /DUPLICATE_AUDIO_SOURCE/);
  assert.match(exportSource, /seenAudioRefs/);
});

test('回执同时给 peak（线性）与 peakDb（dBFS），判定只认 peakDb', () => {
  assert.match(exportSource, /peak: Number\(audioGraph\.peakValue\(\)\.toFixed\(4\)\)/);
  assert.match(exportSource, /peakDb: Number\.isFinite/);
  assert.match(exportSource, /warning: clipWarning/);
});

test('状态层给了重复音频源的检查函数，并在 add/move 两条路径调用', () => {
  assert.match(stateSource, /function assertUniqueAudioSource/);
  const calls = (stateSource.match(/assertUniqueAudioSource\(next,/g) || []).length;
  assert.equal(calls, 2, 'clip.add 与 clip.move 都要查');
});

test('compositePlan 的 video 分支必须带出 volume（否则导出端拿不到轨道音量）', () => {
  const base = createProject();
  const video = Object.assign(createTrack('video', 0), { id: 'v-plan' });
  const project = { ...base, tracks: [video] };
  const plan = compositePlan(project);
  assert.equal(plan.video.length, 1);
  assert.equal(plan.video[0].volume, 1, '默认音量要出现在计划里');
  assert.equal(compositePlan({ ...project, tracks: [{ ...video, volume: 0.5 }] }).video[0].volume, 0.5);
});

test('静音视频轨只静声音：画面仍在计划里，音量归零', () => {
  const base = createProject();
  const video = Object.assign(createTrack('video', 0), { id: 'v-mute' });
  const project = { ...base, tracks: [video], clips: [] };
  const plan = compositePlan(project);
  assert.equal(plan.video.length, 1, '静音后画面必须还在');
  assert.equal(plan.video[0].volume, 1);
  const muted = compositePlan({ ...project, tracks: [{ ...video, mute: true }] });
  assert.equal(muted.video.length, 1, '静音不等于隐藏，画面必须保留');
  assert.equal(muted.video[0].volume, 0, '静音后该轨增益为 0');
});

test('纯音频工程导出时给能力限制文案，而不是“工程坏了”的口吻', () => {
  assert.match(exportSource, /纯音频工程暂不支持导出视频，请至少放入一个视频片段/);
  assert.equal(exportSource.includes("'工程中没有可导出的视频片段'"), false);
});

test('UI 层的空工程文案与引擎一致，不再说“工程中没有可导出的视频片段”', () => {
  const ui = readUi(join(here, '../public/video/video.js'), 'utf8');
  assert.match(ui, /纯音频工程暂不支持导出视频，请至少放入一个视频片段/);
  assert.equal(ui.includes("'工程中没有可导出的视频片段'"), false);
});
