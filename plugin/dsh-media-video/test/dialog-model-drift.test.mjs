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

test('版本号与共享模块一致（dialog-model@2）', async () => {
  const meta = JSON.parse(await readFile(metaUrl, 'utf8'));
  assert.equal(DIALOG_MODEL_VERSION, meta.version);
  assert.equal(DIALOG_MODEL_VERSION, 'dialog-model@2');
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
  const [undo] = buildDialogPlan([{ id: 'u1', role: 'tool', card: { name: 'x', status: 'applied' }, undo: { commandId: 'c', appliedRevision: 1, afterDigest: 'd' } }]);
  assert.equal(undo.actions.some(action => action.kind === 'fill-undo'), true);
  assert.equal(undo.actions.some(action => action.kind === 'undo'), false, '不允许直接执行撤销');
});
