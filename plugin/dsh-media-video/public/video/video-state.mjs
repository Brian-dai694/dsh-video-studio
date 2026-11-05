// Multi-track video project state. Every time value is seconds in state and integer
// microseconds on the tool wire; clips live on tracks, track order is the composite order.
const nextId = () => globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const clone = value => JSON.parse(JSON.stringify(value));
export const TRACK_KINDS = ['video', 'audio'];
const round = value => Math.round(value * 1e6) / 1e6;

export function createTrack(kind, index) {
  return { id: nextId(), kind, name: `${kind === 'video' ? '视频' : '音频'} ${index + 1}`, order: index, mute: false, solo: false, volume: 1, clips: [] };
}

export function createProject() {
  return {
    projectId: globalThis.crypto?.randomUUID?.() ?? `project-${Date.now()}`,
    revision: 0,
    source: null,
    timeline: { duration: 0, fps: null, currentTime: 0 },
    tracks: [Object.assign(createTrack('video', 0), { id: 'video-main', name: '视频 1' })],
    overlays: [],
    selection: null,
  };
}

// Old single-track projects stored clips on a `kind:'overlay'` companion track and had no
// per-track properties. Normalise both shapes so an existing project still opens.
export function normalizeProject(input) {
  const project = clone(input);
  const tracks = [];
  let videoIndex = 0, audioIndex = 0;
  for (const track of project.tracks ?? []) {
    if (track.kind === 'overlay') continue;
    const kind = TRACK_KINDS.includes(track.kind) ? track.kind : 'video';
    const index = kind === 'video' ? videoIndex++ : audioIndex++;
    const normalized = {
      id: track.id || nextId(),
      kind,
      name: track.name || `${kind === 'video' ? '视频' : '音频'} ${index + 1}`,
      order: tracks.length,
      mute: track.mute === true,
      solo: track.solo === true,
      volume: Number.isFinite(track.volume) ? Math.max(0, Math.min(2, track.volume)) : 1,
      clips: (track.clips ?? []).map(clip => ({ ...clip, trackId: track.id })),
    };
    tracks.push(normalized);
  }
  if (!tracks.length) tracks.push(createTrack('video', 0));
  project.tracks = tracks;
  project.tracks.forEach((track, index) => { track.order = index; track.clips.forEach(clip => { clip.trackId = track.id; }); });
  project.overlays = (project.overlays ?? []).map((overlay, index) => ({
    start: 0, end: project.timeline?.duration ?? 0, x: 0.5, y: 0.5, scale: 1, visible: true, zIndex: index, ...overlay,
  }));
  project.timeline = { duration: 0, fps: null, currentTime: 0, ...(project.timeline ?? {}) };
  project.timeline.duration = projectDuration(project);
  project.timeline.currentTime = Math.max(0, Math.min(project.timeline.currentTime ?? 0, project.timeline.duration));
  return project;
}

export const allClips = project => project.tracks.flatMap(track => track.clips.map(clip => ({ ...clip, trackId: track.id, trackKind: track.kind })));
export const findClip = (project, clipId) => {
  for (const track of project.tracks) {
    const clip = track.clips.find(item => item.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
};
export const projectDuration = project => allClips(project)
  .reduce((max, clip) => Math.max(max, round((clip.start ?? 0) + (clip.out ?? 0) - (clip.in ?? 0))), 0);

// Composite ranges per track, respecting mute/solo. Video layers paint in track order
// (later tracks on top); audio tracks mix by volume.
export function compositePlan(project) {
  const soloed = project.tracks.some(track => track.solo);
  const active = project.tracks.filter(track => !track.mute && (!soloed || track.solo));
  return {
    duration: projectDuration(project),
    video: active.filter(track => track.kind === 'video').map((track, index) => ({ trackId: track.id, order: index, clips: track.clips.map(clip => ({ ...clip, trackId: track.id })) })),
    audio: active.filter(track => track.kind === 'audio').map(track => ({ trackId: track.id, volume: track.volume, clips: track.clips.map(clip => ({ ...clip, trackId: track.id })) })),
  };
}

export function createHistory(initial = createProject()) { return { past: [], present: clone(normalizeProject(initial)), future: [] }; }
export const canUndo = history => history.past.length > 0;
export const canRedo = history => history.future.length > 0;
export function commit(history, next) { return JSON.stringify(history.present) === JSON.stringify(next) ? history : { past: [...history.past, clone(history.present)].slice(-100), present: clone(next), future: [] }; }
export function undo(history) { if (!canUndo(history)) return history; const present = clone(history.past.at(-1)); present.revision = history.present.revision + 1; return { past: history.past.slice(0, -1), present, future: [clone(history.present), ...history.future] }; }
export function redo(history) { if (!canRedo(history)) return history; const present = clone(history.future[0]); present.revision = history.present.revision + 1; return { past: [...history.past, clone(history.present)].slice(-100), present, future: history.future.slice(1) }; }

function trackFor(project, trackId) {
  if (!trackId) return project.tracks.find(track => track.kind === 'video');
  return project.tracks.find(track => track.id === trackId);
}

export function reduceProject(project, command) {
  const next = normalizeProject(project);
  const touch = () => { next.timeline.duration = projectDuration(next); next.timeline.currentTime = Math.min(next.timeline.currentTime, next.timeline.duration); };
  switch (command.type) {
    case 'media.video.clip.add': {
      const clip = command.clip ?? {};
      if (!Number.isFinite(clip.duration) || clip.duration <= 0) throw new Error('视频时长无效');
      const track = trackFor(next, clip.trackId);
      if (!track) throw new Error('目标轨道不存在');
      const start = Math.max(0, clip.start ?? 0);
      const input = Math.max(0, Math.min(clip.in ?? 0, clip.duration - 0.05));
      const output = Math.max(input + 0.05, Math.min(clip.out ?? clip.duration, clip.duration));
      track.clips.push({ id: clip.id || nextId(), sourceRef: clip.sourceRef, name: clip.name, duration: clip.duration, in: input, out: output, start, trackId: track.id });
      if (track.kind === 'video' && !next.source) next.source = { sourceRef: clip.sourceRef, name: clip.name };
      next.selection = track.clips.at(-1).id;
      touch();
      break;
    }
    case 'media.video.clip.trim': {
      const found = findClip(next, command.clipId);
      if (!found) throw new Error('未找到目标片段');
      const { clip } = found;
      const input = Math.max(0, Math.min(command.in ?? clip.in, clip.duration - 0.05));
      const output = Math.max(input + 0.05, Math.min(command.out ?? clip.out, clip.duration));
      clip.in = input; clip.out = output;
      touch();
      break;
    }
    case 'media.video.clip.move': {
      const found = findClip(next, command.clipId);
      if (!found) throw new Error('未找到目标片段');
      const starts = command.start !== undefined;
      if (!starts && !command.trackId) throw new Error('目标片段或位置无效');
      if (starts) {
        if (!Number.isFinite(command.start)) throw new Error('目标片段或位置无效');
        found.clip.start = Math.max(0, command.start);
      }
      if (command.trackId && command.trackId !== found.track.id) {
        const target = trackFor(next, command.trackId);
        if (!target) throw new Error('目标轨道不存在');
        if (target.kind !== found.track.kind) throw new Error('片段不能移到不同类型的轨道');
        found.track.clips = found.track.clips.filter(item => item.id !== found.clip.id);
        found.clip.trackId = target.id;
        target.clips.push(found.clip);
      }
      touch();
      break;
    }
    case 'media.video.clip.remove': {
      const found = findClip(next, command.clipId);
      if (!found) throw new Error('未找到目标片段');
      found.track.clips = found.track.clips.filter(item => item.id !== command.clipId);
      if (next.selection === command.clipId) next.selection = null;
      if (!allClips(next).some(clip => clip.sourceRef === next.source?.sourceRef)) next.source = null;
      touch();
      break;
    }
    case 'media.video.track.add': {
      const kind = command.track?.kind ?? 'video';
      if (!TRACK_KINDS.includes(kind)) throw new Error('不支持的轨道类型');
      const track = Object.assign(createTrack(kind, next.tracks.filter(item => item.kind === kind).length), command.track?.id ? { id: command.track.id } : {});
      next.tracks.push(track);
      next.tracks.forEach((item, index) => { item.order = index; });
      break;
    }
    case 'media.video.track.remove': {
      if (next.tracks.length <= 1) throw new Error('至少保留一条轨道');
      const index = next.tracks.findIndex(track => track.id === command.trackId);
      if (index === -1) throw new Error('目标轨道不存在');
      next.tracks.splice(index, 1);
      next.tracks.forEach((item, order) => { item.order = order; });
      if (next.selection && !findClip(next, next.selection)) next.selection = null;
      if (!allClips(next).some(clip => clip.sourceRef === next.source?.sourceRef)) next.source = null;
      touch();
      break;
    }
    case 'media.video.track.update': {
      const track = next.tracks.find(item => item.id === command.trackId);
      if (!track) throw new Error('目标轨道不存在');
      if (command.patch?.mute !== undefined) track.mute = command.patch.mute === true;
      if (command.patch?.solo !== undefined) track.solo = command.patch.solo === true;
      if (command.patch?.volume !== undefined) {
        if (!Number.isFinite(command.patch.volume) || command.patch.volume < 0 || command.patch.volume > 2) throw new Error('音量必须在 0–2 之间');
        track.volume = round(command.patch.volume);
      }
      if (command.patch?.name !== undefined) track.name = String(command.patch.name).slice(0, 40);
      break;
    }
    case 'media.video.overlay.add': {
      if (!['text', 'image'].includes(command.overlay?.kind)) throw new Error('不支持的叠加类型');
      const end = command.overlay.end ?? next.timeline.duration;
      next.overlays.push({ id: command.overlay.id || nextId(), kind: command.overlay.kind, name: command.overlay.name, content: command.overlay.content ?? null, sourceRef: command.overlay.sourceRef ?? null, start: Math.max(0, command.overlay.start ?? 0), end: Math.max(0.05, end), x: 0.5, y: 0.5, scale: 1, visible: true, zIndex: next.overlays.length });
      next.selection = next.overlays.at(-1).id;
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
      return next;
    case 'media.video.project.restore':
      return { ...normalizeProject(command.project), revision: project.revision + 1 };
    default:
      throw new Error(`不支持的命令：${command.type}`);
  }
  next.revision = project.revision + 1;
  return next;
}

const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
export function stateDigest(project) {
  const input = stable({ source: project.source, timeline: { duration: project.timeline.duration, fps: project.timeline.fps }, tracks: project.tracks, overlays: project.overlays });
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) { hash ^= input.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
export function readState(project, history, instanceId, capabilities = {}) {
  const clips = allClips(project);
  const selected = clips.find(clip => clip.id === project.selection) ?? project.overlays.find(item => item.id === project.selection);
  return {
    editorKind: 'video', contractVersion: 1,
    projectId: project.projectId, documentId: project.projectId, editorInstanceId: instanceId,
    revision: project.revision, stateDigest: stateDigest(project),
    timeline: clone(project.timeline),
    tracks: project.tracks.map(track => ({ id: track.id, kind: track.kind, name: track.name, order: track.order, mute: track.mute, solo: track.solo, volume: track.volume, clipCount: track.clips.length })),
    trackClips: project.tracks.map(track => ({ trackId: track.id, clips: clone(track.clips) })),
    clips: clone(clips),
    overlays: clone(project.overlays),
    selectedObjects: selected ? [clone(selected)] : [],
    history: { canUndo: canUndo(history), canRedo: canRedo(history), undoDepth: history.past.length, redoDepth: history.future.length, topCommandId: project.lastCommandId || null },
    capabilities: { localImport: true, webm: !!capabilities.webm, mp4: 'unknown', multitrack: true, audioTracks: project.tracks.some(track => track.kind === 'audio') },
  };
}
export function snapshotProject(project) {
  return { format: 'media-video-project', version: 2, project: clone(project), media: project.source ? { sourceRef: project.source.sourceRef, name: project.source.name, embedded: false } : null };
}
