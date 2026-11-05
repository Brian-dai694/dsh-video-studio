// Content-addressed media identity. A source ref must be stable for the same bytes, so a
// reopened project can re-attach the media by picking the same file again.
// 内容寻址的媒体标识：local:<文件名>:<字节数>:sha256:<哈希前32个hex字符>。
// 同一份字节在任何时候、任何机器导入都得到同一个 ref，因此工程快照重开后可以按内容重连，
// 不再依赖 lastModified 这种每次都变的字段。
const HEX = value => [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('');

export function sourceRefFor({ name, size, digest }) {
  return `local:${name}:${size}:sha256:${String(digest).slice(0, 32)}`;
}

export async function digestOf(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? buffer : buffer.buffer ?? buffer;
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return HEX(hash);
}

// Older projects stored the file's lastModified timestamp instead of a digest.
export const isLegacySourceRef = ref => typeof ref === 'string' && /^local:.+:\d+:\d+$/.test(ref);

export function parseSourceRef(ref) {
  if (typeof ref !== 'string') return null;
  const match = /^local:(.+):(\d+):(.+)$/.exec(ref);
  if (!match) return null;
  return { name: match[1], size: Number(match[2]), tail: match[3], legacy: isLegacySourceRef(ref) };
}

export function legacyMatches(ref, file) {
  const parsed = parseSourceRef(ref);
  if (!parsed || !parsed.legacy) return false;
  return parsed.name === file.name && parsed.size === file.size;
}

export function sameContent(ref, file, digest) {
  const parsed = parseSourceRef(ref);
  if (!parsed || parsed.legacy) return false;
  return parsed.name === file.name && parsed.size === file.size && parsed.tail === `sha256:${String(digest).slice(0, 32)}`;
}
