import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

// @coremail/core validates the environment on import.
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

const { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } = await import('./jwt.js');
const SECRET = process.env['JWT_SECRET']!;

const accessPayload = {
  sub: 'user-1', email: 'a@example.com', role: 'USER' as const,
  domainId: 'domain-1', sessionId: 'session-1', mfaVerified: false,
};

test('verifyAccessToken returns the payload of a valid access token', () => {
  const token = signAccessToken(accessPayload);
  const payload = verifyAccessToken(token);
  assert.equal(payload?.sub, 'user-1');
  assert.equal(payload?.email, 'a@example.com');
});

test('verifyAccessToken rejects a refresh token', () => {
  assert.equal(verifyAccessToken(signRefreshToken('user-1', 'session-1')), null);
});

test('verifyAccessToken returns null instead of throwing for garbage input', () => {
  assert.equal(verifyAccessToken('x'), null);
  assert.equal(verifyAccessToken(''), null);
});

test('verifyAccessToken rejects a token signed with another secret', () => {
  const forged = jwt.sign({ sub: 'user-1', role: 'ORGANIZATION_MANAGEMENT' }, 'another-secret-another-secret-12345');
  assert.equal(verifyAccessToken(forged), null);
});

test('verifyAccessToken rejects an expired token', () => {
  const expired = jwt.sign({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) - 10 }, SECRET);
  assert.equal(verifyAccessToken(expired), null);
});

test('verifyAccessToken rejects the "none" algorithm', () => {
  const unsigned = jwt.sign({ sub: 'user-1' }, '', { algorithm: 'none' });
  assert.equal(verifyAccessToken(unsigned), null);
});

test('verifyAccessToken rejects a token without a subject', () => {
  assert.equal(verifyAccessToken(jwt.sign({ role: 'USER' }, SECRET)), null);
});

test('verifyRefreshToken accepts a refresh token', () => {
  assert.equal(verifyRefreshToken(signRefreshToken('user-1', 'session-1')).sessionId, 'session-1');
});

test('verifyRefreshToken rejects an access token', () => {
  const token = signAccessToken(accessPayload);
  assert.throws(() => verifyRefreshToken(token), /Invalid token type/);
});
