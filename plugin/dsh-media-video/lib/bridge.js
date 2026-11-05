// Editor adapter for the video editor.
// Owns validation, idempotency, expectedRevision and unknown-outcome semantics.
// It never stores document state: the editor page is the only state owner.

const DEFAULT_TIMEOUT_MS = 10_000;

export class MediaBridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MediaBridgeError';
    this.code = code;
    Object.assign(this, details);
  }
}

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const opaqueId = (value, name) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new MediaBridgeError('INVALID_REQUEST', `${name} must be a non-empty string up to 256 characters.`);
  }
};
const finite = (value, name, { min = -Infinity, max = Infinity } = {}) => {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new MediaBridgeError('INVALID_REQUEST', `${name} is outside the supported range.`);
  }
};

const VIDEO_COMMANDS = new Set(['media.video.clip.add', 'media.video.clip.trim', 'media.video.clip.move', 'media.video.clip.remove', 'media.video.track.add', 'media.video.track.remove', 'media.video.track.update', 'media.video.overlay.add', 'media.video.overlay.update', 'media.video.history.undo', 'media.video.history.redo']);
const fieldsOnly = (payload, fields) => {
  const unknown = Object.keys(payload).find(key => !fields.includes(key));
  if (unknown) throw new MediaBridgeError('INVALID_REQUEST', `Unsupported payload field: ${unknown}. Read the operation parameter contract.`);
};

export const ALLOWED_COMMANDS = { video: VIDEO_COMMANDS };

// 图片命令校验：白名单 + 逐字段类型/范围检查，必须在发给编辑器之前拒绝。
// 重点边界：canvas 尺寸 1..16384 像素、crop 的 x/y 非负、transform 必须平铺字段、
// 带守卫的撤销必须同时给 targetCommandId 与 afterDigest。

// 视频命令校验：时间一律整数微秒（1 秒 = 1000000），拒绝 startTime/duration 这类秒字段。
// 重点边界：track 音量 0..2、track.update 至少改一项、clip 的 inUs/outUs 必须成对、
// clip.move 至少要给起点或目标轨道；跨轨同类型判断需要轨道状态，留给编辑器。
function validateVideoCommand(command) {
  const p = command.payload;
  if (!VIDEO_COMMANDS.has(command.type)) throw new MediaBridgeError('UNSUPPORTED_COMMAND', 'Command is not in the video allowlist.');
  if (!isObject(p)) throw new MediaBridgeError('INVALID_REQUEST', 'Command payload must be an object.');
  // Guarded undo mirrors the image contract: `{}` is a plain undo, while
  // targetCommandId + afterDigest must be supplied together. The editor then checks the
  // original command, revision, digest and native history top before undoing.
  if (command.type === 'media.video.history.undo') {
    fieldsOnly(p, ['targetCommandId', 'afterDigest']);
    if ((p.targetCommandId === undefined) !== (p.afterDigest === undefined)) {
      throw new MediaBridgeError('INVALID_REQUEST', 'Guarded undo needs both targetCommandId and afterDigest, or neither.');
    }
    if (p.targetCommandId !== undefined) { opaqueId(p.targetCommandId, 'targetCommandId'); opaqueId(p.afterDigest, 'afterDigest'); }
  }
  if (command.type === 'media.video.history.redo') fieldsOnly(p, []);
  for (const key of ['startTime', 'duration', 'inTime', 'outTime']) {
    if (p[key] !== undefined) throw new MediaBridgeError('INVALID_REQUEST', `Use integer microseconds startUs/durationUs/inUs/outUs, not ${key}; 1 second = 1000000 microseconds.`);
  }
  for (const key of ['startUs', 'durationUs', 'inUs', 'outUs']) {
    if (p[key] !== undefined && !Number.isSafeInteger(p[key])) throw new MediaBridgeError('INVALID_REQUEST', `${key} must be integer microseconds.`);
  }
  switch (command.type) {
    case 'media.video.clip.add':
      opaqueId(p.sourceRef, 'sourceRef');
      if (p.trackId !== undefined) opaqueId(p.trackId, 'trackId');
      if (p.startUs !== undefined) finite(p.startUs, 'startUs', { min: 0 });
      // in/out define the trim range together: half a range is ambiguous, so reject it
      // here instead of letting the editor guess. Omitting both imports the whole source.
      if ((p.inUs === undefined) !== (p.outUs === undefined)) {
        throw new MediaBridgeError('INVALID_REQUEST', 'Provide both inUs and outUs, or neither (import the whole source).');
      }
      if (p.inUs !== undefined) {
        finite(p.inUs, 'inUs', { min: 0 }); finite(p.outUs, 'outUs', { min: 0 });
        if (p.outUs <= p.inUs) throw new MediaBridgeError('INVALID_REQUEST', 'outUs must be greater than inUs.');
      }
      break;
    case 'media.video.track.add':
      if (!['video', 'audio'].includes(p.kind)) throw new MediaBridgeError('INVALID_REQUEST', 'Track kind must be video or audio.');
      if (p.trackId !== undefined) opaqueId(p.trackId, 'trackId');
      if (p.name !== undefined && (typeof p.name !== 'string' || p.name.length > 120)) throw new MediaBridgeError('INVALID_REQUEST', 'Track name must be a string up to 120 characters.');
      break;
    case 'media.video.track.remove':
      opaqueId(p.trackId, 'trackId');
      break;
    case 'media.video.track.update':
      opaqueId(p.trackId, 'trackId');
      if (p.mute !== undefined && typeof p.mute !== 'boolean') throw new MediaBridgeError('INVALID_REQUEST', 'mute must be boolean.');
      if (p.solo !== undefined && typeof p.solo !== 'boolean') throw new MediaBridgeError('INVALID_REQUEST', 'solo must be boolean.');
      if (p.volume !== undefined) finite(p.volume, 'volume', { min: 0, max: 2 });
      if (p.name !== undefined && (typeof p.name !== 'string' || p.name.length > 120)) throw new MediaBridgeError('INVALID_REQUEST', 'Track name must be a string up to 120 characters.');
      if (['mute', 'solo', 'volume', 'name'].every(key => p[key] === undefined)) throw new MediaBridgeError('INVALID_REQUEST', 'Provide at least one of mute, solo, volume or name.');
      break;
    case 'media.video.clip.trim':
      opaqueId(p.clipId, 'clipId');
      if (p.inUs === undefined && p.outUs === undefined) throw new MediaBridgeError('INVALID_REQUEST', 'At least one trim boundary is required.');
      if (p.inUs !== undefined) finite(p.inUs, 'inUs', { min: 0 });
      if (p.outUs !== undefined) finite(p.outUs, 'outUs', { min: 0 });
      break;
    case 'media.video.clip.move':
      opaqueId(p.clipId, 'clipId');
      if (p.trackId !== undefined) opaqueId(p.trackId, 'trackId');
      if (p.startUs !== undefined) finite(p.startUs, 'startUs', { min: 0 });
      if (p.startUs === undefined && p.trackId === undefined) throw new MediaBridgeError('INVALID_REQUEST', 'Provide startUs, trackId, or both to move a clip.');
      break;
    case 'media.video.clip.remove':
      opaqueId(p.clipId, 'clipId');
      break;
    case 'media.video.overlay.add':
      if (!['text', 'image'].includes(p.kind)) throw new MediaBridgeError('INVALID_REQUEST', 'Overlay kind must be text or image.');
      if (p.kind === 'text' && (typeof p.text !== 'string' || p.text.length > 4000)) throw new MediaBridgeError('INVALID_REQUEST', 'Text overlay must be at most 4000 characters.');
      if (p.kind === 'image') opaqueId(p.sourceRef, 'sourceRef');
      finite(p.startUs, 'startUs', { min: 0 }); finite(p.durationUs, 'durationUs', { min: 1 });
      break;
    case 'media.video.overlay.update':
      opaqueId(p.overlayId, 'overlayId');
      if (p.startUs !== undefined) finite(p.startUs, 'startUs', { min: 0 });
      if (p.durationUs !== undefined) finite(p.durationUs, 'durationUs', { min: 1 });
      if (p.text !== undefined && (typeof p.text !== 'string' || p.text.length > 4000)) throw new MediaBridgeError('INVALID_REQUEST', 'Text overlay must be at most 4000 characters.');
      if (p.visible !== undefined && typeof p.visible !== 'boolean') throw new MediaBridgeError('INVALID_REQUEST', 'visible must be boolean.');
      break;
  }
}

export const COMMAND_VALIDATORS = { video: validateVideoCommand };

// 编辑器状态校验：只要求必需字段存在且类型正确，不禁止额外字段（如 trackClips、
// capabilities.multitrack），这样编辑器扩展状态时 Host 不用跟着改。

// 视频状态额外要求 timeline/tracks/clips 三个数组都在，避免只给 trackClips 时
// Host 误当成有效状态；其余扩展字段照旧放行。
function validateVideoState(state, instanceId) {
  if (!isObject(state) || state.editorKind !== 'video' || state.editorInstanceId !== instanceId ||
      typeof state.documentId !== 'string' || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !isObject(state.timeline) || !Number.isFinite(state.timeline.duration) ||
      (state.timeline.fps !== null && (!Number.isFinite(state.timeline.fps) || state.timeline.fps <= 0)) ||
      !Array.isArray(state.tracks) || !Array.isArray(state.clips) || !isObject(state.capabilities)) {
    throw new MediaBridgeError('EDITOR_ERROR', 'Video editor returned an invalid state or missing capabilities.');
  }
  return state;
}

export const STATE_VALIDATORS = { video: validateVideoState };

// 编辑器适配器：文档状态只由页面持有，这里只做校验、幂等、版本与"结果未知"语义。
// completed 命中直接回放首份回执；inFlight 合并同 commandId 并发；uncertain 里挂的
// 命令一律拒绝重放，必须先按 commandId 查询原结果。
export function createMediaBridge({ relay, editorKind = 'video', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!relay || typeof relay.request !== 'function') throw new TypeError('relay.request is required');
  if (editorKind !== 'video') throw new TypeError('editorKind must be "video"');
  const completed = new Map();
  const inFlight = new Map();
  const uncertain = new Map();
  const validateState = STATE_VALIDATORS[editorKind];
  const validateCommand = COMMAND_VALIDATORS[editorKind];
  const keyOf = (instanceId, commandId) => `${instanceId}\0${commandId}`;

  // 单次编辑器请求：超时对只读是 EDITOR_TIMEOUT，对写是 OUTCOME_UNKNOWN，
  // 后者表示"可能已落盘"，调用方只能查、不能重试。
  async function request(type, payload, mutation = false) {
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    let timer;
    const send = Promise.resolve().then(() => relay.request({ type, requestId, editorKind, ...payload }, { timeoutMs }));
    try {
      return await Promise.race([
        send,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new MediaBridgeError(
            mutation ? 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' : 'EDITOR_TIMEOUT',
            mutation ? 'Command outcome is unknown; query the original commandId.' : `${editorKind} editor did not respond in time.`,
            { commandId: payload.commandId, outcomeUnknown: mutation },
          )), timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof MediaBridgeError) throw error;
      if (error?.code) throw new MediaBridgeError(error.code, error.message || 'Editor request failed.', { revision: error.revision, outcomeUnknown: error.outcomeUnknown, commandId: error.commandId });
      throw new MediaBridgeError('EDITOR_ERROR', error?.message || 'Editor request failed.');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    editorKind,
    getPage(instanceId) { return relay.getPage?.(instanceId) ?? null; },
    async readState(input) {
      opaqueId(input?.instanceId, 'instanceId');
      const state = validateState(await request('editor.read_state', { editorInstanceId: input.instanceId }), input.instanceId);
      if (input.projectId && state.documentId !== input.projectId) throw new MediaBridgeError('DOCUMENT_MISMATCH', 'The active project changed.');
      return state;
    },
    async getCommandResult(input) {
      opaqueId(input?.instanceId, 'instanceId');
      opaqueId(input.commandId, 'commandId');
      const result = await request('editor.get_command_result', { editorInstanceId: input.instanceId, commandId: input.commandId });
      if (!isObject(result) || !['applied', 'rejected', 'unknown'].includes(result.status)) {
        throw new MediaBridgeError('EDITOR_ERROR', 'Editor returned an invalid command result.');
      }
      const key = keyOf(input.instanceId, input.commandId);
      if (result.status === 'applied' && result.originalResult) { completed.set(key, result.originalResult); uncertain.delete(key); }
      return result;
    },
    async startExport(input) {
      opaqueId(input?.instanceId, 'instanceId');
      opaqueId(input.projectId, 'projectId');
      opaqueId(input.commandId, 'commandId');
      const formats = ['webm', 'mp4'];
      if (!formats.includes(input.format)) throw new MediaBridgeError('INVALID_REQUEST', `Export format for ${editorKind} must be one of ${formats.join(', ')}.`);
      const key = keyOf(input.instanceId, input.commandId);
      if (completed.has(key)) return completed.get(key);
      if (uncertain.has(key)) throw uncertain.get(key);
      const result = await request('editor.export_start', {
        editorInstanceId: input.instanceId,
        documentId: input.projectId,
        expectedRevision: input.expectedRevision,
        commandId: input.commandId,
        format: input.format,
      }, true).catch(error => {
        if (error.code === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN') uncertain.set(key, error);
        throw error;
      });
      if (!isObject(result) || result.editorKind !== editorKind || result.commandId !== input.commandId ||
          typeof result.exportId !== 'string' || !result.exportId ||
          !['queued', 'running', 'ready', 'completed', 'failed'].includes(result.status)) {
        throw new MediaBridgeError('EDITOR_ERROR', `${editorKind} editor returned an invalid export job.`);
      }
      completed.set(key, result);
      return result;
    },
    async getExportStatus(input) {
      opaqueId(input?.instanceId, 'instanceId');
      opaqueId(input.exportId, 'exportId');
      const result = await request('editor.export_status', { editorInstanceId: input.instanceId, exportId: input.exportId });
      if (!isObject(result) || result.editorKind !== editorKind || result.exportId !== input.exportId ||
          !['queued', 'running', 'ready', 'completed', 'failed', 'unknown'].includes(result.status)) {
        throw new MediaBridgeError('EDITOR_ERROR', `${editorKind} editor returned an invalid export status.`);
      }
      if (['ready', 'completed'].includes(result.status) && typeof result.artifactRef !== 'string') {
        throw new MediaBridgeError('EDITOR_ERROR', 'Finished export is missing artifactRef.');
      }
      return result;
    },
    // 写入：先查 completed/inFlight/uncertain，再按 expectedRevision 提交；写后立刻回读，
    // revision 必须等于回执里的值，否则降级为 AUDIT_OUTCOME_UNKNOWN 并禁止重放。
    async applyCommand(input) {
      opaqueId(input?.instanceId, 'instanceId');
      opaqueId(input.projectId, 'projectId');
      opaqueId(input.commandId, 'commandId');
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw new MediaBridgeError('INVALID_REQUEST', 'expectedRevision must be a non-negative integer.');
      }
      validateCommand(input.command);
      const key = keyOf(input.instanceId, input.commandId);
      if (completed.has(key)) return completed.get(key);
      if (inFlight.has(key)) return inFlight.get(key);
      if (uncertain.has(key)) throw uncertain.get(key);
      const operation = (async () => {
        const result = await request('editor.apply_command', {
          editorInstanceId: input.instanceId,
          documentId: input.projectId,
          expectedRevision: input.expectedRevision,
          commandId: input.commandId,
          command: structuredClone(input.command),
        }, true);
        // Contract: {editorKind, documentId, commandId, revision, changedObjectIds}.
        // `changedLayerIds` is accepted as a legacy alias so an editor that renamed the
        // field does not look like a failure after it already wrote.
        const changed = Array.isArray(result?.changedObjectIds)
          ? result.changedObjectIds
          : Array.isArray(result?.changedLayerIds) ? result.changedLayerIds : null;
        const revisionAdvanced = Number.isSafeInteger(result?.revision) && result.revision > input.expectedRevision;
        const shapeValid = isObject(result) &&
          (result.editorKind === undefined || result.editorKind === editorKind) &&
          result.documentId === input.projectId && result.commandId === input.commandId &&
          revisionAdvanced && changed !== null;
        if (!shapeValid) {
          // The revision advanced, so the write may have landed. Never report that as a
          // clean rejection: the caller must query by commandId instead of retrying.
          if (revisionAdvanced) {
            throw new MediaBridgeError(
              'EDITOR_RESULT_INVALID_OUTCOME_UNKNOWN',
              'The editor reported a new revision but the mutation result shape was invalid; the write may have landed. Query this commandId instead of retrying.',
              { outcomeUnknown: true, commandId: input.commandId, revision: result?.revision },
            );
          }
          throw new MediaBridgeError('EDITOR_ERROR', 'Editor returned an invalid mutation result.');
        }
        return { ...result, editorKind, changedObjectIds: changed };
      })();
      inFlight.set(key, operation);
      try {
        const result = await operation;
        let state;
        try {
          const audit = await request('editor.read_state', { editorInstanceId: input.instanceId });
          state = validateState(audit, input.instanceId);
          if (state.documentId !== input.projectId || state.revision !== result.revision) throw new Error('Audit project/revision changed after mutation.');
        } catch (error) {
          throw new MediaBridgeError('EDITOR_AUDIT_OUTCOME_UNKNOWN', `Mutation returned but audit could not verify it: ${error.message}. Query the original commandId.`, { outcomeUnknown: true, commandId: input.commandId });
        }
        const withAudit = {
          ...result,
          stateDigest: state.stateDigest,
          history: isObject(state.history) ? { canUndo: !!state.history.canUndo, canRedo: !!state.history.canRedo } : undefined,
        };
        completed.set(key, withAudit);
        return withAudit;
      } catch (error) {
        // Both a timeout and an unverifiable-but-possibly-applied result block replay.
        if (error.code === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' || error.outcomeUnknown === true) uncertain.set(key, error);
        throw error;
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
