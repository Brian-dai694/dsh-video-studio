import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorRelay } from '../lib/relay.js';

test('Host getPage returns immutable live routing without credentials or claimed session', () => {
  const relay = createEditorRelay({ editorKind: 'video' });
  try {
    assert.equal(relay.getPage('missing'), null);
    const registration = relay.register({ editorInstanceId: 'video-instance' });
    const page = relay.getPage('video-instance');
    assert.equal(page.pageId, registration.pageId);
    assert.equal(page.editorInstanceId, 'video-instance');
    assert.equal(page.kind, 'video');
    assert.equal(Object.isFrozen(page), true);
    assert.equal('pageToken' in page, false);
    assert.equal('token' in page, false);
    assert.equal('sessionId' in page, false);
    relay.disconnect(registration);
    assert.equal(relay.getPage('video-instance'), null);
  } finally { relay.close(); }
});

test('Host getPage fails closed after lease expiry and relay close', async () => {
  const relay = createEditorRelay({ leaseMs: 5 });
  relay.register({ editorInstanceId: 'expiring' });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(relay.getPage('expiring'), null);
  relay.close();
  assert.equal(relay.getPage('expiring'), null);
});
