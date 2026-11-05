const clone = value => JSON.parse(JSON.stringify(value));

export function createProject() {
  return {
    projectId: globalThis.crypto?.randomUUID?.() ?? `project-${Date.now()}`,
    revision: 0,
    source: null,
    timeline: { duration: 0, fps: null, currentTime: 0 },
    tracks: [{ id: 'video-main', kind: 'video', name: '视频', clips: [] }, { id: 'overlay-main', kind: 'overlay', name: '叠加', clips: [] }],
    overlays: [],
    selection: null
  };
}

export function createHistory(initial = createProject()) {
  return { past: [], present: clone(initial), future: [] };
}

export function canUndo(history) { return history.past.length > 0; }
export function canRedo(history) { return history.future.length > 0; }

export function commit(history, next) {
  if (JSON.stringify(history.present) === JSON.stringify(next)) return history;
  return { past: [...history.past, clone(history.present)].slice(-100), present: clone(next), future: [] };
}

export function undo(history) {
  if (!canUndo(history)) return history;
  return { past: history.past.slice(0, -1), present: clone(history.past.at(-1)), future: [clone(history.present), ...history.future] };
}

export function redo(history) {
  if (!canRedo(history)) return history;
  return { past: [...history.past, clone(history.present)].slice(-100), present: clone(history.future[0]), future: history.future.slice(1) };
}

const clipFor = project => project.tracks.find(track => track.kind === 'video')?.clips[0];

export function reduceProject(project, command) {
  const next = clone(project);
  const clip = clipFor(next);
  switch (command.type) {
    case 'media.video.clip.add': {
      if (next.tracks.find(track => track.kind === 'video').clips.length) throw new Error('MVP 仅支持一个视频片段');
      next.tracks.find(track => track.kind === 'video').clips.push({ id: command.clip.id, sourceRef: command.clip.sourceRef,
        name: command.clip.name, duration: command.clip.duration, in: 0, out: command.clip.duration, start: 0 });
      next.source = { sourceRef: command.clip.sourceRef, name: command.clip.name };
      next.timeline.duration = command.clip.duration;
      next.selection = command.clip.id;
      break;
    }
    case 'media.video.clip.trim': {
      if (!clip || clip.id !== command.clipId) throw new Error('未找到目标视频片段');
      const input = Math.max(0, Math.min(command.in, clip.out - 0.05));
      const output = Math.max(input + 0.05, Math.min(command.out, clip.duration));
      clip.in = input; clip.out = output;
      next.timeline.duration = Math.max(0.05, clip.start + output - input);
      next.timeline.currentTime = Math.min(next.timeline.currentTime, next.timeline.duration);
      break;
    }
    case 'media.video.clip.move': {
      if (!clip || clip.id !== command.clipId) throw new Error('未找到目标视频片段');
      clip.start = Math.max(0, command.start);
      next.timeline.duration = clip.start + clip.out - clip.in;
      break;
    }
    case 'media.video.clip.remove': {
      const track = next.tracks.find(item => item.kind === 'video');
      track.clips = track.clips.filter(item => item.id !== command.clipId);
      next.source = null; next.timeline.duration = 0; next.timeline.currentTime = 0; next.selection = null;
      break;
    }
    case 'media.video.overlay.add': {
      if (!['text', 'image'].includes(command.overlay.kind)) throw new Error('不支持的叠加类型');
      next.overlays.push({ id: command.overlay.id, kind: command.overlay.kind, name: command.overlay.name,
        content: command.overlay.content ?? null, sourceRef: command.overlay.sourceRef ?? null,
        start: 0, end: Math.max(0.05, next.timeline.duration), x: 0.5, y: 0.5, scale: 1, visible: true, zIndex: next.overlays.length });
      next.selection = command.overlay.id;
      break;
    }
    case 'media.video.overlay.update': {
      const overlay = next.overlays.find(item => item.id === command.overlayId);
      if (!overlay) throw new Error('未找到目标叠加对象');
      for (const key of ['content', 'start', 'end', 'x', 'y', 'scale', 'visible']) if (command.patch[key] !== undefined) overlay[key] = command.patch[key];
      break;
    }
    case 'media.video.overlay.remove':
      next.overlays = next.overlays.filter(item => item.id !== command.overlayId);
      if (next.selection === command.overlayId) next.selection = null;
      break;
    case 'media.video.timeline.seek':
      next.timeline.currentTime = Math.max(0, Math.min(command.time, next.timeline.duration));
      break;
    case 'media.video.project.restore':
      return { ...clone(command.project), revision: project.revision + 1 };
    default: throw new Error(`不支持的命令：${command.type}`);
  }
  next.revision = project.revision + 1;
  return next;
}

export function stateDigest(project) {
  const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);
  let hash = 2166136261;
  const input = stable({ source: project.source, timeline: { duration: project.timeline.duration, fps: project.timeline.fps }, tracks: project.tracks, overlays: project.overlays });
  for (let i = 0; i < input.length; i++) { hash ^= input.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function readState(project, history, instanceId) {
  const clip = clipFor(project);
  return { editorKind: 'video', contractVersion: 1, projectId: project.projectId, documentId: project.projectId,
    editorInstanceId: instanceId, revision: project.revision, stateDigest: stateDigest(project),
    timeline: clone(project.timeline), tracks: clone(project.tracks), clips: clone(project.tracks.flatMap(track => track.clips)), overlays: clone(project.overlays),
    selectedObjects: project.selection ? [clip?.id === project.selection ? clone(clip) : clone(project.overlays.find(item => item.id === project.selection))].filter(Boolean) : [],
    history: { canUndo: canUndo(history), canRedo: canRedo(history), undoDepth: history.past.length, redoDepth: history.future.length },
    capabilities: { localImport: true, webm: typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function', mp4: 'unknown' } };
}

export function snapshotProject(project) {
  return { format: 'media-video-project', version: 1, project: clone(project), media: project.source ? { sourceRef: project.source.sourceRef, name: project.source.name, embedded: false } : null };
}
