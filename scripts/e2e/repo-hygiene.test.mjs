// Regression tests for container-build defects found by the e2e run.
// Run: node --test scripts/e2e/repo-hygiene.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('Dockerfile.app strips CR from the entrypoint (Windows checkouts)', () => {
  const df = read('infra/docker/Dockerfile.app');
  assert.match(df, /sed -i 's\/\\r\$\/\/' \/entrypoint\.sh/);
});

test('.gitattributes keeps shell scripts and infra/docker files LF', () => {
  const ga = read('.gitattributes');
  assert.match(ga, /^\*\.sh\s+text eol=lf$/m);
  assert.match(ga, /^infra\/docker\/\*\*\s+text eol=lf$/m);
});

test('rspamd local.d/actions.conf has no nested actions { } block (rspamd 4 refuses it)', () => {
  const conf = read('infra/docker/rspamd/local.d/actions.conf')
    .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(conf, /\bactions\s*\{/);
  assert.match(conf, /^\s*reject\s*=\s*\d+;/m);
});
