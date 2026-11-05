// Editor adapter shared by the image and video plugins.
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

const VIDEO_COMMANDS = new Set(['media.video.clip.add', 'media.video.clip.trim', 'media.video.clip.move', 'media.video.clip.remove', 'media.video.overlay.add', 'media.video.overlay.update', 'media.video.history.undo', 'media.video.history.redo']);
const fieldsOnly = (payload, fields) => {
  const unknown = Object.keys(payload).find(key => !fields.includes(key));
  if (unknown) throw new MediaBridgeError('INVALID_REQUEST', `Unsupported payload field: ${unknown}. Read the operation parameter contract.`);
};

export const ALLOWED_COMMANDS = { video: VIDEO_COMMANDS };

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
      finite(p.startUs, 'startUs', { min: 0 }); finite(p.inUs, 'inUs', { min: 0 }); finite(p.outUs, 'outUs', { min: 0 });
      if (p.outUs <= p.inUs) throw new MediaBridgeError('INVALID_REQUEST', 'outUs must be greater than inUs.');
      break;
    case 'media.video.clip.trim':
      opaqueId(p.clipId, 'clipId');
      if (p.inUs === undefined && p.outUs === undefined) throw new MediaBridgeError('INVALID_REQUEST', 'At least one trim boundary is required.');
      if (p.inUs !== undefined) finite(p.inUs, 'inUs', { min: 0 });
      if (p.outUs !== undefined) finite(p.outUs, 'outUs', { min: 0 });
      break;
    case 'media.video.clip.move':
      opaqueId(p.clipId, 'clipId'); finite(p.startUs, 'startUs', { min: 0 });
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

function validateImageState(state, instanceId) {
  if (!isObject(state) || state.editorKind !== 'image' || state.editorInstanceId !== instanceId ||
      typeof state.documentId !== 'string' || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !isObject(state.canvas) || !Number.isFinite(state.canvas.width) || !Number.isFinite(state.canvas.height) ||
      !Array.isArray(state.layers)) {
    throw new MediaBridgeError('EDITOR_ERROR', 'Image editor returned an invalid state.');
  }
  return state;
}

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

export const STATE_VALIDATORS = { image: validateImageState, video: validateVideoState };

export function createMediaBridge({ relay, editorKind, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!relay || typeof relay.request !== 'function') throw new TypeError('relay.request is required');
  if (!STATE_VALIDATORS[editorKind]) throw new TypeError('editorKind must be image or video');
  const completed = new Map();
  const inFlight = new Map();
  const uncertain = new Map();
  const validateState = STATE_VALIDATORS[editorKind];
  const validateCommand = COMMAND_VALIDATORS[editorKind];
  const keyOf = (instanceId, commandId) => `${instanceId}\0${commandId}`;

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
      const formats = editorKind === 'image' ? ['png', 'jpeg'] : ['webm', 'mp4'];
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
