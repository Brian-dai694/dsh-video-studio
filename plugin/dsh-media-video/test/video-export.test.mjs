import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { assertForeground } from '../public/video/video-export.mjs';

let count = 0;
const test = (name, fn) => { fn(); count++; console.log(`PASS ${count}: ${name}`); };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public/video');
const exportSource = readFileSync(resolve(root, 'video-export.mjs'), 'utf8');
const editorSource = readFileSync(resolve(root, 'video.js'), 'utf8');

test('背景标签在开始录制前就被拒绝，并给出可执行的中文提示', () => {
  assert.throws(
    () => assertForeground({ visibilityState: 'hidden' }),
    error => error.code === 'EXPORT_NEEDS_FOREGROUND' && /切换到该标签页/.test(error.message) && !/编码未产生有效数据/.test(error.message),
  );
});

test('前台标签不会被误拦', () => {
  assert.doesNotThrow(() => assertForeground({ visibilityState: 'visible' }));
  assert.doesNotThrow(() => assertForeground(undefined));
});

test('导出前检查发生在创建 MediaRecorder 之前', () => {
  const guard = exportSource.indexOf('assertForeground()');
  const recorder = exportSource.indexOf('new MediaRecorder');
  assert.ok(guard > 0 && recorder > 0, '两个关键步骤都要存在');
  assert.ok(guard < recorder, '必须先在隐藏标签下拒绝，不能先开录制器');
});

test('录制中转入后台会中止并标注原因，而不是产出空文件', () => {
  assert.match(exportSource, /addEventListener\('visibilitychange'/);
  assert.match(exportSource, /interrupted = Object\.assign/);
  assert.match(exportSource, /if \(interrupted\) throw interrupted/);
  assert.match(exportSource, /removeEventListener\('visibilitychange'/);
});

test('工具栏入口同样先做前台检查，避免先建任务再失败', () => {
  const start = editorSource.indexOf('function startExport');
  const guard = editorSource.indexOf('assertForeground()', start);
  const job = editorSource.indexOf('exportJobs.set(job.exportId, job)', start);
  assert.ok(guard > start, 'startExport 内要有前台检查');
  assert.ok(job > guard, '检查必须在创建导出任务之前');
});

console.log(JSON.stringify({ passed: count, scope: 'foreground guard unit + source ordering; real MediaRecorder not exercised' }));
