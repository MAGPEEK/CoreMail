/**
 * 9.4 review: the internal X-CoreMail-* header list is complete — every header
 * CoreMail logic reads is listed and stripped by stripHeaders.
 * Run: node --import tsx --test src/internal-headers.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INTERNAL_MAIL_HEADERS, RULE_FORWARDED_HEADER, DRAFT_PENDING_HEADER, VIRUS_SCAN_HEADER, QUARANTINE_RELEASE_HEADER,
  internalHeadersExcept,
} from './internal-headers.js';
import { stripHeaders } from './quarantine.js';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
(globalThis as unknown as { __prisma: unknown }).__prisma ??= { $on: () => undefined };
const storage = await import('./index.js');

test('the list holds the loop, draft, virus-scan and quarantine headers', () => {
  for (const h of [RULE_FORWARDED_HEADER, DRAFT_PENDING_HEADER, VIRUS_SCAN_HEADER, QUARANTINE_RELEASE_HEADER]) {
    assert.ok(INTERNAL_MAIL_HEADERS.includes(h), h);
  }
  assert.equal(storage.INTERNAL_MAIL_HEADERS, INTERNAL_MAIL_HEADERS, 'one list, exported by the package');
  assert.equal(storage.DRAFT_PENDING_HEADER, DRAFT_PENDING_HEADER);
});

test('stripHeaders removes all of them (any case, folded lines), the body stays', () => {
  const raw = Buffer.from([
    'x-coremail-ruleforwarded: u1', '\tcontinued', `${DRAFT_PENDING_HEADER}: e30=`, 'From: a@x.test', '',
    `${RULE_FORWARDED_HEADER}: body text`, '',
  ].join('\r\n'));
  const out = stripHeaders(raw, INTERNAL_MAIL_HEADERS).toString();
  assert.equal(out, `From: a@x.test\r\n\r\n${RULE_FORWARDED_HEADER}: body text\r\n`);
});

test('internalHeadersExcept keeps the named genuine header only', () => {
  const rest = internalHeadersExcept([RULE_FORWARDED_HEADER.toLowerCase()]);
  assert.equal(rest.includes(RULE_FORWARDED_HEADER), false);
  assert.equal(rest.length, INTERNAL_MAIL_HEADERS.length - 1);
  assert.equal(internalHeadersExcept([]).length, INTERNAL_MAIL_HEADERS.length);
});

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

test('repository guard: every X-CoreMail-* message header read by mail code is in the list', () => {
  // every package that builds, reads or delivers messages (any spelling, also lower-case
  // literals); HTTP headers of the web frontends/API (X-CoreMail-App, -Client, -Signature,
  // -Export-*, -Proto-Verified, -User) are no message headers and filtered by the proxy.
  const packages = fileURLToPath(new URL('../../', import.meta.url));
  const mailPackages = ['smtp-server', 'storage', 'imap-server', 'pop3-server', 'jmap-server', 'activesync', 'security-filter', 'api-gateway', 'mapi-server', 'backup-service', 'caldav-server'];
  const informational = new Set(['x-coremail-calendar-method']);
  const http = /^x-coremail-(app|client|signature|export-|proto-verified|user)/;
  const listed = new Set(INTERNAL_MAIL_HEADERS.map((h) => h.toLowerCase()));
  const missing = new Set<string>();
  for (const pkg of mailPackages) {
    for (const file of sources(join(packages, pkg, 'src'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/x-coremail-[a-z-]*[a-z]/gi)) {
        const name = m[0].toLowerCase();
        if (!listed.has(name) && !informational.has(name) && !http.test(name)) missing.add(m[0]);
      }
    }
  }
  assert.deepEqual([...missing], []);
});
