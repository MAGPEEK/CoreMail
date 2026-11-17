import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externalClientSections } from './externalClients.ts';

const on = { imap: true, pop3: true, smtp: true, activesync: true, dav: true };

test('9.4: everything on (or an older server without `protocols`) shows every section', () => {
  const all = { mail: true, dav: true, profiles: ['imap', 'eas'], any: true };
  assert.deepEqual(externalClientSections(on), all);
  assert.deepEqual(externalClientSections(undefined), all);
});

test('9.4: switched-off protocols hide their sections and profile variants', () => {
  assert.deepEqual(externalClientSections({ ...on, dav: false, activesync: false }),
    { mail: true, dav: false, profiles: ['imap'], any: true });
  assert.deepEqual(externalClientSections({ imap: false, pop3: false, smtp: false, activesync: true, dav: false }),
    { mail: false, dav: false, profiles: ['eas'], any: true });
  assert.deepEqual(externalClientSections({ imap: false, pop3: false, smtp: true, activesync: false, dav: false }),
    { mail: true, dav: false, profiles: [], any: true }, 'SMTP alone: the mail card, no profile (it needs an incoming server)');
  assert.deepEqual(externalClientSections({ imap: false, pop3: false, smtp: false, activesync: false, dav: false }),
    { mail: false, dav: false, profiles: [], any: false });
});
