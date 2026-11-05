// Editor-side half of the iframe bridge (video plugin).
// The parent page owns the relay; this module only serves the transferred MessagePort,
// validates the envelope and forwards structured commands to the editor state source.

const CORE_TYPES = new Set(['editor.read_state', 'editor.apply_command', 'editor.get_command_result', 'editor.export_start', 'editor.export_status', 'editor.highlight']);
const SELECTION_THROTTLE_MS = 100;
const DEFAULT_HIGHLIGHT_TTL_MS = 2000;
const MIN_HIGHLIGHT_TTL_MS = 200;
const MAX_HIGHLIGHT_TTL_MS = 5000;
const US = 1_000_000;
const toSeconds = value => Number(value) / US;
const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const payloadTarget = p => !!(p?.targetCommandId || p?.afterDigest);

export function toEditorCommand(command) {
  if (!isObject(command) || typeof command.type !== 'string' || !isObject(command.payload)) throw failure('UNSUPPORTED_COMMAND', '命令不是结构化的视频命令');
  const p = command.payload;
  switch (command.type) {
    case 'media.video.history.undo':
    case 'media.video.history.redo':
      return { type: command.type };
    case 'media.video.clip.add':
      if (typeof p.sourceRef !== 'string' || !p.sourceRef) throw failure('INVALID_REQUEST', '缺少 sourceRef');
      return { type: 'media.video.clip.add', clip: { id: p.clipId || null, sourceRef: p.sourceRef, name: p.name || p.sourceRef, duration: toSeconds(Math.max(Number(p.outUs) || 0, Number(p.inUs) || 0)), in: toSeconds(Number(p.inUs) || 0), out: toSeconds(Number(p.outUs) || 0), start: toSeconds(Number(p.startUs) || 0), trackId: p.trackId || undefined } };
    case 'media.video.clip.trim':
      return { type: 'media.video.clip.trim', clipId: p.clipId, in: p.inUs === undefined ? undefined : toSeconds(p.inUs), out: p.outUs === undefined ? undefined : toSeconds(p.outUs) };
    case 'media.video.clip.move':
      return { type: 'media.video.clip.move', clipId: p.clipId, start: p.startUs === undefined ? undefined : toSeconds(p.startUs), trackId: p.trackId || undefined };
    case 'media.video.track.add':
      if (!['video', 'audio'].includes(p.kind)) throw failure('INVALID_REQUEST', '轨道类型必须是 video 或 audio');
      return { type: 'media.video.track.add', track: { kind: p.kind, name: p.name, id: p.trackId || undefined } };
    case 'media.video.track.remove':
      return { type: 'media.video.track.remove', trackId: p.trackId };
    case 'media.video.track.update':
      return { type: 'media.video.track.update', trackId: p.trackId, patch: { mute: p.mute, solo: p.solo, volume: p.volume, name: p.name } };
    case 'media.video.clip.remove':
      return { type: 'media.video.clip.remove', clipId: p.clipId };
    case 'media.video.overlay.add':
      if (!['text', 'image'].includes(p.kind)) throw failure('INVALID_REQUEST', '不支持的叠加类型');
      return { type: 'media.video.overlay.add', overlay: { id: p.overlayId || null, kind: p.kind, name: p.kind === 'text' ? String(p.text || '').slice(0, 18) : (p.sourceRef || '图片'), content: p.kind === 'text' ? p.text : null, sourceRef: p.kind === 'image' ? p.sourceRef : null, start: p.startUs === undefined ? undefined : toSeconds(p.startUs), end: p.durationUs === undefined ? undefined : toSeconds(p.startUs || 0) + toSeconds(p.durationUs) } };
    case 'media.video.overlay.update':
      return { type: 'media.video.overlay.update', overlayId: p.overlayId, patch: { content: p.text, visible: p.visible, start: p.startUs === undefined ? undefined : toSeconds(p.startUs), end: p.durationUs === undefined ? undefined : toSeconds(p.startUs || 0) + toSeconds(p.durationUs) } };
    default:
      throw failure('UNSUPPORTED_COMMAND', '命令不在视频白名单内');
  }
}

export function createEditorBridge({ instanceId, getState, applyCommand, getCommandResult = null,
  exportStart = null, exportStatus = null, highlight = null, targetWindow = globalThis, expectedOrigin = null }) {
  if (typeof instanceId !== 'string' || !instanceId) throw new TypeError('instanceId is required');
  if (typeof getState !== 'function' || typeof applyCommand !== 'function') throw new TypeError('getState/applyCommand are required');
  const completed = new Map();
  const inFlight = new Map();
  let port = null;
  let disposed = false;

  function reject(error) {
    return { ok: false, error: { code: error?.code || 'EDITOR_ERROR', message: error?.message || '编辑器执行失败', revision: error?.revision, outcomeUnknown: !!error?.outcomeUnknown } };
  }

  const objectIds = state => new Set([...(state?.clips || []).map(item => item.id), ...(state?.overlays || []).map(item => item.id), ...(state?.tracks || []).map(item => item.id)]);

  async function applyOne(message) {
    const state = getState();
    if (message.editorInstanceId !== instanceId) throw failure('EDITOR_INSTANCE_MISMATCH', '编辑器实例不匹配');
    if (typeof message.documentId !== 'string' || message.documentId !== state.documentId) throw failure('DOCUMENT_MISMATCH', '当前打开的工程已变化');
    if (typeof message.commandId !== 'string' || !message.commandId) throw failure('INVALID_REQUEST', '缺少 commandId');
    const key = message.commandId;
    // A repeated commandId is a query for the original outcome, never a second write.
    if (completed.has(key)) return completed.get(key);
    if (inFlight.has(key)) return inFlight.get(key);
    if (!Number.isSafeInteger(message.expectedRevision) || message.expectedRevision !== state.revision) throw failure('REVISION_CONFLICT', '工程已被修改，请重新读取预览', { revision: state.revision });
    const operation = (async () => {
      const editorCommand = toEditorCommand(message.command);
      const beforeIds = objectIds(state);
      const targeted = message.command.type === 'media.video.history.undo' && payloadTarget(message.command.payload);
      if (targeted) {
        const p = message.command.payload;
        const original = completed.get(p.targetCommandId);
        if (!original || original.revision !== state.revision || original.afterDigest !== state.stateDigest || p.afterDigest !== state.stateDigest || state.history?.topCommandId !== p.targetCommandId) throw failure('HISTORY_CONFLICT', '后续修改或历史栈已变化，不能定向撤销');
      }
      const result = await applyCommand(editorCommand, { commandId: key });
      const after = getState();
      if (after.documentId !== state.documentId || after.revision !== state.revision + 1) throw failure('AUDIT_MISMATCH', '写入后工程或修订不符合单次提交约定', { outcomeUnknown: true });
      const afterIds = objectIds(after);
      const payload = message.command.payload || {};
      const changed = new Set([...(result?.changedObjectIds || []), payload.clipId, payload.overlayId].filter(Boolean));
      for (const id of afterIds) if (!beforeIds.has(id)) changed.add(id);
      for (const id of beforeIds) if (!afterIds.has(id)) changed.add(id);
      const output = { editorKind: 'video', documentId: after.documentId, commandId: key, revision: after.revision, appliedRevision: after.revision, afterDigest: after.stateDigest, changedObjectIds: [...changed] };
      completed.set(key, output);
      return output;
    })();
    inFlight.set(key, operation);
    try { return await operation; } finally { inFlight.delete(key); }
  }

  async function handle(message) {
    if (!isObject(message) || typeof message.requestId !== 'string' || !message.requestId) throw failure('INVALID_REQUEST', '缺少 requestId');
    if (!CORE_TYPES.has(message.type)) throw failure('INVALID_REQUEST', '不支持此消息类型');
    if (message.type === 'editor.read_state') return getState();
    if (message.type === 'editor.export_start' || message.type === 'editor.export_status') {
      const state = getState();
      if (message.editorInstanceId !== instanceId || message.documentId !== state.documentId) throw failure('DOCUMENT_MISMATCH', '导出目标工程不匹配');
      const handler = message.type === 'editor.export_start' ? exportStart : exportStatus;
      if (typeof handler !== 'function') throw failure('EXPORT_UNAVAILABLE', '当前编辑器尚不支持此导出');
      if (message.type === 'editor.export_start' && message.expectedRevision !== state.revision) throw failure('REVISION_CONFLICT', '导出前工程已变化');
      return handler(message);
    }
    if (message.type === 'editor.highlight') {
      // 只改描边：不碰 selection、不 bump revision、不进历史。没有高亮能力就明确报错。
      if (message.editorInstanceId !== instanceId) throw failure('EDITOR_INSTANCE_MISMATCH', '编辑器实例不匹配');
      if (typeof highlight !== 'function') throw failure('HIGHLIGHT_UNSUPPORTED', '当前编辑器尚不支持高亮');
      const ids = message.objectIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string' || !id)) throw failure('INVALID_REQUEST', 'objectIds 必须是非空字符串数组');
      const requested = message.ttlMs === undefined ? DEFAULT_HIGHLIGHT_TTL_MS : Number(message.ttlMs);
      if (!Number.isFinite(requested)) throw failure('INVALID_REQUEST', 'ttlMs 必须是数字');
      const ttl = Math.min(MAX_HIGHLIGHT_TTL_MS, Math.max(MIN_HIGHLIGHT_TTL_MS, Math.round(requested)));
      const result = highlight({ objectIds: ids, ttlMs: ttl }) || {};
      return { ok: true, matched: [...(result.matched || [])], missing: [...(result.missing || [])] };
    }
    if (message.type === 'editor.get_command_result') {
      if (typeof message.commandId !== 'string' || !message.commandId) throw failure('INVALID_REQUEST', '缺少 commandId');
      if (typeof getCommandResult === 'function') return getCommandResult(message.commandId);
      return completed.has(message.commandId)
        ? { status: 'applied', originalResult: completed.get(message.commandId) }
        : { status: 'unknown', originalResult: null };
    }
    return applyOne(message);
  }

  function onPortMessage(event) {
    const message = event?.data;
    if (!isObject(message) || typeof message.requestId !== 'string') return;
    const reply = result => { try { port?.postMessage({ requestId: message.requestId, ...result }); } catch { /* port closed */ } };
    Promise.resolve().then(() => handle(message)).then(value => reply({ ok: true, result: value }), error => reply(reject(error)));
  }

  function onWindowMessage(event) {
    if (disposed) return;
    if (expectedOrigin && new URL(expectedOrigin).origin !== event.origin) return;
    const data = event?.data;
    if (!isObject(data) || data.type !== 'dsh.editor.connect' || typeof data.requestId !== 'string') return;
    const next = event.ports?.[0];
    if (!next) return;
    port?.close?.();
    port = next;
    port.onmessage = onPortMessage;
    port.start?.();
    port.postMessage({ requestId: data.requestId, ok: true, result: { ready: true, contractVersion: 1, editorInstanceId: instanceId } });
  }

  targetWindow.addEventListener?.('message', onWindowMessage);

  // 只读通知：编辑器选中变化 → 宿主（≥100ms 节流）。不是请求，没有 requestId，宿主不得回写。
  let selectionTimer = null;
  let pendingSelection = null;
  let lastSentAt = 0;
  function flushSelection() {
    selectionTimer = null;
    if (!pendingSelection) return;
    const payload = pendingSelection;
    pendingSelection = null;
    lastSentAt = Date.now();
    try { port?.postMessage(payload); } catch { /* port closed */ }
  }
  function notifySelection({ selectedObjectIds = [], objectKind = null } = {}) {
    if (disposed || !port) return;
    const state = getState();
    pendingSelection = {
      type: 'editor.selection_changed', instanceId, revision: state.revision,
      selectedObjectIds: [...selectedObjectIds], objectKind,
    };
    const wait = Math.max(0, SELECTION_THROTTLE_MS - (Date.now() - lastSentAt));
    if (selectionTimer) return;
    if (wait === 0) flushSelection();
    else selectionTimer = setTimeout(flushSelection, wait);
  }

  return {
    get instanceId() { return instanceId; },
    get connected() { return !!port; },
    notifySelection,
    dispose() {
      disposed = true;
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = null;
      pendingSelection = null;
      targetWindow.removeEventListener?.('message', onWindowMessage);
      port?.close?.();
      port = null;
    }
  };
}
