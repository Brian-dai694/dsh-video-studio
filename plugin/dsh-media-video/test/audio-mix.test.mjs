// 混音口径：volume 线性 → 输出，不压缩；削波只回报峰值并给中文告警，不自动压。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { peakToDb, clipWarning } from '../public/video/video-export.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '../public/video/video-export.mjs'), 'utf8');

test('峰值换算：满刻度 0 dBFS，半幅约 -6.02 dB', () => {
  assert.equal(peakToDb(1), 0);
  assert.equal(peakToDb(0.5).toFixed(2), '-6.02');
  assert.equal(peakToDb(2).toFixed(2), '6.02');
  assert.equal(peakToDb(0), -Infinity);
});

test('削波告警只在 peak > 1.0（0 dBFS 以上）出现，并给出中文可执行提示', () => {
  assert.equal(clipWarning(-6.02), null);
  assert.equal(clipWarning(0), null, '峰值等于 1.0 属于正常，不告警');
  assert.equal(clipWarning(-Infinity), null);
  assert.match(clipWarning(2.5), /混音削波/);
  assert.match(clipWarning(2.5), /\+2\.5 dB/);
  assert.match(clipWarning(2.5), /请降低部分轨道音量/);
});

test('限幅器已经拆掉：源码里不再出现 DynamicsCompressor', () => {
  assert.equal(source.includes('createDynamicsCompressor'), false, '不许偷偷压');
  assert.equal(source.includes('limiter'), false, '不许有限幅节点');
});

test('音频链顺序写死在实现里：trim → 音量 → 输出', () => {
  const comment = source.slice(source.indexOf('混音口径'), source.indexOf('混音口径') + 260);
  assert.match(comment, /trim/);
  assert.match(comment, /音量/);
  assert.match(comment, /输出/);
});

test('音量是线性倍数且不归一化：0..2 直接进 GainNode', () => {
  assert.match(source, /gain\.gain\.value = Math\.max\(0, Math\.min\(2, volume \?\? 1\)\)/);
  assert.equal(/gain\.gain\.value = .*\/(sources|tracks|plan\.audio\.length)/.test(source), false, '不能按轨数除');
});

test('录制过程采样主总线，结果回报 peakDb 与 warning', () => {
  assert.match(source, /samplePeak\(\)/);
  assert.match(source, /peakDb:/);
  assert.match(source, /warning: clipWarning/);
});

test('AudioContext 被浏览器挂起时给中文原因，不会永远停在“导出中…”', () => {
  assert.match(source, /EXPORT_AUDIO_BLOCKED/);
  assert.match(source, /Promise\.race\(\[audioContext\.resume\(\)/, 'resume 必须带超时竞争');
  assert.match(source, /浏览器拦截了音频播放/);
});

test('多次导出复用同一个 AudioContext：不关闭、元素 source 只绑定一次', () => {
  assert.match(source, /let sharedAudioContext = null/);
  assert.match(source, /createMediaElementSource/);
  assert.equal(/await audioContext\.close\(\)/.test(source), false, '共享上下文一旦关闭，第二次导出就会失声');
  assert.match(source, /elementSources\.get\(element\)/, '元素 source 必须缓存复用');
});
