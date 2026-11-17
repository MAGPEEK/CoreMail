/**
 * w1 integration: an unreadable certificate private key (or any other TLS load
 * failure) must never start the implicit-TLS port 993 in plaintext. The
 * IMAP server loads its certificate through loadProtocolTls() (@coremail/storage:
 * unreadable key → self-signed replacement, behaviour tested in
 * storage/src/protocol-tls-fallback.test.ts), logs the unreadable certificate by
 * name and, when loading fails altogether, still serves the replacement.
 * server.ts starts listeners on import, so its TLS path is checked on the source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
const refresh = server.slice(server.indexOf('async function refreshTlsConfig'), server.indexOf('async function keepTlsOn'));

test('IMAP: the protocol certificate comes from loadProtocolTls (self-signed replacement for an unreadable key)', () => {
  assert.match(refresh, /await loadProtocolTls\('IMAP'/);
  assert.doesNotMatch(server, /loadProtocolCert\(/, 'the throwing loader is not used directly');
  assert.match(refresh, /found\.unreadable[\s\S]*log\.error\(\{ certId: found\.unreadable\.certId, certName: found\.unreadable\.certName \}/,
    'the unreadable certificate is named in an error log');
});

test('IMAP: a failed TLS load keeps TLS on with the self-signed replacement (never plaintext on 993)', () => {
  assert.match(refresh, /catch \(err\) \{[\s\S]*await keepTlsOn\(\);/);
  const keep = server.slice(server.indexOf('async function keepTlsOn'));
  assert.match(keep, /if \(_tlsConfig\) return;/, 'a previously loaded certificate stays in use');
  assert.match(keep, /selfSignedReplacement\(/);
  assert.doesNotMatch(server, /will use plaintext|will be skipped/);
  // certificates are loaded before the first listener starts
  assert.ok(server.indexOf('await refreshTlsConfig()') < server.lastIndexOf('await reloadListeners()'));
});
