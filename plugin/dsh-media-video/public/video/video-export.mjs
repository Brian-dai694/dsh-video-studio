// Multi-track export: video tracks composite in order onto one canvas, audio tracks mix
// through a WebAudio graph (linear volume, no compression), and the result is recorded as WebM.
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
  // 字幕轨：独立轨道上的文字片段，按轨道顺序叠在画面之上（不是叠加对象）。
  // 未覆盖区间保持透明/黑底，不做保持、循环或拉伸。
  for (const track of plan.text ?? []) {
    for (const clip of track.clips) {
      const end = clip.start + clip.out - clip.in;
      if (time < clip.start || time >= end) continue;
      const style = clip.style || {};
      const size = Math.max(12, height * (Number(style.size) > 0 ? Number(style.size) : 0.06));
      const lines = String(clip.text ?? '').split('\n').slice(0, 6);
      ctx.save();
      ctx.font = `${style.weight ?? 600} ${size}px ${style.family ?? 'sans-serif'}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = style.color ?? '#fff';
      ctx.shadowColor = '#000';
      ctx.shadowBlur = 6;
      lines.forEach((line, index) => {
        ctx.fillText(line, width / 2, height * 0.92 - (lines.length - 1 - index) * size * 1.35);
      });
      ctx.restore();
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
  // 混音口径（契约）：volume 是线性倍数，不按轨数归一化；不做压缩、不做限幅、不自动降音量。
  // 节点链顺序固定为：trim（片段 in/out 决定播放区间）→ 音量（GainNode）→ 输出。
  // 将来加变速/包络/裁切/延时，就在这一层按 trim → 变速 → 音量 → 包络 → 裁切 → 延时 依次插入。
  const master = audioContext.createAnalyser();
  master.fftSize = 2048;
  master.connect(destination);
  const peakBuffer = new Float32Array(master.fftSize);
  let peak = 0;
  // 录制过程中按帧采样主总线，取样本绝对值最大值；结束时换算成 dBFS 回报。
  const samplePeak = () => {
    if (!master.getFloatTimeDomainData) return;
    master.getFloatTimeDomainData(peakBuffer);
    for (let index = 0; index < peakBuffer.length; index += 1) {
      const value = Math.abs(peakBuffer[index]);
      if (value > peak) peak = value;
    }
  };
  let sources = 0;
  let hasAudio = false;
  const attach = (element, volume) => {
    if (!element) return;
    // 视频片段自带音轨时也走同一条主总线（音量 1.0），与音频轨一起线性相加。
    // single-track project sounding exactly like before multi-track support.
    try {
      const probe = element.captureStream?.();
      if (probe) {
        if (probe.getAudioTracks().length) hasAudio = true;
        probe.getTracks().forEach(track => track.stop());
      }
    } catch { /* captureStream unsupported */ }
    const gain = audioContext.createGain();
    // 线性倍数，0..2；不按输入数除、不做归一化。
    gain.gain.value = Math.max(0, Math.min(2, volume ?? 1));
    gain.connect(master);
    // 同一个媒体元素只绑定一次 source，之后每次导出重新接线到本次的 gain 上。
    let source = elementSources.get(element);
    if (!source) {
      try {
        source = audioContext.createMediaElementSource(element);
        elementSources.set(element, source);
      } catch { source = null; }
    }
    if (source) {
      try { source.disconnect(); } catch { /* not connected */ }
      source.connect(gain);
      sources += 1;
    }
  };
  for (const track of plan.video) for (const clip of track.clips) attach(elements.get(clip.sourceRef), 1);
  for (const track of plan.audio) for (const clip of track.clips) attach(elements.get(clip.sourceRef), track.volume ?? 1);
  return { destination, sources, hasAudio: hasAudio || plan.audio.length > 0, samplePeak, peakDb: () => peakToDb(peak) };
}

// 峰值 PCM 换算：1.0 = 0 dBFS。混音只回报峰值，不做压缩、不自动降音量。
export const peakToDb = value => (value > 0 ? 20 * Math.log10(value) : -Infinity);

// peak ≤ 1.0（0 dBFS 以内）正常返回；超过则成功返回但带中文告警，交给用户决定怎么降。
export function clipWarning(peakDb) {
  if (!Number.isFinite(peakDb) || peakDb <= 0) return null;
  return `混音削波，峰值 +${peakDb.toFixed(1)} dB，请降低部分轨道音量`;
}

// 导出必须在可见的前台标签页里跑：后台标签的 requestAnimationFrame 会被浏览器节流，
// 合成循环不推进，MediaRecorder 就收不到帧。这里提前判断，避免用户等十几秒才看到
// 「编码未产生有效数据」这种看不懂的报错。
export function assertForeground(doc = globalThis.document) {
  if (doc && doc.visibilityState === 'hidden') {
    throw Object.assign(new Error('请切换到该标签页后再导出（后台标签无法录制画面）'), { code: 'EXPORT_NEEDS_FOREGROUND' });
  }
}

// 同一页面里多次导出必须复用同一个 AudioContext：createMediaElementSource 对同一元素只能
// 绑定一次，第一个上下文关闭后元素就永久绑在死上下文上——第二次导出会变哑巴。
let sharedAudioContext = null;
const elementSources = new WeakMap();
function audioContextFor() {
  if (!sharedAudioContext) sharedAudioContext = new AudioContext();
  return sharedAudioContext;
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
  const audioContext = audioContextFor();
  // 没有用户手势时浏览器会把 AudioContext 挂在 suspended，resume() 会一直 pending，
  // 导出就永远停在“导出中…”且进度为 0。这里只等一次，仍不可用就给出可执行的中文原因。
  await Promise.race([audioContext.resume().catch(() => {}), new Promise(resolve => setTimeout(resolve, 800))]);
  if (audioContext.state !== 'running') {
    throw Object.assign(new Error('浏览器拦截了音频播放：请先在页面上点一下再导出（需要用户手势）'), { code: 'EXPORT_AUDIO_BLOCKED' });
  }
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
      audioGraph.samplePeak();
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
      // 峰值只回报，不修改音频；peakDb > 0 时 warning 是中文告警，由调用方展示。
      peakDb: Number(audioGraph.peakDb().toFixed(2)) === -Infinity ? null : Number(audioGraph.peakDb().toFixed(2)),
      warning: clipWarning(audioGraph.peakDb()),
    };
  } finally {
    document.removeEventListener('visibilitychange', onVisibility);
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    for (const element of elements.values()) { try { element.pause(); } catch { /* detached */ } }
    stream?.getTracks().forEach(track => track.stop());
    // 共享上下文不关闭：关闭会让已绑定的元素在下次导出时失声。
  }
}
