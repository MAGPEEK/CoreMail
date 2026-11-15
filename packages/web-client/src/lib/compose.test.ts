import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeLinkUrl, normalizeMessageId, replyThreading } from './compose.ts';

test('safeLinkUrl allows only http, https and mailto', () => {
  assert.equal(safeLinkUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeLinkUrl('  http://example.com '), 'http://example.com/');
  assert.equal(safeLinkUrl('example.com'), 'https://example.com/');
  assert.equal(safeLinkUrl('mailto:a@example.com'), 'mailto:a@example.com');
  for (const bad of [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox', 'file:///etc/passwd', '', '   ',
    'https://',
  ]) {
    assert.equal(safeLinkUrl(bad), null, bad);
  }
  // Quotes / markup cannot break out: the URL is normalised and only used as a mark attribute
  assert.equal(safeLinkUrl('https://x.example/"><img src=x onerror=alert(1)>'), 'https://x.example/%22%3E%3Cimg%20src=x%20onerror=alert(1)%3E');
});

test('normalizeMessageId', () => {
  assert.equal(normalizeMessageId('<abc@host>'), '<abc@host>');
  assert.equal(normalizeMessageId('abc@host'), '<abc@host>');
  assert.equal(normalizeMessageId(' <abc@host> '), '<abc@host>');
  assert.equal(normalizeMessageId(''), null);
  assert.equal(normalizeMessageId(null), null);
  assert.equal(normalizeMessageId('a b@host'), null);
});

test('replyThreading sends the Message-ID header, not the database id', () => {
  assert.deepEqual(
    replyThreading({ id: 'cmabc123', messageId: '<orig@mail.example>' }),
    { inReplyTo: '<orig@mail.example>', references: '<orig@mail.example>' },
  );
  assert.deepEqual(
    replyThreading({ id: 'cmabc123', messageId: '<orig@mail.example>', inReplyTo: '<parent@mail.example>' }),
    { inReplyTo: '<orig@mail.example>', references: '<parent@mail.example> <orig@mail.example>' },
  );
  // No Message-ID header → internal id as fallback (resolved by the server), no References
  assert.deepEqual(replyThreading({ id: 'cmabc123', messageId: null }), { inReplyTo: 'cmabc123' });
});
