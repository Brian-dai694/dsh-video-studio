import { createProject, createHistory, commit, undo, redo, reduceProject, readState, snapshotProject, stateDigest, canUndo, canRedo } from './video-state.mjs';
import { detectWebmCapability } from './video-capabilities.mjs';
import { createEditorBridge } from './video-bridge.mjs';
import { recordComposition, assertForeground } from './video-export.mjs';
import { sourceRefFor, digestOf, sameContent, legacyMatches } from './video-sources.mjs';

const $ = id => document.getElementById(id);
const instanceId = crypto.randomUUID();
let history = createHistory(createProject());
let webmCapability = { status: 'checking', mimeType: '', reason: '正在探测浏览器能力' };
let selectedTrackId = null;
let importGeneration = 0;
let zoom = 1;
let bridge = null;
let toastTimer;
const project = () => history.present;
const allClips = () => project().tracks.flatMap(track => track.clips.map(clip => ({ ...clip, trackKind: track.kind })));
const clip = () => allClips().find(item => item.id === project().selection) || allClips().find(item => item.trackKind === 'video') || null;
const format = seconds => { const value = Math.max(0, Number(seconds) || 0); return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}.${String(Math.floor(value * 100 % 100)).padStart(2, '0')}`; };
function toast(message) { const node = $('toast'); node.textContent = message; node.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 2400); }
function apply(command, commandId = null) { if (exportBusy) throw Object.assign(new Error('导出期间请等待完成后再修改工程'), { code: 'EXPORT_BUSY' }); if (command.type === 'media.video.history.undo' || command.type === 'media.video.history.redo') { const backwards = command.type.endsWith('.undo'); if (!(backwards ? canUndo(history) : canRedo(history))) throw Object.assign(new Error('没有可撤销或重做的修改'), { code: 'HISTORY_EMPTY' }); history = backwards ? undo(history) : redo(history); render(); return readState(project(), history, instanceId, capabilities()); } const before = readState(project(), history, instanceId, capabilities()); const next = reduceProject(project(), command); next.lastCommandId = commandId; history = commit(history, next); const after = readState(project(), history, instanceId, capabilities()); $('auditDigest').textContent = `${before.stateDigest.slice(-8)} → ${after.stateDigest.slice(-8)} · R${before.revision}→R${after.revision}`; render(); return after; }
function recordPlaybackTime(time) { const next = reduceProject(project(), { type: 'media.video.timeline.seek', time }); history = { ...history, present: next }; }
function capabilities() { return { webm: webmCapability.status === 'available' }; }
function probeCapabilities() { webmCapability = detectWebmCapability($('video')); const label = $('webmCapability'); label.textContent = webmCapability.status === 'available' ? `可用 (${webmCapability.mimeType})` : '不可用'; label.title = webmCapability.reason; label.className = webmCapability.status === 'available' ? '' : 'unknown'; $('exportVideo').disabled = webmCapability.status !== 'available' || !clip(); }
function render() {
  const state = project(), item = clip(), duration = state.timeline.duration;
  $('revisionLabel').textContent = `修订 ${state.revision} · 本地工程`;
  $('revisionPill').textContent = `R${state.revision}`;
  $('undo').disabled = !canUndo(history); $('redo').disabled = !canRedo(history);
  $('sourceName').textContent = state.source?.name || '未导入'; $('mediaLabel').textContent = state.source?.name || '尚未导入媒体';
  $('timecode').innerHTML = `${format(state.timeline.currentTime)} <em>/</em> ${format(duration)}`;
  $('durationLabel').textContent = format(duration).slice(0, 5);
  $('inValue').textContent = item ? format(item.in) : '—'; $('outValue').textContent = item ? format(item.out) : '—'; $('lengthValue').textContent = item ? format(item.out - item.in) : '—';
  $('removeClip').disabled = !item; $('exportVideo').disabled = webmCapability.status !== 'available' || !item;
  $('webmCapability').textContent = webmCapability.status === 'available' ? `可用 (${webmCapability.mimeType})` : webmCapability.status === 'checking' ? '检测中' : '不可用'; $('webmCapability').className = webmCapability.status === 'available' ? '' : 'unknown'; $('webmCapability').title = webmCapability.reason;
  const hasMedia = media.size > 0;
  $('emptyStage').hidden = hasMedia; $('video').style.display = hasMedia ? 'block' : 'none';
  if (item) {
    $('inPoint').max = Math.floor(item.duration * 100); $('outPoint').max = Math.floor(item.duration * 100);
    $('inPoint').value = Math.floor(item.in * 100); $('outPoint').value = Math.floor(item.out * 100);
  }
  renderTracks();
  notifySelectionIfChanged();
  $('scrubber').value = duration ? String(Math.round(state.timeline.currentTime / duration * 1000)) : '0';
  $('playhead').style.left = `${72 + (duration ? state.timeline.currentTime / duration : 0) * Math.max(0, $('timeline').clientWidth - 73)}px`;
  const overlays = state.overlays;
  $('overlayCount').textContent = overlays.length;
  $('overlayList').innerHTML = overlays.length ? overlays.map(item => `<div class="overlay-item"><span>${item.kind === 'text' ? 'T' : '▧'}</span><span>${escapeHtml(item.name || '叠加对象')}</span><button data-remove-overlay="${item.id}" title="删除">×</button></div>`).join('') : '<div class="empty-list">还没有叠加对象</div>';
  $('overlayLane').innerHTML = overlays.length ? overlays.map(item => `<span class="overlay-chip" data-overlay="${item.id}">${escapeHtml(item.name || '叠加对象')}</span>`).join('') : '<span class="lane-empty">文字与图片叠加</span>';
  drawOverlays();
}
function escapeHtml(text) { return String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
// 多轨时间线：每条轨道一行，片段按 start/长度定位；轨道顺序即合成层级（后者在上）。
// 静音/独奏/音量直接写回工程，跨轨拖拽按落点行改 trackId，同类型校验由状态层负责。
function renderTracks() {
  const state = project(), duration = Math.max(state.timeline.duration, 0.001);
  $('trackList').innerHTML = state.tracks.map(track => {
    const clips = track.clips.map(item => {
      const left = (item.start / duration) * 100;
      const width = Math.max(2, ((item.out - item.in) / duration) * 100);
      const selected = state.selection === item.id ? ' selected' : '';
      const clipName = item.name || (item.text ? item.text.slice(0, 12) : '片段');
      const label = `${clipName} · ${format(item.in)}–${format(item.out)}`;
      return `<button type="button" class="track-clip ${track.kind}${selected}" data-clip="${item.id}" data-track="${track.id}" style="left:${left}%;width:${width}%" title="${escapeHtml(label)}">${escapeHtml(clipName)}</button>`;
    }).join('');
    return `<div class="track-row ${track.kind}${track.id === selectedTrackId ? ' active' : ''}" data-track-row="${track.id}">
      <div class="track-head">
        <span class="track-kind">${track.kind === 'video' ? '视频' : track.kind === 'audio' ? '音频' : '字幕'}</span>
        <span class="track-name">${escapeHtml(track.name)}</span>
        <button type="button" class="track-toggle${track.mute ? ' on' : ''}" data-track-mute="${track.id}" aria-label="静音 ${escapeHtml(track.name)}">M</button>
        <button type="button" class="track-toggle${track.solo ? ' on' : ''}" data-track-solo="${track.id}" aria-label="独奏 ${escapeHtml(track.name)}">S</button>
        ${track.kind === 'text' ? '' : `<input class="track-volume" data-track-volume="${track.id}" type="range" min="0" max="200" value="${Math.round((track.volume ?? 1) * 100)}" aria-label="音量 ${escapeHtml(track.name)}">`}
      </div>
      <div class="track-lane" data-track-lane="${track.id}">${clips}</div>
    </div>`;
  }).join('');
  for (const row of $('trackList').querySelectorAll('[data-track-row]')) row.addEventListener('pointerdown', event => { if (event.target.closest('[data-clip]')) return; selectedTrackId = row.dataset.trackRow; renderTracks(); });
  for (const node of $('trackList').querySelectorAll('[data-clip]')) node.addEventListener('pointerdown', event => startClipDrag(event, node));
  for (const node of $('trackList').querySelectorAll('[data-track-mute]')) node.addEventListener('click', () => { const track = project().tracks.find(item => item.id === node.dataset.trackMute); apply({ type: 'media.video.track.update', trackId: node.dataset.trackMute, patch: { mute: !track?.mute } }); });
  for (const node of $('trackList').querySelectorAll('[data-track-solo]')) node.addEventListener('click', () => { const track = project().tracks.find(item => item.id === node.dataset.trackSolo); apply({ type: 'media.video.track.update', trackId: node.dataset.trackSolo, patch: { solo: !track?.solo } }); });
  for (const node of $('trackList').querySelectorAll('[data-track-volume]')) node.addEventListener('change', () => apply({ type: 'media.video.track.update', trackId: node.dataset.trackVolume, patch: { volume: Number(node.value) / 100 } }));
}
function startClipDrag(event, node) {
  event.preventDefault();
  const clipId = node.dataset.clip;
  const startX = event.clientX;
  const origin = project().tracks.flatMap(track => track.clips.map(item => ({ track, item }))).find(entry => entry.item.id === clipId);
  if (!origin) return;
  node.classList.add('dragging');
  const lanes = [...$('trackList').querySelectorAll('[data-track-lane]')];
  const move = e => {
    node.style.transform = `translateX(${e.clientX - startX}px)`;
    const row = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-track-row]');
    for (const lane of lanes) lane.classList.toggle('drop-target', !!row && lane.dataset.trackLane === row.dataset.trackRow && row.dataset.trackRow !== origin.track.id);
  };
  const finish = e => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    node.classList.remove('dragging');
    node.style.transform = '';
    for (const lane of lanes) lane.classList.remove('drop-target');
    const row = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-track-row]');
    const laneWidth = node.closest('[data-track-lane]')?.clientWidth || 1;
    const duration = Math.max(project().timeline.duration, 0.001);
    const shifted = Math.max(0, origin.item.start + ((e.clientX - startX) / laneWidth) * duration);
    const patch = { type: 'media.video.clip.move', clipId, start: Number(shifted.toFixed(3)) };
    if (row && row.dataset.trackRow !== origin.track.id) patch.trackId = row.dataset.trackRow;
    if (Math.abs(shifted - origin.item.start) > 0.01 || patch.trackId) apply(patch);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', finish);
}
const overlayImages = new Map();
function overlayImage(ref) {
  if (!ref) return null;
  let image = overlayImages.get(ref);
  if (!image) {
    image = new Image(); image.src = ref;
    image.addEventListener('load', () => drawOverlays());
    overlayImages.set(ref, image);
  }
  return image.complete && image.naturalWidth ? image : null;
}
function drawOverlays() {
  const canvas = $('overlayCanvas'), stage = $('stage'), video = $('video');
  canvas.width = stage.clientWidth * devicePixelRatio; canvas.height = stage.clientHeight * devicePixelRatio;
  const ctx = canvas.getContext('2d'); ctx.scale(devicePixelRatio, devicePixelRatio); ctx.clearRect(0, 0, stage.clientWidth, stage.clientHeight);
  const time = project().timeline.currentTime;
  for (const item of [...project().overlays].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0))) {
    if (!item.visible || time < (item.start ?? 0) || time >= (item.end ?? project().timeline.duration)) continue;
    ctx.save(); ctx.translate(stage.clientWidth * item.x, stage.clientHeight * item.y); ctx.scale(item.scale || 1, item.scale || 1);
    if (item.kind === 'text' && item.content) { ctx.fillStyle = '#fff'; ctx.font = '600 26px Segoe UI, sans-serif'; ctx.textAlign = 'center'; ctx.shadowColor = '#000'; ctx.shadowBlur = 4; ctx.fillText(item.content, 0, 0); }
    else if (item.kind === 'image') { const image = overlayImage(item.sourceRef); if (image) { const width = Math.min(stage.clientWidth / 3, image.naturalWidth); const height = width * image.naturalHeight / image.naturalWidth; ctx.drawImage(image, -width / 2, -height / 2, width, height); } }
    ctx.restore();
  }
  if (media.size && video.readyState >= 2) $('emptyStage').hidden = true;
}
function undoAction() { const before = readState(project(), history, instanceId, capabilities()); history = undo(history); const after = readState(project(), history, instanceId, capabilities()); if (before.stateDigest !== after.stateDigest) $('auditDigest').textContent = `${before.stateDigest} → ${after.stateDigest} · 撤销 R${before.revision}→R${after.revision}`; render(); }
function redoAction() { const before = readState(project(), history, instanceId, capabilities()); history = redo(history); const after = readState(project(), history, instanceId, capabilities()); if (before.stateDigest !== after.stateDigest) $('auditDigest').textContent = `${before.stateDigest} → ${after.stateDigest} · 重做 R${before.revision}→R${after.revision}`; render(); }
let attachedMediaRef = null;
// MediaRecorder 产出的 WebM 头部没有时长，浏览器会报 Infinity；必须先跳到末尾让它解析出真实时长。
function resolveMediaDuration(video) {
  if (Number.isFinite(video.duration) && video.duration > 0) return Promise.resolve(video.duration);
  return new Promise(resolve => {
    const current = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : NaN);
    const cleanup = () => { clearTimeout(timer); video.removeEventListener('durationchange', check); video.removeEventListener('timeupdate', check); };
    const finish = value => { cleanup(); resolve(value); };
    const check = () => { const value = current(); if (Number.isFinite(value)) finish(value); };
    const timer = setTimeout(() => finish(current()), 4000);
    video.addEventListener('durationchange', check);
    video.addEventListener('timeupdate', check);
    try { video.currentTime = 1e7; } catch { finish(NaN); }
  });
}
const media = new Map(); // sourceRef → { element, kind, url }
function mediaFor(ref) {
  return ref ? media.get(ref)?.element ?? null : null;
}
function attachMedia(ref, file, kind) {
  const element = document.createElement(kind === 'audio' ? 'audio' : 'video');
  element.preload = 'auto';
  element.playsInline = true;
  element.dataset.sourceRef = ref;
  $('mediaPool').appendChild(element);
  media.set(ref, { element, kind, url: URL.createObjectURL(file) });
  return element;
}
async function importVideo(file) {
  if (!file) return;
  const generation = ++importGeneration;
  const digest = await digestOf(await file.arrayBuffer());
  if (generation !== importGeneration) return;
  const kind = file.type.startsWith('audio/') ? 'audio' : 'video';
  const incoming = sourceRefFor({ name: file.name, size: file.size, digest });
  const entries = project().tracks.flatMap(track => track.clips.map(clip => ({ track, clip })));
  const exact = entries.find(entry => sameContent(entry.clip.sourceRef, file, digest));
  const legacy = entries.find(entry => legacyMatches(entry.clip.sourceRef, file));
  // 多轨允许多个片段；只有内容完全相同才走重连，其余按新片段加入所选轨道。
  const matched = exact ?? legacy;
  const ref = matched ? matched.clip.sourceRef : incoming;
  // 元素此前是否已经加载，决定“重连”还是“再放一次”。
  const wasLoaded = !!mediaFor(ref);
  const element = mediaFor(ref) ?? attachMedia(ref, file, kind);
  let track = project().tracks.find(item => item.id === selectedTrackId && item.kind === kind) || project().tracks.find(item => item.kind === kind);
  if (!track) { apply({ type: 'media.video.track.add', track: { kind } }); track = project().tracks.find(item => item.kind === kind); }
  attachedMediaRef = ref;
  $('emptyStage').hidden = false;
  $('emptyStage').querySelector('strong').textContent = '正在载入媒体…';
  const finish = async () => {
    if (generation !== importGeneration) return;
    const duration = await resolveMediaDuration(element);
    if (generation !== importGeneration) return;
    if (!Number.isFinite(duration) || duration <= 0) { toast('媒体时长无效，无法加入时间轴'); return; }
    element.currentTime = 0;
    if (matched && !wasLoaded) {
      $('projectName').textContent = file.name.replace(/\.[^.]+$/, '');
      $('emptyStage').hidden = true;
      probeCapabilities();
      toast(legacy ? '媒体已重新连接（旧工程按文件名与大小匹配）' : '媒体已重新连接，工程内容保持不变');
      return;
    }
    // 写入失败（同位置已有片段等）必须把原因说给用户，不能"提示已加入、实际没加"。
    const beforeCount = project().tracks.reduce((sum, item) => sum + item.clips.length, 0);
    try {
      apply({ type: 'media.video.clip.add', clip: { id: crypto.randomUUID(), sourceRef: ref, name: file.name, duration, trackId: track.id, start: project().timeline.currentTime ?? 0 } });
    } catch (error) {
      toast(`导入失败：${error && error.message ? error.message : '未知原因'}`);
      return;
    }
    const afterCount = project().tracks.reduce((sum, item) => sum + item.clips.length, 0);
    if (afterCount <= beforeCount) {
      toast('导入失败：片段没有加入时间轴，请换个位置或先调整已有片段');
      return;
    }
    $('projectName').textContent = file.name.replace(/\.[^.]+$/, '');
    $('emptyStage').hidden = true;
    probeCapabilities();
    toast(kind === 'audio' ? '音频已加入音频轨' : '视频已加入视频轨');
  };
  element.onerror = () => {
    if (generation !== importGeneration) return;
    $('emptyStage').hidden = false;
    $('emptyStage').querySelector('strong').textContent = '无法载入此媒体';
    toast('无法解码此媒体格式');
  };
  // 先绑定元数据/错误事件，再设置 src：设置 src 后事件可能立刻触发，晚绑定会漏掉。
  if (element.readyState >= 1) await finish();
  else element.onloadedmetadata = finish;
  const entry = media.get(ref);
  if (!element.src && entry) { element.src = entry.url; element.load(); }
}
function saveSnapshot() {
  const data = snapshotProject(project()); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${project().source?.name?.replace(/\.[^.]+$/, '') || 'video-project'}.json` }); link.click(); URL.revokeObjectURL(link.href); toast('工程快照已下载；媒体文件未嵌入');
}
function openSnapshot(file) {
  if (!file) return;
  const reader = new FileReader(); reader.onload = () => {
    try {
      const saved = JSON.parse(reader.result);
      if (saved.format !== 'media-video-project' || ![1, 2].includes(saved.version)) throw new Error('工程格式或版本不支持');
      history = commit(history, reduceProject(project(), { type: 'media.video.project.restore', project: saved.project }));
      const sameMedia = !!saved.media?.sourceRef && media.has(saved.media.sourceRef);
      if (!sameMedia) {
        for (const entry of media.values()) { try { entry.element.pause(); } catch { /* detached */ } URL.revokeObjectURL(entry.url); }
        media.clear(); attachedMediaRef = null;
        $('video').removeAttribute('src'); $('video').load();
      }
      $('projectName').textContent = saved.project.source?.name?.replace(/\.[^.]+$/, '') || '未命名工程';
      render();
      if (!saved.media?.sourceRef) toast('工程已打开');
      else if (sameMedia) toast('工程已打开，媒体已重新连接');
      else toast('工程已打开；媒体未嵌入，请重新选择同一源视频');
    } catch (error) { toast(error.message || '工程文件无法读取'); }
  }; reader.readAsText(file);
}
const exportJobs = new Map();
let exportBusy = false;
function exportJobView(job) {
  if (job.status === 'ready' || job.status === 'completed') return { editorKind: 'video', exportId: job.exportId, status: job.status, format: job.format, artifactRef: job.artifactRef, bytes: job.bytes, durationSeconds: job.durationSeconds, audio: job.audio, fileName: job.fileName };
  if (job.status === 'failed') return { editorKind: 'video', exportId: job.exportId, status: 'failed', format: job.format, error: job.error };
  return { editorKind: 'video', exportId: job.exportId, status: job.status, format: job.format, progress: Math.round(job.progress * 100) };
}
function startExport(message) {
  const format = String(message.format || '');
  if (format !== 'webm') throw Object.assign(new Error('本轮只验证 WebM 导出；MP4 未验证，暂不可用'), { code: 'EXPORT_FORMAT_UNAVAILABLE' });
  if (!capabilities().webm) throw Object.assign(new Error('当前浏览器不支持 WebM 录制'), { code: 'EXPORT_UNAVAILABLE' });
  if (!clip()) throw Object.assign(new Error('纯音频工程暂不支持导出视频，请至少放入一个视频片段'), { code: 'EXPORT_EMPTY' });
  if (exportBusy) throw Object.assign(new Error('已有导出正在进行'), { code: 'EXPORT_BUSY' });
  // 后台标签的 rAF 会被节流，合成循环不推进就没有帧可录；在这里直接拒绝，别让用户空等。
  assertForeground();
  const job = { exportId: `export-${crypto.randomUUID()}`, commandId: message.commandId, format, status: 'running', progress: 0, artifactRef: null, bytes: 0, durationSeconds: 0, audio: null, peakDb: null, warning: null, error: null, fileName: 'video-export.webm' };
  exportJobs.set(job.exportId, job);
  runExport(job);
  return { editorKind: 'video', commandId: message.commandId, exportId: job.exportId, status: 'running' };
}
async function runExport(job) {
  exportBusy = true; $('exportVideo').disabled = true; $('exportVideo').textContent = '导出中…';
  try {
    const elements = new Map([...media.entries()].map(([ref, entry]) => [ref, entry.element]));
    const result = await recordComposition({ project: structuredClone(project()), elements, mimeType: webmCapability.mimeType, onProgress: value => { job.progress = value; $('exportVideo').textContent = `导出 ${Math.round(value * 100)}%`; } });
    const url = URL.createObjectURL(result.blob);
    Object.assign(job, { status: 'ready', progress: 1, artifactRef: url, bytes: result.blob.size, durationSeconds: result.durationSeconds, audio: result.hasAudio === true, peakDb: result.peakDb ?? null, warning: result.warning ?? null });
    Object.assign(document.createElement('a'), { href: url, download: job.fileName }).click();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    // 削波只告警，不自动压、不自动降音量（契约口径）。
    if (job.warning) toast(`${job.warning} · ${Math.round(result.blob.size / 1024)} KB`);
    else toast(`WebM 已生成 · ${Math.round(result.blob.size / 1024)} KB · 峰值 ${job.peakDb === null ? '无音频' : `${job.peakDb} dBFS`}`);
  } catch (error) { job.status = 'failed'; job.error = error.message || '导出失败'; toast(`导出失败：${job.error}`); }
  finally { exportBusy = false; $('exportVideo').textContent = '导出 WebM'; render(); }
}
function exportStatusOf(message) {
  const job = exportJobs.get(message.exportId);
  return job ? exportJobView(job) : { editorKind: 'video', exportId: message.exportId, status: 'unknown' };
}
function exportWebm() {
  try { startExport({ commandId: `ui-${crypto.randomUUID()}`, format: 'webm' }); }
  catch (error) { toast(error.message); }
}

for (const inputId of ['videoInput', 'emptyVideoInput']) $(inputId).addEventListener('change', event => { importVideo(event.currentTarget.files?.[0]); event.currentTarget.value = ''; });
function addOverlayImage(file) {
  if (!file) return;
  if (!clip()) return toast('先导入视频再添加图片');
  const ref = URL.createObjectURL(file);
  overlayImages.set(ref, Object.assign(new Image(), { src: ref }));
  apply({ type: 'media.video.overlay.add', overlay: { id: crypto.randomUUID(), kind: 'image', name: file.name, sourceRef: ref } });
  toast('图片叠加对象已加入');
}
$('imageInput').addEventListener('change', event => { addOverlayImage(event.currentTarget.files?.[0]); event.currentTarget.value = ''; });
$('overlayImageInput').addEventListener('change', event => { addOverlayImage(event.currentTarget.files?.[0]); event.currentTarget.value = ''; });
$('play').onclick = () => { if (!$('video').src) return toast('请先导入视频'); if ($('video').paused) $('video').play(); else $('video').pause(); };
$('video').onplay = () => $('play').textContent = 'Ⅱ'; $('video').onpause = () => $('play').textContent = '▶';
$('video').ontimeupdate = () => { const item = clip(); if (!item) return; const time = Math.min(Math.max($('video').currentTime - item.in, 0), project().timeline.duration); recordPlaybackTime(time); render(); };
$('video').onloadeddata = drawOverlays; window.onresize = drawOverlays;
$('undo').onclick = undoAction; $('redo').onclick = redoAction;
$('scrubber').oninput = event => { const time = Number(event.target.value) / 1000 * project().timeline.duration; $('video').currentTime = (clip()?.in || 0) + time; recordPlaybackTime(time); render(); };
$('inPoint').onchange = () => { const item = clip(); if (item) apply({ type: 'media.video.clip.trim', clipId: item.id, in: Number($('inPoint').value) / 100, out: item.out }); };
$('outPoint').onchange = () => { const item = clip(); if (item) apply({ type: 'media.video.clip.trim', clipId: item.id, in: item.in, out: Number($('outPoint').value) / 100 }); };
$('removeClip').onclick = () => { const item = clip(); if (item) apply({ type: 'media.video.clip.remove', clipId: item.id }); };
$('addVideoTrack').onclick = () => apply({ type: 'media.video.track.add', track: { kind: 'video' } });
$('addAudioTrack').onclick = () => apply({ type: 'media.video.track.add', track: { kind: 'audio' } });
$('addTextTrack').onclick = () => apply({ type: 'media.video.track.add', track: { kind: 'text' } });
function toggleOverlayComposer() {
  const textTrack = project().tracks.find(track => track.id === selectedTrackId && track.kind === 'text');
  if (!clip() && !textTrack) return toast('先导入视频，或先选一条字幕轨');
  const composer = $('overlayComposer');
  composer.hidden = !composer.hidden;
  if (!composer.hidden) $('overlayText').focus();
}
function addOverlayText() {
  const input = $('overlayText');
  const text = input.value.trim();
  if (!text) { toast('请先输入叠加文字'); input.focus(); return; }
  const selected = project().tracks.find(track => track.id === selectedTrackId);
  // 选中字幕轨时，文字落成该轨上的一个片段（独立字幕轨）；否则仍是叠加对象。
  if (selected && selected.kind === 'text') {
    const start = project().timeline.currentTime ?? 0;
    apply({ type: 'media.video.clip.add', clip: { trackId: selected.id, text, start, duration: 3 } });
    input.value = '';
    $('overlayComposer').hidden = true;
    toast('已加入字幕轨片段，导出时会烧进成片');
    return;
  }
  apply({ type: 'media.video.overlay.add', overlay: { id: crypto.randomUUID(), kind: 'text', name: text.slice(0, 18), content: text } });
  input.value = '';
  $('overlayComposer').hidden = true;
  toast('文字叠加已加入，导出时会烧进成片');
}
$('addText').onclick = toggleOverlayComposer;
$('overlayAdd').onclick = addOverlayText;
$('overlayText').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); addOverlayText(); }
  if (event.key === 'Escape') { $('overlayComposer').hidden = true; }
});
$('overlayList').onclick = event => { const id = event.target.dataset.removeOverlay; if (id) apply({ type: 'media.video.overlay.remove', overlayId: id }); };
$('saveProject').onclick = saveSnapshot; $('openProject').onclick = () => $('projectInput').click(); $('projectInput').addEventListener('change', event => { openSnapshot(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }); $('exportVideo').onclick = exportWebm;
$('exportQuick').onclick = exportWebm;
$('readState').onclick = () => { const state = readState(project(), history, instanceId, capabilities()); $('auditDigest').textContent = `${state.stateDigest} · revision ${state.revision} · ${state.history.canUndo ? '可撤销' : '无撤销历史'} · 已回读`; toast(`状态已回读 · R${state.revision}`); };
$('zoomIn').onclick = () => { zoom = Math.min(2, zoom + 0.1); $('video').style.transform = `scale(${zoom})`; }; $('zoomOut').onclick = () => { zoom = Math.max(0.7, zoom - 0.1); $('video').style.transform = `scale(${zoom})`; };
render();
probeCapabilities();
bridge = createEditorBridge({  instanceId,
  getState: () => readState(project(), history, instanceId, capabilities()),
  applyCommand: (command, context) => { const ids = [command.clipId, command.overlayId, command.trackId, command.clip?.id, command.overlay?.id, command.track?.id, command.payload?.trackId].filter(Boolean); apply(command, context.commandId); return { changedObjectIds: [...new Set(ids)] }; },
  exportStart: message => startExport(message),
  exportStatus: message => exportStatusOf(message),
  // editor.highlight：只加描边，不改 selection、不改 revision、不进历史。
  highlight: ({ objectIds, ttlMs }) => highlightObjects(objectIds, ttlMs),
  expectedOrigin: location.origin === 'null' ? null : location.origin
});

function highlightObjects(objectIds, ttlMs) {
  const matched = [];
  const missing = [];
  for (const id of objectIds) {
    const node = $('trackList').querySelector(`[data-clip="${id}"]`)
      || $('overlayLane').querySelector(`[data-overlay="${id}"]`)
      || $('trackList').querySelector(`[data-track-row="${id}"]`);
    if (!node) { missing.push(id); continue; }
    matched.push(id);
    node.classList.add('clip-highlight');
    clearTimeout(node.__highlightTimer);
    node.__highlightTimer = setTimeout(() => node.classList.remove('clip-highlight'), ttlMs);
  }
  return { matched, missing };
}

// 选中变化 → 宿主只读通知（≥100ms 节流，不缓存成第二份文档状态）。
let lastNotifiedSelection = null;
function notifySelectionIfChanged() {
  if (!bridge) return;
  const selection = project().selection || null;
  if (selection === lastNotifiedSelection) return;
  lastNotifiedSelection = selection;
  const item = selection ? allClips().find(entry => entry.id === selection) : null;
  bridge.notifySelection({
    selectedObjectIds: selection ? [selection] : [],
    objectKind: item ? (item.text ? 'text-clip' : 'clip') : null,
  });
}

// 页面内不再挂对话面板：真实对话在宿主侧（lib/client.js 的 Conversation），本页只负责编辑器。
