import { createProject, createHistory, commit, undo, redo, reduceProject, readState, snapshotProject, stateDigest, canUndo, canRedo } from './video-state.mjs';
import { detectWebmCapability } from './video-capabilities.mjs';
import { createEditorBridge } from './video-bridge.mjs';
import { recordComposition } from './video-export.mjs';

const $ = id => document.getElementById(id);
const instanceId = crypto.randomUUID();
let history = createHistory(createProject());
let mode = 'assist';
const localSimulation = true;
const autonomousCapabilities = new Set();
let videoUrl = null;
let mediaRecorder = null;
let webmCapability = { status: 'checking', mimeType: '', reason: '正在探测浏览器能力' };
let importGeneration = 0;
let zoom = 1;
let activeIntent = null;
let toastTimer;
const project = () => history.present;
const clip = () => project().tracks.find(track => track.kind === 'video').clips[0] || null;
const format = seconds => { const value = Math.max(0, Number(seconds) || 0); return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}.${String(Math.floor(value * 100 % 100)).padStart(2, '0')}`; };
const sourceRef = file => `local:${file.name}:${file.size}:${file.lastModified}`;
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
  $('emptyStage').hidden = !!videoUrl; $('video').style.display = videoUrl ? 'block' : 'none';
  $('clip').style.display = item ? 'block' : 'none';
  if (item) {
    $('clip').style.left = `${(item.start / Math.max(duration, 1)) * 100}%`;
    $('clip').style.width = `${((item.out - item.in) / Math.max(duration, 1)) * 100}%`;
    $('clipTitle').textContent = item.name;
    $('inPoint').max = Math.floor(item.duration * 100); $('outPoint').max = Math.floor(item.duration * 100);
    $('inPoint').value = Math.floor(item.in * 100); $('outPoint').value = Math.floor(item.out * 100);
  }
  $('scrubber').value = duration ? String(Math.round(state.timeline.currentTime / duration * 1000)) : '0';
  $('playhead').style.left = `${72 + (duration ? state.timeline.currentTime / duration : 0) * Math.max(0, $('timeline').clientWidth - 73)}px`;
  const overlays = state.overlays;
  $('overlayCount').textContent = overlays.length;
  $('overlayList').innerHTML = overlays.length ? overlays.map(item => `<div class="overlay-item"><span>${item.kind === 'text' ? 'T' : '▧'}</span><span>${escapeHtml(item.name || '叠加对象')}</span><button data-remove-overlay="${item.id}" title="删除">×</button></div>`).join('') : '<div class="empty-list">还没有叠加对象</div>';
  $('overlayLane').innerHTML = overlays.length ? overlays.map(item => `<span class="overlay-chip" data-overlay="${item.id}">${escapeHtml(item.name || '叠加对象')}</span>`).join('') : '<span class="lane-empty">文字与图片叠加</span>';
  drawOverlays();
}
function escapeHtml(text) { return String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
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
  if (videoUrl && video.readyState >= 2) $('emptyStage').hidden = true;
}
function undoAction() { const before = readState(project(), history, instanceId, capabilities()); history = undo(history); const after = readState(project(), history, instanceId, capabilities()); if (before.stateDigest !== after.stateDigest) $('auditDigest').textContent = `${before.stateDigest} → ${after.stateDigest} · 撤销 R${before.revision}→R${after.revision} · 本地模拟`; render(); }
function redoAction() { const before = readState(project(), history, instanceId, capabilities()); history = redo(history); const after = readState(project(), history, instanceId, capabilities()); if (before.stateDigest !== after.stateDigest) $('auditDigest').textContent = `${before.stateDigest} → ${after.stateDigest} · 重做 R${before.revision}→R${after.revision} · 本地模拟`; render(); }
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
function importVideo(file) {
  if (!file) return;
  const video = $('video');
  const generation = ++importGeneration;
  const ref = sourceRef(file);
  const existing = clip();
  if (existing && existing.sourceRef !== ref) { toast('当前工程已有另一段视频；请先删除片段，或打开匹配的工程文件'); return; }
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(file);
  attachedMediaRef = ref;
  $('emptyStage').hidden = false;
  $('emptyStage').querySelector('strong').textContent = '正在载入视频…';
  video.onloadedmetadata = async () => {
    if (generation !== importGeneration) return;
    const duration = await resolveMediaDuration(video);
    if (generation !== importGeneration) return;
    if (!Number.isFinite(duration) || duration <= 0) { toast('视频时长无效，无法加入时间轴'); return; }
    video.currentTime = 0;
    if (existing) {
      $('projectName').textContent = file.name.replace(/\.[^.]+$/, '');
      $('emptyStage').hidden = true;
      probeCapabilities();
      toast('媒体已重新连接，工程内容保持不变');
      return;
    }
    const id = crypto.randomUUID();
    apply({ type: 'media.video.clip.add', clip: { id, sourceRef: ref, name: file.name, duration } });
    $('projectName').textContent = file.name.replace(/\.[^.]+$/, '');
    $('emptyStage').hidden = true;
    probeCapabilities();
    toast('视频已载入，仅在本机预览');
  };
  video.onerror = () => {
    if (generation !== importGeneration) return;
    $('emptyStage').hidden = false;
    $('emptyStage').querySelector('strong').textContent = '无法载入此视频';
    toast('无法解码此视频格式');
  };
  video.src = videoUrl;
  video.load();
}
function makeIntent(raw) {
  const normalized = String(raw ?? '').trim();
  if (!normalized) throw new Error('请先描述要做的操作');
  if (/删除|移除|覆盖|导出|导入/.test(normalized)) return { id: crypto.randomUUID(), operation: 'media.video.clip.remove', risk: 'high', reason: normalized, command: clip() ? { type: 'media.video.clip.remove', clipId: clip().id } : null };
  const match = normalized.match(/(?:加上|添加|加入|写上|放上)(?:一段)?(?:欢迎|标题|文字|字幕)?(?:文字)?[：:「“]?(.+?)[」”]?$|(?:文字|字幕)[：:「“](.+?)[」”]?$/);
  const text = (match?.[1] || match?.[2] || '').trim();
  if (text) return { id: crypto.randomUUID(), operation: 'media.video.overlay.add', risk: 'low', reason: normalized, command: { type: 'media.video.overlay.add', overlay: { id: crypto.randomUUID(), kind: 'text', name: text.slice(0, 18), content: text } } };
  throw new Error('当前原型仅能把文字叠加意图转换为结构化命令；请描述“添加文字：内容”');
}
function showIntent(intent) {
  activeIntent = { ...intent, intentId: intent.intentId || crypto.randomUUID(), approvalId: crypto.randomUUID(), mode, actor: 'local-demo', reason: intent.reason || '对话意图转换为结构化命令', expiresAt: Date.now() + 60000, expectedRevision: project().revision, beforeDigest: stateDigest(project()), idempotencyKey: crypto.randomUUID(), auditRef: `local-audit-${crypto.randomUUID()}` };
  $('commandPreview').hidden = false;
  renderIntentStatus(mode === 'autonomous' && intent.risk === 'low' && autonomousCapabilities.has(intent.operation) ? 'pending' : 'pending');
  $('approveIntent').onclick = () => executeIntent(activeIntent, true);
  $('rejectIntent').onclick = () => { renderIntentStatus('rejected', '用户取消'); activeIntent = null; };
  if (mode === 'autonomous' && intent.risk === 'low' && autonomousCapabilities.has(intent.operation)) executeIntent(activeIntent, false);
}
function renderIntentStatus(status, detail = '') {
  const intent = activeIntent;
  const riskLabel = intent.risk === 'high' ? '高风险 · 始终需要确认' : '低风险操作预览';
  const autonomousAllowed = intent.mode === 'autonomous' && intent.risk === 'low' && autonomousCapabilities.has(intent.operation);
  $('commandPreview').innerHTML = `<small>本地规则模拟 · 非真实 DSH 对话/Agent 接入</small><strong>${riskLabel}</strong><code>${escapeHtml(intent.operation)}<br>${escapeHtml(JSON.stringify(intent.command))}</code><p>影响：${intent.operation === 'media.video.overlay.add' ? '新增 1 个文字叠加对象' : '删除当前视频片段'} · 预期修订 R${intent.expectedRevision}</p><p>门控：intent ${escapeHtml(intent.intentId.slice(0, 8))} · approval ${escapeHtml(intent.approvalId.slice(0, 8))} · ${intent.mode} · actor ${escapeHtml(intent.actor)} · ${new Date(intent.expiresAt).toLocaleTimeString()}</p><p>状态：<b>${status}</b>${detail ? ` · ${escapeHtml(detail)}` : ''}${intent.mode === 'autonomous' && intent.risk === 'low' && !autonomousAllowed ? ' · 缺少 capability 授权' : ''}</p><p>影响摘要：${intent.reason}</p><div class="preview-actions"><button class="approve" id="approveIntent" ${status !== 'pending' ? 'disabled' : ''}>确认执行</button><button class="reject" id="rejectIntent">取消</button></div>`;
}
function executeIntent(intent, humanApproved) {
  if (!intent?.command) { renderIntentStatus('rejected', '没有可执行的目标对象'); return; }
  if (Date.now() > intent.expiresAt || project().revision !== intent.expectedRevision || stateDigest(project()) !== intent.beforeDigest) { renderIntentStatus('rejected', '审批过期或工程修订已变化，请重新读取'); return; }
  const autonomousAllowed = intent.mode === 'autonomous' && intent.risk === 'low' && autonomousCapabilities.has(intent.operation);
  if (intent.risk === 'high' && !humanApproved) { renderIntentStatus('pending', '高风险必须人工确认'); return; }
  if (intent.mode === 'assist' && !humanApproved) { renderIntentStatus('pending', '等待人工确认'); return; }
  if (intent.mode === 'autonomous' && !humanApproved && !autonomousAllowed) { renderIntentStatus('pending', '未获该命令 capability，等待人工处理'); return; }
  if (humanApproved && !window.confirm(`确认执行 ${intent.operation}？本地模拟，不会调用真实 DSH。`)) { renderIntentStatus('rejected', '用户拒绝审批'); return; }
  const before = readState(project(), history, instanceId, capabilities());
  renderIntentStatus('pending', '本地模拟 bridge 执行中');
  try {
    const after = apply(intent.command);
    $('auditDigest').textContent = `${before.stateDigest} → ${after.stateDigest} · ${intent.auditRef} · ${intent.actor}`;
    renderIntentStatus('applied', `R${before.revision}→R${after.revision} · ${before.stateDigest}→${after.stateDigest}`);
    toast(`本地模拟已应用 · 修订 R${after.revision}`);
  } catch (error) { renderIntentStatus('rejected', error.message); toast(error.message); }
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
      if (saved.format !== 'media-video-project' || saved.version !== 1) throw new Error('工程格式或版本不支持');
      history = commit(history, reduceProject(project(), { type: 'media.video.project.restore', project: saved.project }));
      const sameMedia = !!saved.media?.sourceRef && saved.media.sourceRef === attachedMediaRef;
      if (!sameMedia) {
        if (videoUrl) URL.revokeObjectURL(videoUrl);
        videoUrl = null; attachedMediaRef = null;
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
  if (!clip()) throw Object.assign(new Error('工程中没有可导出的视频片段'), { code: 'EXPORT_EMPTY' });
  if (exportBusy) throw Object.assign(new Error('已有导出正在进行'), { code: 'EXPORT_BUSY' });
  const job = { exportId: `export-${crypto.randomUUID()}`, commandId: message.commandId, format, status: 'running', progress: 0, artifactRef: null, bytes: 0, durationSeconds: 0, audio: null, error: null, fileName: 'video-export.webm' };
  exportJobs.set(job.exportId, job);
  runExport(job);
  return { editorKind: 'video', commandId: message.commandId, exportId: job.exportId, status: 'running' };
}
async function runExport(job) {
  exportBusy = true; $('exportVideo').disabled = true; $('exportVideo').textContent = '导出中…';
  try {
    const range = clip();
    const result = await recordComposition({ project: structuredClone(project()), video: $('video'), mimeType: webmCapability.mimeType, onProgress: value => { job.progress = value; $('exportVideo').textContent = `导出 ${Math.round(value * 100)}%`; } });
    const url = URL.createObjectURL(result.blob);
    Object.assign(job, { status: 'ready', progress: 1, artifactRef: url, bytes: result.blob.size, durationSeconds: Number((range.out - range.in).toFixed(3)), audio: result.audioTracks > 0 });
    Object.assign(document.createElement('a'), { href: url, download: job.fileName }).click();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    toast(`WebM 已生成 · ${Math.round(result.blob.size / 1024)} KB · ${result.audioTracks ? '含源音轨' : '素材无音轨'}`);
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
$('clip').addEventListener('pointerdown', event => { if (event.target.matches('input')) return; const startX = event.clientX, oldStart = clip()?.start || 0; $('clip').setPointerCapture(event.pointerId); const move = e => { const seconds = (e.clientX - startX) / Math.max(1, $('videoLane').clientWidth) * Math.max(project().timeline.duration, 1); $('clip').style.transform = `translateX(${e.clientX - startX}px)`; $('clip').dataset.move = String(Math.max(0, oldStart + seconds)); }; const end = () => { $('clip').removeEventListener('pointermove', move); $('clip').removeEventListener('pointerup', end); $('clip').style.transform = ''; const item = clip(); if (item && $('clip').dataset.move) apply({ type: 'media.video.clip.move', clipId: item.id, start: Number($('clip').dataset.move) }); }; $('clip').addEventListener('pointermove', move); $('clip').addEventListener('pointerup', end, { once: true }); });
$('removeClip').onclick = () => { const item = clip(); if (item) apply({ type: 'media.video.clip.remove', clipId: item.id }); };
$('addText').onclick = () => { if (!clip()) return toast('先导入视频再添加文字'); const text = window.prompt('输入叠加文字'); if (text?.trim()) apply({ type: 'media.video.overlay.add', overlay: { id: crypto.randomUUID(), kind: 'text', name: text.trim().slice(0, 18), content: text.trim() } }); };
$('overlayList').onclick = event => { const id = event.target.dataset.removeOverlay; if (id) apply({ type: 'media.video.overlay.remove', overlayId: id }); };
$('saveProject').onclick = saveSnapshot; $('openProject').onclick = () => $('projectInput').click(); $('projectInput').addEventListener('change', event => { openSnapshot(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }); $('exportVideo').onclick = exportWebm;
$('parseIntent').onclick = () => { try { if (!clip()) throw new Error('先导入视频再生成编辑意图'); showIntent(makeIntent($('intentInput').value)); } catch (error) { toast(error.message); } };
document.querySelectorAll('.mode-option').forEach(button => button.onclick = () => { mode = button.dataset.mode; document.querySelectorAll('.mode-option').forEach(item => item.classList.toggle('active', item === button)); $('modeNote').textContent = mode === 'assist' ? '每次写入先预览并由你确认。' : '仅已授权低风险命令可自动执行；高风险仍需人工确认。自主授权仅为本地模拟。'; });
$('grantCapability').onclick = () => { autonomousCapabilities.add('media.video.overlay.add'); toast('已授予本地模拟 capability：media.video.overlay.add'); };
$('readState').onclick = () => { const state = readState(project(), history, instanceId, capabilities()); $('auditDigest').textContent = `${state.stateDigest} · revision ${state.revision} · ${state.history.canUndo ? '可撤销' : '无撤销历史'} · 本地模拟回读`; toast(`状态已回读 · R${state.revision} · 本地模拟`); };
$('zoomIn').onclick = () => { zoom = Math.min(2, zoom + 0.1); $('video').style.transform = `scale(${zoom})`; }; $('zoomOut').onclick = () => { zoom = Math.max(0.7, zoom - 0.1); $('video').style.transform = `scale(${zoom})`; };
render();
probeCapabilities();
createEditorBridge({
  instanceId,
  getState: () => readState(project(), history, instanceId, capabilities()),
  applyCommand: (command, context) => { const ids = [command.clipId, command.overlayId, command.clip?.id, command.overlay?.id].filter(Boolean); apply(command, context.commandId); return { changedObjectIds: [...new Set(ids)] }; },
  exportStart: message => startExport(message),
  exportStatus: message => exportStatusOf(message),
  expectedOrigin: location.origin === 'null' ? null : location.origin
});
