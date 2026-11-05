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

test('版本号与共享模块一致（dialog-model@1）', async () => {
  const meta = JSON.parse(await readFile(metaUrl, 'utf8'));
  assert.equal(DIALOG_MODEL_VERSION, meta.version);
  assert.equal(DIALOG_MODEL_VERSION, 'dialog-model@1');
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
