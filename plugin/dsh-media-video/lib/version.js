// 版本号的唯一来源是包自己的 package.json：页面与 boot 响应都由服务端从它注入，
// 不在 HTML/JS 里手写第二份，避免「包是 0.1.0、界面还写 0.0.1」这种漂移。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));

export const VERSION = (() => {
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** 页面里的占位符；服务端出 HTML 时替换成真实版本。 */
export const VERSION_TOKEN = '__DSH_STUDIO_VERSION__';

/** 把占位符替换成版本号。纯函数，便于测试；未替换到占位符时原样返回。 */
export function injectStudioVersion(html, version = VERSION) {
  return String(html).split(VERSION_TOKEN).join(String(version));
}
