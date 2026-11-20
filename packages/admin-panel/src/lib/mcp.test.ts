import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clientConfigJson, daysUntil, expiresSoon, isAllowlistEntry, parseAllowlistText, sortTokens, validTokenName,
  TOKEN_PLACEHOLDER, type McpTokenView,
} from './mcp.ts';

test('clientConfigJson: generic JSON with url and bearer header', () => {
  const cfg = JSON.parse(clientConfigJson('https://mail.example.com/mcp')) as { mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }> };
  assert.deepEqual(cfg.mcpServers['coremail'], {
    type: 'http', url: 'https://mail.example.com/mcp', headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` },
  });
  assert.match(clientConfigJson('https://x/mcp', 'cm_mcp_abc'), /"Authorization": "Bearer cm_mcp_abc"/);
});

test('allowlist entries: IPv4, IPv6, CIDR; garbage refused', () => {
  for (const ok of ['10.0.0.0/8', '192.0.2.7', '0.0.0.0/0', '2001:db8::/32', '::1', 'fe80::1', '::ffff:10.1.2.3', '2001:db8:0:0:0:0:0:1/128']) {
    assert.equal(isAllowlistEntry(ok), true, ok);
  }
  for (const bad of ['', '10.0.0.0/33', '256.1.1.1', 'example.com', '10.0.0.0/8/1', '2001:db8::/129', '1::2::3', '10.0.0.1/x']) {
    assert.equal(isAllowlistEntry(bad), false, bad);
  }
  assert.deepEqual(parseAllowlistText('10.0.0.0/8\n192.0.2.7, 10.0.0.0/8\nnope'), { entries: ['10.0.0.0/8', '192.0.2.7'], invalid: ['nope'] });
  assert.deepEqual(parseAllowlistText('  '), { entries: [], invalid: [] });
});

test('token names and expiry hints', () => {
  assert.equal(validTokenName('Laptop'), true);
  assert.equal(validTokenName('   '), false);
  assert.equal(validTokenName('x'.repeat(65)), false);
  assert.equal(validTokenName('a\u0007b'), false);
  const now = Date.parse('2026-11-20T12:00:00Z');
  assert.equal(daysUntil('2026-11-30T12:00:00Z', now), 10);
  assert.equal(expiresSoon({ status: 'active', expiresAt: '2026-11-25T12:00:00Z' }, now), true);
  assert.equal(expiresSoon({ status: 'active', expiresAt: '2027-02-25T12:00:00Z' }, now), false);
  assert.equal(expiresSoon({ status: 'revoked', expiresAt: '2026-11-25T12:00:00Z' }, now), false);
});

test('sortTokens: active first, then newest first', () => {
  const t = (id: string, status: McpTokenView['status'], createdAt: string) => ({ id, status, createdAt } as McpTokenView);
  const sorted = sortTokens([t('a', 'revoked', '2026-11-03'), t('b', 'active', '2026-11-01'), t('c', 'active', '2026-11-02'), t('d', 'expired', '2026-11-04')]);
  assert.deepEqual(sorted.map((x) => x.id), ['c', 'b', 'd', 'a']);
});
