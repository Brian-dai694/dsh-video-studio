// Multi-track export: video tracks composite in order onto one canvas, audio tracks mix
// through a WebAudio graph with a limiter, and the result is recorded as WebM.
import { compositePlan } from './video-state.mjs';

export function drawFrame(ctx, width, height, project, elements, time, images) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  const plan = compositePlan(project);
  for (const track of plan.video) {
    for (const clip of track.clips) {
      const end = clip.start + clip.out - clip.in;
      if (time < clip.start || time >= end) continue;
      const element = elements.get(clip.sourceRef);
      if (!element || element.readyState < 2 || !element.videoWidth) continue;
      const ratio = Math.min(width / element.videoWidth, height / element.videoHeight);
      const w = element.videoWidth * ratio, h = element.videoHeight * ratio;
      ctx.drawImage(element, (width - w) / 2, (height - h) / 2, w, h);
    }
  }
  for (const item of [...project.overlays].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0))) {
    if (!item.visible || time < item.start || time >= item.end) continue;
    ctx.save();
    ctx.translate(width * item.x, height * item.y);
    ctx.scale(item.scale || 1, item.scale || 1);
    if (item.kind === 'text') {
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${Math.max(16, height / 18)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = '#000';
      ctx.shadowBlur = 4;
      ctx.fillText(item.content || '', 0, 0);
    } else if (item.kind === 'image') {
      const image = images.get(item.sourceRef);
      if (image) {
        const w = Math.min(width / 3, image.naturalWidth);
        const h = w * image.naturalHeight / image.naturalWidth;
        ctx.drawImage(image, -w / 2, -h / 2, w, h);
      }
    }
    ctx.restore();
  }
}

export async function loadOverlayImages(project) {
  const images = new Map();
  for (const item of project.overlays.filter(o => o.kind === 'image' && o.sourceRef)) {
    const image = new Image();
    image.src = item.sourceRef;
    await image.decode().catch(() => {});
    if (image.naturalWidth) images.set(item.sourceRef, image);
  }
  return images;
}

// Seek every media element to its clip's in-point; the composite clock then advances them.
async function primeElements(plan, elements) {
  const tasks = [];
  const seek = (element, time) => new Promise(resolve => {
    if (Math.abs(element.currentTime - time) < 0.001) { resolve(); return; }
    const done = () => { element.removeEventListener('seeked', done); resolve(); };
    element.addEventListener('seeked', done);
    setTimeout(done, 2000);
    element.currentTime = time;
  });
  for (const track of [...plan.video, ...plan.audio]) for (const clip of track.clips) {
    const element = elements.get(clip.sourceRef);
    if (element) tasks.push(seek(element, clip.in));
  }
  await Promise.all(tasks);
}

function buildAudioGraph(plan, elements, audioContext) {
  const destination = audioContext.createMediaStreamDestination();
  const limiter = audioContext.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  limiter.connect(destination);
  let sources = 0;
  let hasAudio = false;
  const attach = (element, volume) => {
    if (!element) return;
    // A video clip may carry its own audio; routing it through the same limiter keeps a
    // single-track project sounding exactly like before multi-track support.
    try {
      const probe = element.captureStream?.();
      if (probe) {
        if (probe.getAudioTracks().length) hasAudio = true;
        probe.getTracks().forEach(track => track.stop());
      }
    } catch { /* captureStream unsupported */ }
    const gain = audioContext.createGain();
    gain.gain.value = Math.max(0, Math.min(2, volume ?? 1));
    gain.connect(limiter);
    try {
      const source = audioContext.createMediaElementSource(element);
      source.connect(gain);
      sources += 1;
    } catch { /* element already routed */ }
  };
  for (const track of plan.video) for (const clip of track.clips) attach(elements.get(clip.sourceRef), 1);
  for (const track of plan.audio) for (const clip of track.clips) attach(elements.get(clip.sourceRef), track.volume ?? 1);
  return { destination, sources, hasAudio: hasAudio || plan.audio.length > 0 };
}

// 导出必须在可见的前台标签页里跑：后台标签的 requestAnimationFrame 会被浏览器节流，
// 合成循环不推进，MediaRecorder 就收不到帧。这里提前判断，避免用户等十几秒才看到
// 「编码未产生有效数据」这种看不懂的报错。
export function assertForeground(doc = globalThis.document) {
  if (doc && doc.visibilityState === 'hidden') {
    throw Object.assign(new Error('请切换到该标签页后再导出（后台标签无法录制画面）'), { code: 'EXPORT_NEEDS_FOREGROUND' });
  }
}

export async function recordComposition({ project, elements, mimeType, onProgress = () => {} }) {
  const plan = compositePlan(project);
  if (!plan.video.some(track => track.clips.length)) throw new Error('工程中没有可导出的视频片段');
  assertForeground();
  if (!mimeType || !MediaRecorder.isTypeSupported(mimeType)) throw new Error('当前浏览器没有可用的 WebM 编码器');

  const first = plan.video.flatMap(track => track.clips)[0];
  const probe = elements.get(first.sourceRef);
  if (!probe || !probe.videoWidth) throw new Error('请先载入工程对应的源视频');

  const images = await loadOverlayImages(project);
  const canvas = document.createElement('canvas');
  canvas.width = probe.videoWidth;
  canvas.height = probe.videoHeight;
  const ctx = canvas.getContext('2d');
  const audioContext = new AudioContext();
  await audioContext.resume().catch(() => {});
  await primeElements(plan, elements);

  let stream, audioGraph, recorder, frame, timer, interrupted = null;
  // 录制中一旦切到后台，合成循环会被节流；直接中止并给出可执行原因，不产出空文件。
  const onVisibility = () => {
    if (document.visibilityState !== 'hidden' || !recorder || recorder.state !== 'recording') return;
    interrupted = Object.assign(new Error('导出已中止：请保持该标签页在前台（后台标签无法录制画面）'), { code: 'EXPORT_NEEDS_FOREGROUND' });
    try { recorder.stop(); } catch { /* already stopped */ }
  };
  document.addEventListener('visibilitychange', onVisibility);
  try {
    drawFrame(ctx, canvas.width, canvas.height, project, elements, 0, images);
    stream = canvas.captureStream(30);
    audioGraph = buildAudioGraph(plan, elements, audioContext);
    for (const track of audioGraph.destination.stream.getAudioTracks()) stream.addTrack(track);
    recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    const result = new Promise((resolve, reject) => {
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => reject(new Error('视频编码失败'));
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        if (!blob.size) reject(new Error('编码未产生有效数据'));
        else resolve(blob);
      };
    });
    recorder.start(250);

    // Play every element from its own in-point; the composite clock is driven by
    // performance.now() so clips keep their timeline offsets.
    for (const track of [...plan.video, ...plan.audio]) for (const clip of track.clips) elements.get(clip.sourceRef)?.play?.().catch(() => {});

    const started = performance.now();
    const duration = Math.max(0.05, plan.duration);
    const draw = () => {
      const time = (performance.now() - started) / 1000;
      drawFrame(ctx, canvas.width, canvas.height, project, elements, time, images);
      onProgress(Math.min(1, time / duration));
      if (time >= duration) {
        if (recorder.state === 'recording') recorder.stop();
        return;
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    timer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, (duration + 15) * 1000);

    const blob = await result;
    if (interrupted) throw interrupted;
    const elapsed = (performance.now() - started) / 1000;
    if (elapsed < duration - 0.2) throw new Error('导出提前结束，未覆盖完整合成区间');
    return {
      blob,
      width: canvas.width,
      height: canvas.height,
      durationSeconds: Number(duration.toFixed(3)),
      videoTracks: plan.video.length,
      audioTracks: plan.audio.length,
      audioSources: audioGraph.sources,
      hasAudio: audioGraph.hasAudio,
    };
  } finally {
    document.removeEventListener('visibilitychange', onVisibility);
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    for (const element of elements.values()) { try { element.pause(); } catch { /* detached */ } }
    stream?.getTracks().forEach(track => track.stop());
    await audioContext.close().catch(() => {});
  }
}
