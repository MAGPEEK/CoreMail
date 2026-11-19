// Regression tests for container-build defects found by the e2e run.
// Run: node --test scripts/e2e/repo-hygiene.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('e2e results file names stay short (Windows MAX_PATH)', async () => {
  const { resultsFileName } = await import('./results-name.mjs');
  const all = [...read('scripts/e2e/run.mjs').match(/const ALL = \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(all.length > 20);
  assert.equal(resultsFileName(all, all), 'results-all.json');
  assert.equal(resultsFileName(['mapi'], all), 'results-mapi.json');
  assert.equal(resultsFileName(['setup', 'users', 'mapi'], all), 'results-setup+users+mapi.json');
  const long = all.slice(0, -1);
  const name = resultsFileName(long, all);
  assert.match(name, /^results-\d+-steps-[0-9a-f]{10}\.json$/);
  assert.ok(name.length < 40);
  assert.equal(resultsFileName(long, all), name, 'deterministic');
  assert.notEqual(resultsFileName(all.slice(1), all), name);
});

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

test('no source file imports a module both by name and again as a bare side-effect import', async () => {
  // 8.0.0 review: routes/admin/storage.ts had `import '../../middleware/auth.js'`
  // right after the named import from the same module.
  const { readdirSync } = await import('node:fs');
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) {
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(/^import\s+['"]([^'"]+)['"];?\s*$/gm)) {
          if (new RegExp(`^import\\s[^'"]*\\sfrom\\s+['"]${escape(m[1])}['"]`, 'm').test(src)) offenders.push(`${p}: ${m[1]}`);
        }
      }
    }
  };
  for (const pkg of readdirSync(join(root, 'packages'))) {
    try { walk(join(root, 'packages', pkg, 'src')); } catch { /* package without src */ }
  }
  assert.deepEqual(offenders, []);
});

test('every service that checks mail credentials drops the webmail policy cache on its reload signal', async () => {
  // 9.4 e2e: the IMAP/JMAP servers kept the module "App-Passwörter" off for 30 s
  // after it was switched back on — switching on publishes only the reload
  // signal (no auth event), which they did not subscribe to.
  const { readdirSync, existsSync } = await import('node:fs');
  const callsVerifier = (dir) => readdirSync(dir, { withFileTypes: true }).some((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return callsVerifier(p);
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && /\bverifyMailCredentials\(/.test(readFileSync(p, 'utf8'));
  });
  const services = readdirSync(join(root, 'packages'))
    .filter((pkg) => existsSync(join(root, 'packages', pkg, 'src', 'server.ts')) && callsVerifier(join(root, 'packages', pkg, 'src')));
  assert.ok(services.includes('imap-server') && services.includes('jmap-server'), `services found: ${services.join(', ')}`);
  const missing = services.filter((pkg) => !/startWebmailPolicySubscriber\(\)|isWebmailPolicyReload\(/.test(read(`packages/${pkg}/src/server.ts`)));
  assert.deepEqual(missing, []);
});

test('10.0: the room/equipment resource feature stays removed (schema, code, admin API)', async () => {
  // Removed like distribution groups (v5.6.1), public folders and eDiscovery: no
  // model, table, Prisma accessor, booking module or admin route may come back.
  // Only schema-sync's RETIRED_TABLES (infra/docker) and the upgrade e2e step name them.
  const { readdirSync } = await import('node:fs');
  const FORBIDDEN = /\bmodel Resource(Mailbox|Calendar|Booking)\b|\benum ResourceType\b|resource_(mailboxes|calendars|bookings)|\.resource(Mailbox|Calendar|Booking)\b|\bResource(Mailbox|Calendar|Booking)\b|room-booking|resource-booking|calendar-rooms|RoomPicker|\/admin\/resources\b|\/calendar\/rooms\b/;
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js|prisma)$/.test(e.name) && FORBIDDEN.test(readFileSync(p, 'utf8'))) offenders.push(p.slice(root.length + 1));
      else if (/^(room-booking|resource-booking|resource-reply|resource-lock|calendar-rooms|RoomPicker)\b/.test(e.name)) offenders.push(p.slice(root.length + 1));
    }
  };
  for (const pkg of readdirSync(join(root, 'packages'))) {
    try { walk(join(root, 'packages', pkg, 'src')); } catch { /* package without src */ }
  }
  walk(join(root, 'packages', 'storage', 'prisma'));
  assert.deepEqual(offenders, []);
  // the retirement list itself must keep naming the dropped tables
  assert.match(read('infra/docker/schema-sync-classify.mjs'), /resource_mailboxes:[\s\S]*resource_calendars:[\s\S]*resource_bookings:/);
});
