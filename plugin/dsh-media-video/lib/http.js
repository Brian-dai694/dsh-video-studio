// Same-origin routes served by ctx.webServer.register: boot token, relay transport and the
// packaged editor pages for this single editor kind. No separate HTTP server is started.
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { injectStudioVersion, VERSION } from './version.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const SAFE = /^[a-zA-Z0-9._/-]+$/;
const RELAY_ACTIONS = new Set(['register', 'poll', 'respond', 'disconnect']);

/**
 * boot 令牌的同源校验。
 *
 * 不能只信 `Sec-Fetch-Site/Dest`：桌面端（Electron 自定义协议 / webview）经常**不带**这两个头，
 * 结果插件自己的宿主页取 token 会被自己拦成 403。等价判据改为：
 *   1) `Sec-Fetch-Site: cross-site` 直接拒绝（跨站 fetch 一定会带它）；
 *   2) 带 `Origin` 时，其 host 必须与 `Host` 一致（浏览器对跨源请求一定带 Origin）；
 *   3) 其余情况（含缺失 Sec-Fetch-*）放行——令牌本身只经同源页面内存持有，
 *      跨源读取仍被浏览器同源策略挡住。
 * 403 正文带上观测到的头，便于下次定位桌面端真实取值。
 */
export function bootAllowed(req) {
  const headers = req?.headers || {};
  const site = headers['sec-fetch-site'];
  const dest = headers['sec-fetch-dest'];
  const origin = headers.origin;
  const host = headers.host;
  const observed = { site: site ?? null, dest: dest ?? null, origin: origin ?? null, host: host ?? null };
  if (site === 'cross-site') return { ok: false, reason: 'cross-site', observed };
  if (typeof origin === 'string' && origin !== 'null') {
    let originHost = null;
    try { originHost = new URL(origin).host; } catch { return { ok: false, reason: 'bad-origin', observed }; }
    if (!host || originHost !== host) return { ok: false, reason: 'origin-host-mismatch', observed };
  }
  // 桌面端可能没有 Sec-Fetch-*：缺省按同源处理；有值时只接受同源类取值。
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return { ok: false, reason: 'sec-fetch-site', observed };
  if (dest !== undefined && dest !== 'empty') return { ok: false, reason: 'sec-fetch-dest', observed };
  return { ok: true, observed };
}

const send = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
};

async function readJsonBody(req, limit = 262144) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Payload too large'), { code: 'PAYLOAD_TOO_LARGE' });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveFile(res, root, name, version = VERSION) {
  if (typeof name !== 'string' || name.includes('..') || name.startsWith('/') || name.endsWith('.map') || !SAFE.test(name)) {
    send(res, 404, { error: 'Not found' });
    return;
  }
  try {
    const canonicalRoot = await realpath(root);
    const path = await realpath(resolve(root, name));
    const rel = relative(canonicalRoot, path);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || resolve(canonicalRoot, rel) !== path || !(await stat(path)).isFile()) {
      send(res, 404, { error: 'Not found' });
      return;
    }
    const type = MIME[extname(path)] || 'application/octet-stream';
    // HTML 出站时注入版本号：版本只有 package.json 一份来源，页面不手写。
    const bytes = type.startsWith('text/html')
      ? Buffer.from(injectStudioVersion(await readFile(path, 'utf8'), version), 'utf8')
      : await readFile(path);
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
    });
    res.end(bytes);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

// A relay request is accepted only from the same origin that serves this page, with the
// per-process bearer token. The iframe never sees the token; only the wrapper page does.
function authorizeRelay(req, token) {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (typeof host !== 'string' || typeof origin !== 'string') return 'Origin required';
  let originHost;
  try { originHost = new URL(origin).host; } catch { return 'Invalid Origin'; }
  if (originHost !== host) return 'Cross-origin relay request rejected';
  if (req.headers.authorization !== `Bearer ${token}`) return 'Relay authentication failed';
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') return 'JSON content type required';
  if (req.method !== 'POST') return 'POST required';
  return null;
}

async function handleRelay(req, res, { relay, prefix, token, pathname }) {
  const action = pathname.slice(prefix.length);
  if (!RELAY_ACTIONS.has(action)) { send(res, 404, { code: 'INVALID_REQUEST', message: 'Unknown relay route' }); return true; }
  const rejection = authorizeRelay(req, token);
  if (rejection) { send(res, 403, { code: 'INVALID_REQUEST', message: rejection }); return true; }
  try {
    const body = await readJsonBody(req);
    send(res, 200, relay[action](body));
  } catch (error) {
    send(res, error.code === 'RATE_LIMITED' ? 429 : error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400,
      { code: error.code || 'INVALID_REQUEST', message: error.message, retryAfterMs: error.retryAfterMs, revision: error.revision });
  }
  return true;
}

export function createMediaRouter({ relay, editorKind, prefix, token, publicDir, editorRoot = null, version = VERSION }) {
  const hostRoot = resolve(publicDir, 'host');
  const relayPrefix = `${prefix}/relay/`;
  const editorPrefix = `${prefix}/${editorKind}/`;
  const bootPath = `${prefix}/boot`;
  const missing = () => send(null, 0, null);

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://dsh.local');
    const pathname = url.pathname;
    if (!pathname.startsWith(prefix)) return false;

    if (pathname.startsWith(relayPrefix)) return handleRelay(req, res, { relay, prefix: relayPrefix, token, pathname });

    if (req.method !== 'GET') { send(res, 405, { error: 'GET required' }); return true; }

    if (pathname === bootPath) {
      const verdict = bootAllowed(req);
      if (!verdict.ok) {
        send(res, 403, { error: 'Same-origin fetch required', reason: verdict.reason, observed: verdict.observed });
        return true;
      }
      send(res, 200, { accessToken: token, editorKinds: [editorKind], editorVersion: version });
      return true;
    }

    if (pathname === `${prefix}/host` || pathname === `${prefix}/host/`) {
      await serveFile(res, hostRoot, 'host.html', version);
      return true;
    }
    if (pathname.startsWith(`${prefix}/host/`)) {
      await serveFile(res, hostRoot, decodeURIComponent(pathname.slice(`${prefix}/host/`.length)), version);
      return true;
    }
    if (pathname === `${prefix}/${editorKind}`) { res.writeHead(302, { Location: editorPrefix }); res.end(); return true; }
    if (pathname.startsWith(editorPrefix)) {
      if (!editorRoot) { send(res, 503, { error: 'Editor page is not packaged in this build.', code: 'EDITOR_PAGE_UNAVAILABLE' }); return true; }
      await serveFile(res, editorRoot, decodeURIComponent(pathname.slice(editorPrefix.length)) || 'index.html', version);
      return true;
    }
    return false;
  };
}
