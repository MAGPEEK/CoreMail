/**
 * BCP smarthost connection test uses the delivery's TLS rules and the stored password.
 * Run: node --import tsx --test src/lib/smarthost-test.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smarthostTestOptions } from './smarthost-test.js';

const stored = { smarthostUsername: 'apikey', smarthostPassword: 's3cret' };

test('an empty password falls back to the stored one for the same user name', () => {
  const o = smarthostTestOptions({ host: 'smtp.example.test', port: 587, tls: true, implicitTls: false, username: 'apikey', password: '' }, stored, {});
  assert.deepEqual(o['auth'], { user: 'apikey', pass: 's3cret' });
  const other = smarthostTestOptions({ host: 'smtp.example.test', port: 587, tls: true, implicitTls: false, username: 'other' }, stored, {});
  assert.deepEqual(other['auth'], { user: 'other', pass: '' });
  const typed = smarthostTestOptions({ host: 'h.test', port: 587, tls: true, implicitTls: false, username: 'apikey', password: 'new' }, stored, {});
  assert.deepEqual(typed['auth'], { user: 'apikey', pass: 'new' });
});

test('TLS certificates are verified like the real delivery (opt-out SMARTHOST_TLS_INSECURE)', () => {
  const o = smarthostTestOptions({ host: 'smtp.example.test', port: 465, tls: false, implicitTls: true }, null, {});
  assert.equal(o['secure'], true);
  assert.deepEqual(o['tls'], { rejectUnauthorized: true, servername: 'smtp.example.test', minVersion: 'TLSv1.2' });
  const insecure = smarthostTestOptions({ host: 'smtp.example.test', port: 465, tls: false, implicitTls: true }, null, { SMARTHOST_TLS_INSECURE: 'true' });
  assert.deepEqual(insecure['tls'], { rejectUnauthorized: false });
});

test('credentials force STARTTLS even with the TLS switch off', () => {
  const o = smarthostTestOptions({ host: 'h.test', port: 25, tls: false, implicitTls: false, username: 'u', password: 'p' }, null, {});
  assert.equal(o['requireTLS'], true);
  assert.equal(o['opportunisticTLS'], false);
  const plain = smarthostTestOptions({ host: 'h.test', port: 25, tls: false, implicitTls: false }, null, {});
  assert.equal(plain['requireTLS'], false);
  assert.equal(plain['opportunisticTLS'], true);
});
