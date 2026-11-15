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

test('IMAP/POP3/SMTP protocol replies are 7-bit ASCII (RFC 9051 TEXT-CHAR, RFC 5321 textstring)', () => {
  const files = [
    'packages/imap-server/src/commands/index.ts', 'packages/imap-server/src/server/index.ts',
    'packages/pop3-server/src/session.ts', 'packages/smtp-server/src/core/session.ts',
  ];
  const offenders = [];
  for (const f of files) {
    read(f).split('\n').forEach((line, i) => {
      if (/(sendNo|sendBad|sendOk|socket\.write|\.send)\(/.test(line) && /[^\x00-\x7f]/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('release version is consistent: Helm appVersion and compose image tags follow package.json', () => {
  // Review 8.0.0: a chart whose appVersion lags behind deploys the previous image (e.g. the
  // 7.0.0 image reads RSPAMD_HOST/PORT and ignores OBJECT_STORAGE) — keep them in lockstep.
  const version = JSON.parse(read('package.json')).version;
  assert.match(read('infra/k8s/Chart.yaml'), new RegExp(`^appVersion: "${version.replace(/\./g, '\\.')}"$`, 'm'), 'infra/k8s/Chart.yaml appVersion');
  assert.match(read('infra/docker/docker-compose.yml'), new RegExp(`image: magpeek/coremail-app:\\$\\{COREMAIL_VERSION:-${version.replace(/\./g, '\\.')}\\}`), 'docker-compose.yml default tag');
  assert.match(read('infra/docker/docker-compose.synology.yml'), new RegExp(`image: magpeek/coremail-app:${version.replace(/\./g, '\\.')}\\n`), 'docker-compose.synology.yml tag');
});

test('object storage (8.0): unchanged .env keeps MinIO; new .env uses the filesystem volume', () => {
  for (const f of ['infra/docker/docker-compose.yml', 'infra/docker/docker-compose.synology.yml']) {
    const dc = read(f);
    assert.match(dc, /OBJECT_STORAGE: \$\{OBJECT_STORAGE:-minio\}/, `${f}: default driver must stay minio for existing installs`);
    assert.match(dc, /^ {2}minio:\n(?: {4}#.*\n)* {4}image:/m, `${f}: minio service must stay enabled by default`);
    const minioBlock = dc.slice(dc.indexOf('\n  minio:'));
    assert.doesNotMatch(minioBlock.split('\n  rspamd:')[0].split('\nnetworks:')[0], /profiles:/, `${f}: no profile on minio`);
    assert.match(dc, /:\/data(\/objects)?\n/, `${f}: storage volume mounted`);
  }
  assert.match(read('infra/docker/docker-compose.yml'), /- coremail-data:\/data\n/);
  assert.match(read('.env.example'), /^OBJECT_STORAGE=filesystem$/m);
  assert.match(read('scripts/setup.sh'), /OBJECT_STORAGE=filesystem/);
});

test('TypeScript sources imported by the e2e steps use erasable syntax only (Node strip-only mode)', async () => {
  // e.g. a TS parameter property in activesync/src/wbxml.ts aborted the eas steps
  const { stripTypeScriptTypes } = await import('node:module');
  const { readdirSync } = await import('node:fs');
  const stepsDir = join(root, 'scripts', 'e2e', 'steps');
  const files = new Set();
  for (const f of readdirSync(stepsDir)) {
    for (const m of read(`scripts/e2e/steps/${f}`).matchAll(/from '(\.\.\/[^']+\.ts)'/g)) {
      files.add(join(stepsDir, m[1]));
    }
  }
  assert.ok(files.size > 0, 'the eas steps import packages/activesync/src/wbxml.ts');
  for (const f of files) {
    assert.doesNotThrow(() => stripTypeScriptTypes(readFileSync(f, 'utf8'), { mode: 'strip' }), f);
  }
});

test('rspamd local.d/actions.conf has no nested actions { } block (rspamd 4 refuses it)', () => {
  const conf = read('infra/docker/rspamd/local.d/actions.conf')
    .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(conf, /\bactions\s*\{/);
  assert.match(conf, /^\s*reject\s*=\s*\d+;/m);
});
