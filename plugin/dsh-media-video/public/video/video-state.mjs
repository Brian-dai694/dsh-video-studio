// Multi-track video project state. Every time value is seconds in state and integer
// microseconds on the tool wire; clips live on tracks, track order is the composite order.
const nextId = () => globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const clone = value => JSON.parse(JSON.stringify(value));
export const TRACK_KINDS = ['video', 'audio', 'text'];
// 轨道类型中文标签：字幕是一条独立轨道（单轨 cues），不是叠加对象。
export const TRACK_LABELS = { video: '视频', audio: '音频', text: '字幕' };
const round = value => Math.round(value * 1e6) / 1e6;

export function createTrack(kind, index) {
  return { id: nextId(), kind, name: `${TRACK_LABELS[kind] ?? '视频'} ${index + 1}`, order: index, mute: false, solo: false, volume: 1, clips: [] };
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
// 同一素材不允许被两条轨道同时发声：一个媒体元素只能接一条音频链，重复引用会让
// 音量语义变得不可预测（改一轨却影响两处声音），所以写入时就拒绝。
function assertUniqueAudioSource(project, sourceRef, trackId) {
  if (!sourceRef) return;
  for (const track of project.tracks) {
    if (track.id === trackId || track.mute || track.kind === 'text') continue;
    if (track.clips.some(clip => clip.sourceRef === sourceRef)) {
      const error = new Error('DUPLICATE_AUDIO_SOURCE: 同一素材已在另一条轨道上发声，请先静音该轨或删掉那处引用');
      error.code = 'DUPLICATE_AUDIO_SOURCE';
      throw error;
    }
  }
}

// 同轨时间重叠一律拒绝：空隙是合法状态，重叠不是。轨道顺序即层级，不做隐式吸收。
function assertNoOverlap(track, start, end, excludeId) {
  const from = round(start), to = round(end);
  for (const clip of track.clips) {
    if (clip.id === excludeId) continue;
    const clipEnd = round(clip.start + clip.out - clip.in);
    if (from < clipEnd - 1e-6 && to > clip.start + 1e-6) {
      const error = new Error('该轨道在此位置已有片段（TRACK_OVERLAP），请换个位置或先调整已有片段');
      error.code = 'TRACK_OVERLAP';
      throw error;
    }
  }
}

export function normalizeProject(input) {
  const project = clone(input);
  const tracks = [];
  const kindIndex = { video: 0, audio: 0, text: 0 };
  for (const track of project.tracks ?? []) {
    if (track.kind === 'overlay') continue;
    const kind = TRACK_KINDS.includes(track.kind) ? track.kind : 'video';
    const index = kindIndex[kind]++;
    const normalized = {
      id: track.id || nextId(),
      kind,
      name: track.name || `${TRACK_LABELS[kind]} ${index + 1}`,
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
  // 视频轨 mute 只静声音、不撤画面：否则静音唯一那条视频轨会让整片没有画面可导出。
  return {
    duration: projectDuration(project),
    video: project.tracks.filter(track => track.kind === 'video').map((track, index) => ({ trackId: track.id, order: index, volume: track.mute ? 0 : track.volume, clips: track.clips.map(clip => ({ ...clip, trackId: track.id })) })),
    audio: active.filter(track => track.kind === 'audio').map(track => ({ trackId: track.id, volume: track.volume, clips: track.clips.map(clip => ({ ...clip, trackId: track.id })) })),
    // 字幕轨是独立轨道：按轨道顺序参与合成，不是叠加对象。
    text: active.filter(track => track.kind === 'text').map(track => ({ trackId: track.id, order: track.order, clips: track.clips.map(clip => ({ ...clip, trackId: track.id })) })),
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
      const track = trackFor(next, clip.trackId);
      if (!track) throw new Error('目标轨道不存在');
      // 字幕轨：一个片段就是一条 cue，只带文字与时间窗（不做 document/timing/Use 三层）。
      if (track.kind === 'text') {
        const text = String(clip.text ?? '').trim();
        if (!text) throw new Error('字幕片段必须带文字');
        const start = Math.max(0, clip.start ?? 0);
        const length = Math.max(0.05, Number(clip.duration) || 4);
        assertNoOverlap(track, start, start + length);
        track.clips.push({ id: clip.id || nextId(), text: text.slice(0, 4000), style: clip.style ?? null, duration: length, start, in: 0, out: length, trackId: track.id });
        next.selection = track.clips.at(-1).id;
        touch();
        break;
      }
      if (!Number.isFinite(clip.duration) || clip.duration <= 0) throw new Error('视频时长无效');
      const start = Math.max(0, clip.start ?? 0);
      const input = Math.max(0, Math.min(clip.in ?? 0, clip.duration - 0.05));
      const output = Math.max(input + 0.05, Math.min(clip.out ?? clip.duration, clip.duration));
      assertNoOverlap(track, start, start + output - input);
      assertUniqueAudioSource(next, clip.sourceRef, track.id);
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
      // 移动与裁剪语义分离：裁剪只改素材入出点，绝不改时间线起点（start）。
      if (command.start !== undefined) throw new Error('裁剪只改素材入出点；要移动请用 clip.move');
      const input = Math.max(0, Math.min(command.in ?? clip.in, clip.duration - 0.05));
      const output = Math.max(input + 0.05, Math.min(command.out ?? clip.out, clip.duration));
      assertNoOverlap(found.track, clip.start, clip.start + output - input, clip.id);
      clip.in = input; clip.out = output;
      touch();
      break;
    }
    case 'media.video.clip.move': {
      const found = findClip(next, command.clipId);
      if (!found) throw new Error('未找到目标片段');
      // 移动只改时间线起点与所在轨道，绝不改素材入出点（in/out）。
      if (command.in !== undefined || command.out !== undefined) throw new Error('移动不改素材入出点；要裁剪请用 clip.trim');
      const starts = command.start !== undefined;
      if (!starts && !command.trackId) throw new Error('目标片段或位置无效');
      if (starts) {
        if (!Number.isFinite(command.start)) throw new Error('目标片段或位置无效');
        const length = found.clip.out - found.clip.in;
        const targetTrack = command.trackId && command.trackId !== found.track.id ? trackFor(next, command.trackId) : found.track;
        if (!targetTrack) throw new Error('目标轨道不存在');
        const target = Math.max(0, command.start);
        assertNoOverlap(targetTrack, target, target + length, found.clip.id);
        if (targetTrack.id !== found.track.id) assertUniqueAudioSource(next, found.clip.sourceRef, targetTrack.id);
        found.clip.start = target;
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
// 内容摘要：只含内容。轨道属性（mute/solo/volume）与叠加对象都在内，
// 播放头 currentTime、选中 selection 这类 UI 态一律不进内容版本。
export function contentDigest(project) {
  const input = stable({
    source: project.source,
    timeline: { duration: project.timeline.duration, fps: project.timeline.fps },
    tracks: project.tracks,
    overlays: project.overlays,
  });
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) { hash ^= input.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

// 兼容层（deprecated）：老调用方仍读 stateDigest，语义等同 contentDigest。
export const stateDigest = contentDigest;

// UI 瞬时态：改这些不算内容修改，不进 revision，也不进 diff。
export function viewState(project) {
  return {
    currentTime: Math.round((project.timeline.currentTime ?? 0) * 1e6) / 1e6,
    selection: project.selection ?? null,
  };
}
export function readState(project, history, instanceId, capabilities = {}) {
  const clips = allClips(project);
  const selected = clips.find(clip => clip.id === project.selection) ?? project.overlays.find(item => item.id === project.selection);
  return {
    editorKind: 'video', contractVersion: 1,
    projectId: project.projectId, documentId: project.projectId, editorInstanceId: instanceId,
    revision: project.revision,
    contentDigest: contentDigest(project),
    viewState: viewState(project),
    stateDigest: contentDigest(project),
    timeline: clone(project.timeline),
    // solo 优先于 mute：solo 集合非空时非 solo 轨一律不出声；mute 与 solo 同为真按 solo 算。
    // effective 是“实际可听态”，调用方不该自己再推一遍布尔逻辑。
    tracks: project.tracks.map(track => ({
      id: track.id, kind: track.kind, name: track.name, order: track.order,
      mute: track.mute, solo: track.solo, volume: track.volume, clipCount: track.clips.length,
      effective: {
        audible: project.tracks.some(item => item.solo) ? track.solo && track.kind !== 'text' : (!track.mute && track.kind !== 'text'),
        visible: project.tracks.some(item => item.solo) ? track.solo : !track.mute,
        // 视频轨也有音量：受 track.update volume 控制；静音后实际增益是 0（画面仍在）。
        gain: track.kind === 'text' ? null : (track.mute ? 0 : track.volume),
      },
    })),
    trackClips: project.tracks.map(track => ({ trackId: track.id, clips: clone(track.clips) })),
    // 契约暴露 sourceTime 形状（微秒、rate=1）；状态内部仍存秒制 in/out，将来加变速/循环不破契约。
    clips: clone(clips).map(clip => ({ ...clip, sourceTime: { startUs: Math.round((clip.in ?? 0) * 1e6), endUs: Math.round((clip.out ?? 0) * 1e6), rate: 1 } })),
    overlays: clone(project.overlays),
    selectedObjects: selected ? [clone(selected)] : [],
    history: { canUndo: canUndo(history), canRedo: canRedo(history), undoDepth: history.past.length, redoDepth: history.future.length, topCommandId: project.lastCommandId || null },
    capabilities: { localImport: true, webm: !!capabilities.webm, mp4: 'unknown', multitrack: true, audioTracks: project.tracks.some(track => track.kind === 'audio') },
  };
}
export function snapshotProject(project) {
  return { format: 'media-video-project', version: 2, project: clone(project), media: project.source ? { sourceRef: project.source.sourceRef, name: project.source.name, embedded: false } : null };
}
