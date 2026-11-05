// boot 令牌同源校验：桌面端不带 Sec-Fetch-* 时不能被自己的校验拦死，但跨站仍必须拒绝。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootAllowed } from '../lib/http.js';

const req = headers => ({ headers: { host: '127.0.0.1:59302', ...headers } });

test('桌面端缺失 Sec-Fetch-* 时放行（同源 fetch 仍无法被跨源读取）', () => {
  assert.equal(bootAllowed(req({})).ok, true);
  assert.equal(bootAllowed(req({ origin: 'http://127.0.0.1:59302' })).ok, true);
});

test('普通浏览器同源 fetch 放行', () => {
  assert.equal(bootAllowed(req({ 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' })).ok, true);
  assert.equal(bootAllowed(req({ 'sec-fetch-site': 'none', 'sec-fetch-dest': 'empty' })).ok, true);
});

test('跨站请求一律拒绝，并在 403 里给出观测值', () => {
  const cross = bootAllowed(req({ 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'empty', origin: 'https://evil.example' }));
  assert.equal(cross.ok, false);
  assert.equal(cross.reason, 'cross-site');
  assert.equal(cross.observed.origin, 'https://evil.example');
});

test('Origin 与 Host 不一致时拒绝（跨源 fetch 必带 Origin）', () => {
  const evil = bootAllowed(req({ origin: 'https://evil.example' }));
  assert.equal(evil.ok, false);
  assert.equal(evil.reason, 'origin-host-mismatch');
});

test('same-site 但不同源（不同端口）拒绝', () => {
  const other = bootAllowed(req({ origin: 'http://127.0.0.1:5000', 'sec-fetch-site': 'same-site' }));
  assert.equal(other.ok, false);
});

test('Sec-Fetch-Dest 不是 empty（例如 document 导航）拒绝', () => {
  const nav = bootAllowed(req({ 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'document' }));
  assert.equal(nav.ok, false);
  assert.equal(nav.reason, 'sec-fetch-dest');
});
