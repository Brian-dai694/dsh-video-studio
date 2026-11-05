export function detectWebmCapability(video, env = globalThis) {
  try {
    const Recorder = env.MediaRecorder;
    if (!Recorder) return { status: 'unavailable', reason: 'MediaRecorder 不可用' };
    if (!video || typeof video.captureStream !== 'function') return { status: 'unavailable', reason: '视频 captureStream 不可用' };
    if (typeof env.HTMLCanvasElement === 'undefined' || typeof env.HTMLCanvasElement.prototype.captureStream !== 'function') return { status: 'unavailable', reason: 'Canvas captureStream 不可用' };
    if (typeof Recorder.isTypeSupported !== 'function') return { status: 'unavailable', reason: '编码能力探测接口不可用' };
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(type => Recorder.isTypeSupported(type));
    return mimeType ? { status: 'available', mimeType, reason: '' } : { status: 'unavailable', reason: '浏览器未报告 WebM 编码支持' };
  } catch (error) {
    return { status: 'unavailable', reason: error?.message || 'WebM 能力探测失败' };
  }
}
