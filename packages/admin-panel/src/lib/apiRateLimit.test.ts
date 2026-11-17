import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitForm, rateLimitEnvNote, API_RATE_LIMIT_FORM_DEFAULTS } from './apiRateLimit.ts';

test('rateLimitForm: stored values, missing fields fall back to the schema defaults', () => {
  assert.deepEqual(rateLimitForm({}), API_RATE_LIMIT_FORM_DEFAULTS);
  assert.deepEqual(rateLimitForm({ apiRateLimitEnabled: false, apiRateLimitPerUser: 900 }), {
    apiRateLimitEnabled: false, apiRateLimitWindowMin: 15, apiRateLimitPerIp: 500, apiRateLimitPerUser: 900,
  });
});

test('rateLimitEnvNote lists the overridden fields with their variables', () => {
  assert.equal(rateLimitEnvNote(undefined), null);
  assert.equal(rateLimitEnvNote([]), null);
  const note = rateLimitEnvNote(['apiRateLimitPerUser', 'unknown']);
  assert.match(note!, /API_RATE_LIMIT_PER_USER/);
  assert.doesNotMatch(note!, /unknown/);
});
