// 字幕独立轨 + 移动/裁剪语义分离 + 同轨重叠 + 可听态：全部跑真实模块，不打桩。
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { COMMAND_VALIDATORS } from '../lib/bridge.js';
import {
  createProject, createTrack, compositePlan, reduceProject, readState, findClip, TRACK_KINDS,
} from '../public/video/video-state.mjs';

const check = (type, payload) => COMMAND_VALIDATORS.video({ type, payload });
const ids = object => object;

function projectWithTextTrack() {
  const base = createProject();
  const textTrack = Object.assign(createTrack('text', 0), { id: 'text-1' });
  return { ...base, tracks: [base.tracks[0], textTrack] };
}

function withTextClip() {
  const seeded = projectWithTextTrack();
  return reduceProject(seeded, { type: 'media.video.clip.add', clip: { trackId: 'text-1', text: '第一句字幕', start: 1, duration: 3 } });
}

test('字幕是独立轨道类型，默认名带中文标签', () => {
  assert.equal(TRACK_KINDS.includes('text'), true);
  assert.equal(createTrack('text', 0).name, '字幕 1');
  const seeded = projectWithTextTrack();
  assert.equal(seeded.tracks.find(track => track.kind === 'text').name, '字幕 1');
});

test('Host 接受字幕轨，仍拒绝未定义的轨道类型', () => {
  assert.doesNotThrow(() => check('media.video.track.add', { kind: 'text' }));
  assert.throws(() => check('media.video.track.add', { kind: 'subtitle' }), { code: 'INVALID_REQUEST' });
});

test('字幕片段只带文字：不要求 sourceRef，空文字与超长文字被拒', () => {
  assert.doesNotThrow(() => check('media.video.clip.add', { trackId: 'text-1', text: '你好' }));
  assert.throws(() => check('media.video.clip.add', { trackId: 'text-1' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => check('media.video.clip.add', { trackId: 'text-1', text: '   ' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => check('media.video.clip.add', { trackId: 'text-1', text: 'x'.repeat(4001) }), { code: 'INVALID_REQUEST' });
});

test('移动与裁剪在 Host 层就不许互相污染', () => {
  assert.throws(() => check('media.video.clip.trim', { clipId: 'c1', startUs: 0, inUs: 0 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => check('media.video.clip.move', { clipId: 'c1', inUs: 0, outUs: 1000000 }), { code: 'INVALID_REQUEST' });
  assert.doesNotThrow(() => check('media.video.clip.trim', { clipId: 'c1', inUs: 0, outUs: 1000000 }));
  assert.doesNotThrow(() => check('media.video.clip.move', { clipId: 'c1', startUs: 1000000 }));
});

test('trim 只改素材入出点，时间线起点不动', () => {
  const seeded = withTextClip();
  const before = findClip(seeded, seeded.selection).clip;
  assert.equal(before.start, 1);
  const trimmed = reduceProject(seeded, { type: 'media.video.clip.trim', clipId: before.id, in: 0.5, out: 2 });
  const after = findClip(trimmed, before.id).clip;
  assert.equal(after.start, 1, '裁剪后起点必须还是 1');
  assert.equal(after.in, 0.5);
  assert.equal(after.out, 2);
});

test('move 只改起点，素材入出点不动', () => {
  const seeded = withTextClip();
  const before = findClip(seeded, seeded.selection).clip;
  const moved = reduceProject(seeded, { type: 'media.video.clip.move', clipId: before.id, start: 6 });
  const after = findClip(moved, before.id).clip;
  assert.equal(after.start, 6);
  assert.equal(after.in, before.in);
  assert.equal(after.out, before.out);
});

test('同轨重叠在写入时就拒 TRACK_OVERLAP，不靠渲染猜', () => {
  const seeded = withTextClip();
  const overlapping = { type: 'media.video.clip.add', clip: { trackId: 'text-1', text: '第二句', start: 2, duration: 2 } };
  assert.throws(() => reduceProject(seeded, overlapping), error => error.code === 'TRACK_OVERLAP');
  const adjacent = { type: 'media.video.clip.add', clip: { trackId: 'text-1', text: '第二句', start: 4, duration: 2 } };
  assert.doesNotThrow(() => reduceProject(seeded, adjacent), '首尾相接不算重叠');
});

test('move 撞到同轨已有片段也被拒', () => {
  let state = withTextClip();
  state = reduceProject(state, { type: 'media.video.clip.add', clip: { trackId: 'text-1', text: '第二句', start: 5, duration: 2 } });
  const second = state.selection;
  assert.throws(() => reduceProject(state, { type: 'media.video.clip.move', clipId: second, start: 2 }), error => error.code === 'TRACK_OVERLAP');
});

test('合成计划按轨道顺序暴露字幕轨，mute 后不再参与合成', () => {
  const seeded = withTextClip();
  const plan = compositePlan(seeded);
  assert.equal(plan.text.length, 1);
  assert.equal(plan.text[0].clips.length, 1);
  assert.equal(plan.text[0].clips[0].text, '第一句字幕');
  const muted = reduceProject(seeded, { type: 'media.video.track.update', trackId: 'text-1', patch: { mute: true } });
  assert.equal(compositePlan(muted).text.length, 0);
});

test('read_state 给出可听态 effective：solo 优先、字幕轨不可听但可见', () => {
  const seeded = withTextClip();
  const audibleState = readState(seeded, { past: [], present: seeded, future: [] }, 'i1');
  const textTrack = audibleState.tracks.find(track => track.id === 'text-1');
  const videoTrack = audibleState.tracks.find(track => track.kind === 'video');
  assert.equal(textTrack.effective.audible, false, '字幕轨没有音轨，audible 必须为 false');
  assert.equal(textTrack.effective.visible, true);
  assert.equal(videoTrack.effective.audible, true);
  assert.equal(audibleState.tracks.every(track => Number.isInteger(track.order)), true, '每轨都要暴露 order');

  const soloed = readState(reduceProject(seeded, { type: 'media.video.track.update', trackId: 'text-1', patch: { solo: true } }), { past: [], present: seeded, future: [] }, 'i1');
  assert.equal(soloed.tracks.find(track => track.kind === 'video').effective.audible, false, 'solo 非空时非 solo 轨不出声');
  assert.equal(soloed.tracks.find(track => track.id === 'text-1').effective.visible, true);
});

test('片段暴露 sourceTime 形状（微秒、rate=1），状态内部仍走秒制', () => {
  const seeded = withTextClip();
  const state = readState(seeded, { past: [], present: seeded, future: [] }, 'i1');
  const clip = state.clips.find(item => item.text === '第一句字幕');
  assert.deepEqual(clip.sourceTime, { startUs: 0, endUs: 3000000, rate: 1 });
  assert.equal(clip.out, 3);
});

test('导入起点=播放头；跨轨允许重叠，同轨重叠被拒', () => {
  const ui = readFileSync(new URL('../public/video/video.js', import.meta.url), 'utf8');
  assert.match(ui, /start: project\(\)\.timeline\.currentTime \?\? 0/);
  const seeded = reduceProject(projectWithTextTrack(), { type: 'media.video.clip.add', clip: { trackId: 'text-1', text: '底层', start: 0, duration: 4 } });
  const videoTrackId = seeded.tracks.find(track => track.kind === 'video').id;
  // 另一条轨同位置允许（跨轨重叠合法）
  assert.doesNotThrow(() => reduceProject(seeded, { type: 'media.video.clip.add', clip: { trackId: videoTrackId, sourceRef: 'src-1', name: 'v', duration: 4, start: 0, in: 0, out: 4 } }));
});


test('导入起点等于播放头，同位置重复导入按 TRACK_OVERLAP 拒绝并给中文提示', () => {
  const ui = readFileSync(new URL('../public/video/video.js', import.meta.url), 'utf8');
  assert.match(ui, /start: project\(\)\.timeline\.currentTime \?\? 0/);
  const seeded = withTextClip();
  assert.throws(
    () => reduceProject(seeded, { type: 'media.video.clip.add', clip: { trackId: 'text-1', text: '重叠', start: 1, duration: 2 } }),
    error => error.code === 'TRACK_OVERLAP' && /该轨道在此位置已有片段/.test(error.message),
  );
});

test('同一素材可以再放一次：只有元素未加载时才走“媒体重新连接”', () => {
  const ui = readFileSync(new URL('../public/video/video.js', import.meta.url), 'utf8');
  assert.match(ui, /const wasLoaded = !!mediaFor\(ref\)/);
  assert.match(ui, /if \(matched && !wasLoaded\)/);
});
