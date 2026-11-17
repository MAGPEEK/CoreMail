import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTlsSocketError, logTlsSocketError, UNTRUSTED_CERT_HINT } from './tls-errors.js';

test('certificate unknown / bad certificate alerts are warn + hint', () => {
  for (const err of [
    Object.assign(new Error('140...:SSL routines:ssl3_read_bytes:sslv3 alert certificate unknown'), { code: 'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN' }),
    Object.assign(new Error('sslv3 alert bad certificate'), { code: 'ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE' }),
    new Error('tlsv1 alert unknown ca'),
  ]) {
    const c = classifyTlsSocketError(err);
    assert.equal(c.level, 'warn');
    assert.equal(c.hint, UNTRUSTED_CERT_HINT);
  }
});

test('peer resets are debug, other handshake errors warn, anything else error', () => {
  assert.equal(classifyTlsSocketError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })).level, 'debug');
  assert.equal(classifyTlsSocketError(Object.assign(new Error('wrong version number'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' })).level, 'warn');
  assert.equal(classifyTlsSocketError(new Error('boom')).level, 'error');
});

test('logTlsSocketError logs the client IP and the hint', () => {
  const lines: Array<[string, Record<string, unknown>, string]> = [];
  const log = {
    warn: (o: object, m: string) => lines.push(['warn', o as Record<string, unknown>, m]),
    error: (o: object, m: string) => lines.push(['error', o as Record<string, unknown>, m]),
    debug: (o: object, m: string) => lines.push(['debug', o as Record<string, unknown>, m]),
  };
  logTlsSocketError(log, Object.assign(new Error('alert certificate unknown'), { code: 'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN' }),
    { service: 'IMAP', ip: '198.51.100.7', port: 993 });
  assert.equal(lines[0]![0], 'warn');
  assert.equal(lines[0]![1]['ip'], '198.51.100.7');
  assert.equal(lines[0]![1]['hint'], UNTRUSTED_CERT_HINT);
  assert.match(lines[0]![2], /^IMAP TLS handshake aborted by the client/);
});
