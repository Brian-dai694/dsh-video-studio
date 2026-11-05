// 共享对话模型不许漂移：vendor 副本必须与声明 sha256 一致，版本号一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DIALOG_MODEL_VERSION, looksLikeRawJson, buildDialogPlan } from '../public/video/vendor/dialog-model.mjs';

const fileUrl = new URL('../public/video/vendor/dialog-model.mjs', import.meta.url);
const metaUrl = new URL('../public/video/vendor/dialog-model.source.json', import.meta.url);

test('vendor 的 dialog-model.mjs 与声明的 sha256/字节数完全一致', async () => {
  const bytes = await readFile(fileUrl);
  const meta = JSON.parse(await readFile(metaUrl, 'utf8'));
  const sha = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha, meta.sha256, '共享模型被改动过：整份替换并按文档更新 sha256，不要逐个函数改');
  assert.equal(bytes.length, meta.bytes);
});

test('版本号与共享模块一致（dialog-model@3）', async () => {
  const meta = JSON.parse(await readFile(metaUrl, 'utf8'));
  assert.equal(DIALOG_MODEL_VERSION, meta.version);
  assert.equal(DIALOG_MODEL_VERSION, 'dialog-model@3');
});

test('fill-undo：凭据进计划、动作自带整句 prompt，非法凭据整个动作不出现', () => {
  const undo = { commandId: 'cmd-1', appliedRevision: 3, afterDigest: 'fnv1a64-0123456789abcdef' };
  const [ok] = buildDialogPlan([{ id: 'u1', role: 'tool', card: { name: 'x', status: 'applied' }, undo }]);
  const action = ok.actions.find(item => item.kind === 'fill-undo');
  assert.ok(action, '合法凭据必须给出 fill-undo');
  assert.deepEqual(action.undo, undo);
  assert.ok(action.prompt.includes('cmd-1'), 'prompt 必须含 targetCommandId');
  assert.ok(action.prompt.includes('HISTORY_CONFLICT'), 'prompt 必须含 HISTORY_CONFLICT 提示');
  assert.equal(action.kind === 'undo', false, '不允许直接执行撤销');

  for (const bad of [
    { appliedRevision: 3, afterDigest: undo.afterDigest },
    { commandId: 'c', appliedRevision: 3.5, afterDigest: undo.afterDigest },
    { commandId: 'c', appliedRevision: 3, afterDigest: 'not-a-digest' },
    { commandId: 'c', appliedRevision: -1, afterDigest: undo.afterDigest },
  ]) {
    const [plan] = buildDialogPlan([{ id: 'u2', role: 'tool', card: { name: 'x', status: 'applied' }, undo: bad }]);
    assert.equal(plan.actions.some(item => item.kind === 'fill-undo'), false, `非法凭据不许占位：${JSON.stringify(bad)}`);
  }
});

test('download-export：export 引用透传，缺 exportId 时没有按钮', () => {
  const [ok] = buildDialogPlan([{ id: 'd1', role: 'tool', card: { name: 'x', status: 'applied' }, exportRef: { exportId: 'export-1', format: 'webm' } }]);
  const action = ok.actions.find(item => item.kind === 'download-export');
  assert.ok(action, '有 exportId 必须给出按钮');
  assert.equal(action.export.exportId, 'export-1');

  const [missing] = buildDialogPlan([{ id: 'd2', role: 'tool', card: { name: 'x', status: 'applied' }, exportRef: {} }]);
  assert.equal(missing.actions.some(item => item.kind === 'download-export'), false, '缺 exportId 不许占位');
});

test('locate 透传：合法输入原样进入计划，非法输入整体省略', () => {
  const [ok] = buildDialogPlan([{
    id: 't1', role: 'tool', card: { name: '时间线命令', status: 'applied' },
    locate: { objectIds: ['clip-1', 'clip-2'], kind: 'clip' },
  }]);
  assert.deepEqual(ok.locate, { objectIds: ['clip-1', 'clip-2'], kind: 'clip' });

  const [track] = buildDialogPlan([{ id: 't2', role: 'tool', card: { name: 'x', status: 'applied' }, locate: { objectIds: ['track-1'], kind: 'track' } }]);
  assert.deepEqual(track.locate, { objectIds: ['track-1'], kind: 'track' }, 'track 必须在白名单内');

  for (const bad of [
    { objectIds: [], kind: 'clip' },
    { objectIds: [123], kind: 'clip' },
    { objectIds: ['clip-1'], kind: 'bogus' },
    { objectIds: 'clip-1', kind: 'clip' },
  ]) {
    const [plan] = buildDialogPlan([{ id: 't3', role: 'tool', card: { name: 'x', status: 'applied' }, locate: bad }]);
    assert.equal('locate' in plan, false, `非法 locate 必须整体省略：${JSON.stringify(bad)}`);
  }
});

test('短 JSON 在错误行/工具回执上也算裸 JSON（不再被 40 字符阈值放过）', () => {
  const short = '{"code":"REVISION_CONFLICT"}';
  const [error] = buildDialogPlan([{ id: 'e2', role: 'error', text: short }]);
  assert.equal(JSON.stringify(error.blocks).includes('REVISION_CONFLICT'), false);
  const [tool] = buildDialogPlan([{ id: 't4', role: 'tool', card: { name: 'x', status: 'applied', line: short } }]);
  assert.equal((tool.card?.line || '').includes('REVISION_CONFLICT'), false);
  assert.equal(tool.diagnostic, short, '原文只能进 diagnostic');
});

test('计划输出不含裸 JSON：错误行与工具行都必须兜底', () => {
  const json = '{"code":"REVISION_CONFLICT","message":"工程已被修改","revision":3}';
  const plans = buildDialogPlan([
    { id: 'e1', role: 'error', text: json },
    { id: 't1', role: 'tool', card: { name: '时间线命令', status: 'applied', line: json } },
  ]);
  for (const plan of plans) {
    const rendered = JSON.stringify({ blocks: plan.blocks, card: plan.card, title: plan.title });
    assert.equal(rendered.includes('REVISION_CONFLICT'), false, '裸 JSON 不能进渲染字段');
  }
  assert.ok(looksLikeRawJson(json));
});

test('共享模型：审批只有 open-native，撤销只有 fill-undo', () => {
  const [approval] = buildDialogPlan([{ id: 'a1', role: 'approval', decided: false }]);
  assert.deepEqual(approval.actions.map(action => action.kind), ['open-native']);
  const [undo] = buildDialogPlan([{ id: 'u1', role: 'tool', card: { name: 'x', status: 'applied' }, undo: { commandId: 'c', appliedRevision: 1, afterDigest: 'fnv1a64-0123456789abcdef' } }]);
  assert.equal(undo.actions.some(action => action.kind === 'fill-undo'), true);
  assert.equal(undo.actions.some(action => action.kind === 'undo'), false, '不允许直接执行撤销');
});
