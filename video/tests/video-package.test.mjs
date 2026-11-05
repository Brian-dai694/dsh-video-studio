// Guards the packaged runtime copy against drifting from the editable source tree.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const shared = ['index.html', 'host.html', 'host.js', 'video.css', 'video.js', 'video-state.mjs', 'video-bridge.mjs', 'video-capabilities.mjs', 'video-export.mjs'];
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagedRoot = resolve(sourceRoot, '../plugin/dsh-media-studio/public/video');

for (const file of shared) {
  const source = readFileSync(join(sourceRoot, file));
  const packaged = readFileSync(join(packagedRoot, file));
  assert.equal(packaged.equals(source), true, `${file} 的插件运行产物与 video/ 源码不一致，请重新同步 public/video`);
}

const page = readFileSync(join(packagedRoot, 'index.html'), 'utf8');
assert.match(page, /id="overlayImageInput"/, '导入菜单必须提供图片叠加入口');
assert.match(page, /id="exportVideo"/);
const script = readFileSync(join(packagedRoot, 'video.js'), 'utf8');
assert.match(script, /overlayImageInput'\)\.addEventListener\('change'/, 'overlayImageInput 必须绑定 change');
assert.match(script, /exportStart: message => startExport\(message\)/, '原生桥必须接通导出');
assert.match(script, /media\.video\.project\.restore/, '必须支持工程打开');
assert.ok(script.includes('媒体已重新连接'), '工程重开必须支持媒体重连');
console.log(JSON.stringify({ passed: shared.length + 6, scope: 'packaged copy parity + static wiring' }));
