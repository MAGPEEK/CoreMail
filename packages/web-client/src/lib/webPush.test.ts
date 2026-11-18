import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pushAvailability, availabilityHint, urlBase64ToUint8Array, subscribeBody, openMessageTarget, mailDeepLinkTarget,
  SW_OPEN_MESSAGE_TYPE, endsSession,
} from './webPush.ts';

const env = { serviceWorker: true, pushManager: true, notification: true, secureContext: true, permission: 'default' as const };

test('pushAvailability: unsupported → insecure → denied → available', () => {
  assert.equal(pushAvailability({ ...env, pushManager: false }), 'unsupported');
  assert.equal(pushAvailability({ ...env, secureContext: false }), 'insecure');
  assert.equal(pushAvailability({ ...env, permission: 'denied' }), 'denied');
  assert.equal(pushAvailability(env), 'available');
  assert.equal(pushAvailability({ ...env, permission: 'granted' }), 'available');
  assert.equal(availabilityHint('available'), null);
  assert.match(availabilityHint('denied')!, /blockiert/);
});

test('urlBase64ToUint8Array decodes unpadded base64url', () => {
  assert.deepEqual([...urlBase64ToUint8Array('AQID_-8')], [1, 2, 3, 255, 239]);
  assert.equal(urlBase64ToUint8Array(Buffer.alloc(65, 7).toString('base64url')).length, 65);
});

test('subscribeBody: complete subscriptions only, mail.new topic, preview flag', () => {
  assert.deepEqual(subscribeBody({ endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }, true), {
    endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' }, topics: ['mail.new'], showPreview: true,
  });
  assert.equal(subscribeBody({ endpoint: 'https://push.example/x', keys: { p256dh: 'p' } }, false), null);
  assert.equal(subscribeBody({}, false), null);
});

test('openMessageTarget: only the worker message type and webmail /mail paths', () => {
  assert.equal(openMessageTarget({ type: SW_OPEN_MESSAGE_TYPE, url: '/mail?folder=f&message=m' }), '/mail?folder=f&message=m');
  assert.equal(openMessageTarget({ type: SW_OPEN_MESSAGE_TYPE, url: '/mail' }), '/mail');
  assert.equal(openMessageTarget({ type: SW_OPEN_MESSAGE_TYPE, url: '/settings' }), null);
  assert.equal(openMessageTarget({ type: SW_OPEN_MESSAGE_TYPE, url: '//evil.example/mail' }), null);
  assert.equal(openMessageTarget({ type: 'other', url: '/mail' }), null);
  assert.equal(openMessageTarget('nope'), null);
});

test('mailDeepLinkTarget: folder + message ids, anything else is ignored', () => {
  assert.deepEqual(mailDeepLinkTarget(new URLSearchParams('folder=f1&message=m1&mailbox=shared:s1')), { folderId: 'f1', messageId: 'm1' });
  assert.equal(mailDeepLinkTarget(new URLSearchParams('folder=f1')), null);
  assert.equal(mailDeepLinkTarget(new URLSearchParams('folder=../x&message=m1')), null);
});

test('endsSession: only a signed-in → signed-out change ends the push subscription', () => {
  assert.equal(endsSession('tok', null), true);
  assert.equal(endsSession('tok', 'tok2'), false, 'a token refresh keeps it');
  assert.equal(endsSession(null, 'tok'), false, 'a login keeps it');
  assert.equal(endsSession(null, null), false);
});
