// Real-time export uses one composited video track and the decoded source audio.
export function drawComposition(ctx, width, height, project, video, images, time, includeVideo = true) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height);
  const clip = project.tracks.find(t => t.kind === 'video')?.clips[0];
  if (includeVideo && clip && time >= clip.start && time < clip.start + clip.out - clip.in && video.readyState >= 2) {
    const ratio = Math.min(width / video.videoWidth, height / video.videoHeight);
    const w = video.videoWidth * ratio, h = video.videoHeight * ratio;
    ctx.drawImage(video, (width - w) / 2, (height - h) / 2, w, h);
  }
  for (const item of [...project.overlays].sort((a, b) => a.zIndex - b.zIndex)) {
    if (!item.visible || time < item.start || time >= item.end) continue;
    ctx.save(); ctx.translate(width * item.x, height * item.y); ctx.scale(item.scale, item.scale);
    if (item.kind === 'text') { ctx.fillStyle = '#fff'; ctx.font = `600 ${Math.max(16, height / 18)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.shadowColor = '#000'; ctx.shadowBlur = 4; ctx.fillText(item.content || '', 0, 0); }
    else { const image = images.get(item.sourceRef); if (image) { const w = Math.min(width / 3, image.naturalWidth), h = w * image.naturalHeight / image.naturalWidth; ctx.drawImage(image, -w / 2, -h / 2, w, h); } }
    ctx.restore();
  }
}
export async function loadOverlayImages(project) {
  const images = new Map();
  for (const item of project.overlays.filter(o => o.kind === 'image' && o.sourceRef)) {
    const image = new Image(); image.src = item.sourceRef;
    await image.decode(); images.set(item.sourceRef, image);
  }
  return images;
}
export async function recordComposition({ project, video, mimeType, onProgress = () => {} }) {
  const clip = project.tracks.find(t => t.kind === 'video')?.clips[0];
  if (!clip || !video.src || video.readyState < 2) throw new Error('请先载入工程对应的源视频');
  if (!mimeType || !MediaRecorder.isTypeSupported(mimeType)) throw new Error('当前浏览器没有可用的 WebM 编码器');
  const images = await loadOverlayImages(project);
  const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  const previousTime = video.currentTime, wasPaused = video.paused;
  let stream, source, recorder, frame, timer;
  try {
    video.pause();
    if (Math.abs(video.currentTime - clip.in) > 0.001) await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('定位视频裁切起点超时')); }, 10000);
      const cleanup = () => { clearTimeout(timeout); video.removeEventListener('seeked', done); };
      const done = () => { cleanup(); resolve(); }; video.addEventListener('seeked', done); video.currentTime = clip.in;
    });
    drawComposition(ctx, canvas.width, canvas.height, project, video, images, 0);
    stream = canvas.captureStream(30);
    source = (video.captureStream || video.mozCaptureStream).call(video);
    for (const track of source.getAudioTracks()) stream.addTrack(track);
    recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    const result = new Promise((resolve, reject) => {
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onerror = () => reject(new Error('视频编码失败'));
      recorder.onstop = () => { const blob = new Blob(chunks, { type: mimeType }); blob.size ? resolve(blob) : reject(new Error('编码未产生有效数据')); };
    });
    recorder.start(250);
    const started = performance.now(); let playing = false;
    const draw = () => {
      const elapsed = (performance.now() - started) / 1000;
      if (elapsed >= clip.start && !playing) { playing = true; video.play().catch(() => recorder.state === 'recording' && recorder.stop()); }
      const time = playing ? clip.start + Math.max(0, video.currentTime - clip.in) : elapsed;
      drawComposition(ctx, canvas.width, canvas.height, project, video, images, time);
      onProgress(Math.min(1, time / project.timeline.duration));
      if (time >= project.timeline.duration || (playing && (video.currentTime >= clip.out || video.ended))) { video.pause(); if (recorder.state === 'recording') recorder.stop(); return; }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    timer = setTimeout(() => { if (recorder.state === 'recording') { recorder.stop(); } }, (project.timeline.duration + 15) * 1000);
    const blob = await result;
    if (video.currentTime < clip.out - 0.15) throw new Error('导出提前结束，未覆盖完整裁切范围');
    return { blob, audioTracks: source.getAudioTracks().length, width: canvas.width, height: canvas.height };
  } finally {
    cancelAnimationFrame(frame); clearTimeout(timer); video.pause();
    if (recorder?.state === 'recording') recorder.stop();
    stream?.getTracks().forEach(t => t.stop()); source?.getTracks().forEach(t => t.stop());
    video.currentTime = previousTime; if (!wasPaused) video.play().catch(() => {});
  }
}
