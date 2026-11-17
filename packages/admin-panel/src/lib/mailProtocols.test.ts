import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasMailProtocols, mailProtocolHolder, mailServicesFor, MAIL_PROTOCOLS_LABEL } from './mailProtocols.ts';

test('the switch sends all three mail protocols or none', () => {
  assert.deepEqual(mailServicesFor(true), ['SMTP', 'IMAP', 'POP3']);
  assert.deepEqual(mailServicesFor(false), []);
  // fresh array each time (no shared mutable state between dialogs)
  assert.notEqual(mailServicesFor(true), mailServicesFor(true));
});

test('hasMailProtocols: any mail protocol counts (legacy partial assignments)', () => {
  assert.equal(hasMailProtocols(['SMTP', 'IMAP', 'POP3']), true);
  assert.equal(hasMailProtocols(['IMAP']), true);
  assert.equal(hasMailProtocols([]), false);
  assert.equal(hasMailProtocols(['HTTPS']), false);
  assert.equal(hasMailProtocols(undefined), false);
});

test('mailProtocolHolder: other cert holding the mail protocols, the active one first', () => {
  const certs = [
    { id: 'a', name: 'pending LE', services: ['SMTP', 'IMAP', 'POP3'], isActiveProtocol: false },
    { id: 'b', name: 'mail.example.com', services: ['SMTP', 'IMAP', 'POP3'], isActiveProtocol: true },
    { id: 'c', name: 'www', services: [], isActiveProtocol: false },
  ];
  assert.equal(mailProtocolHolder(certs), 'mail.example.com');
  assert.equal(mailProtocolHolder(certs, 'b'), 'pending LE', 'the edited cert itself is not a holder');
  assert.equal(mailProtocolHolder([certs[2]!]), null);
  assert.equal(mailProtocolHolder(undefined), null);
});

test('switch label', () => {
  assert.equal(MAIL_PROTOCOLS_LABEL, 'Mail-Protokolle (SMTP · IMAP · POP3)');
});
