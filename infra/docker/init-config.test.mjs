// Tests for init-config.mjs (coremail-init-config), no container:
//   node --test infra/docker/init-config.test.mjs
// Mode and symlink cases are skipped on Windows.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST, MAX_OVERRIDE_BYTES, collectBundled, syncConfig } from './init-config.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const posixFs = process.platform !== 'win32';

const scratchDirs = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'cm-config-'));
  scratchDirs.push(dir);
  return dir;
}
after(() => { for (const d of scratchDirs) rmSync(d, { recursive: true, force: true }); });

/** A bundled tree shaped like the image's /usr/share/coremail/config. */
function bundledTree(root) {
  const b = join(root, 'bundled');
  mkdirSync(join(b, 'postgres'), { recursive: true });
  mkdirSync(join(b, 'rspamd', 'local.d'), { recursive: true });
  mkdirSync(join(b, 'pg-backup'), { recursive: true });
  writeFileSync(join(b, 'postgres', '01-init.sql'), 'select 1;\n');
  writeFileSync(join(b, 'postgres', '02-app-role.sh'), '#!/bin/sh\n');
  if (posixFs) chmodSync(join(b, 'postgres', '02-app-role.sh'), 0o755);
  writeFileSync(join(b, 'rspamd', 'local.d', 'actions.conf'), 'reject = 15;\n');
  writeFileSync(join(b, 'rspamd', 'local.d', 'worker-controller.inc'), 'secure_ip = [];\n');
  writeFileSync(join(b, 'pg-backup', 'pg-backup.sh'), 'echo dump\n');
  return b;
}

function setup() {
  const root = scratch();
  const bundledDir = bundledTree(root);
  const configDir = join(root, 'config');
  mkdirSync(configDir);
  const overrideDir = join(root, 'override');
  return { root, bundledDir, configDir, overrideDir };
}

test('collectBundled groups files by directory', () => {
  const { bundledDir } = setup();
  const b = collectBundled(bundledDir);
  assert.deepEqual([...b.keys()].sort(), ['pg-backup', 'postgres', 'rspamd/local.d']);
  assert.deepEqual([...b.get('rspamd/local.d').keys()].sort(), ['actions.conf', 'worker-controller.inc']);
});

test('first run copies every bundled file; second run changes nothing', () => {
  const s = setup();
  const first = syncConfig(s);
  assert.equal(first.reduce((n, x) => n + x.written, 0), 5);
  assert.equal(readFileSync(join(s.configDir, 'postgres', '01-init.sql'), 'utf8'), 'select 1;\n');
  assert.equal(readFileSync(join(s.configDir, 'rspamd', 'local.d', 'actions.conf'), 'utf8'), 'reject = 15;\n');
  assert.equal(readFileSync(join(s.configDir, 'pg-backup', 'pg-backup.sh'), 'utf8'), 'echo dump\n');
  assert.equal(readFileSync(join(s.configDir, 'postgres', MANIFEST), 'utf8'), '01-init.sql\n02-app-role.sh\n');
  if (posixFs) {
    assert.equal(statSync(join(s.configDir, 'postgres', '02-app-role.sh')).mode & 0o777, 0o755);
    assert.equal(statSync(join(s.configDir, 'postgres', '01-init.sql')).mode & 0o777, 0o644);
  }
  const second = syncConfig(s);
  assert.equal(second.reduce((n, x) => n + x.written, 0), 0);
  assert.equal(second.reduce((n, x) => n + x.unchanged, 0), 5);
});

test('an image update overwrites bundled files and removes the ones it no longer carries — nothing else', () => {
  const s = setup();
  syncConfig(s);
  // a file the operator (or anything else) put there is never touched
  writeFileSync(join(s.configDir, 'rspamd', 'local.d', 'foreign.conf'), 'mine\n');
  // the new image: actions.conf changed, worker-controller.inc dropped
  writeFileSync(join(s.bundledDir, 'rspamd', 'local.d', 'actions.conf'), 'reject = 20;\n');
  rmSync(join(s.bundledDir, 'rspamd', 'local.d', 'worker-controller.inc'));
  const r = syncConfig(s).find((x) => x.dir === 'rspamd/local.d');
  assert.deepEqual([r.written, r.removed], [1, 1]);
  assert.equal(readFileSync(join(s.configDir, 'rspamd', 'local.d', 'actions.conf'), 'utf8'), 'reject = 20;\n');
  assert.equal(existsSync(join(s.configDir, 'rspamd', 'local.d', 'worker-controller.inc')), false);
  assert.equal(readFileSync(join(s.configDir, 'rspamd', 'local.d', 'foreign.conf'), 'utf8'), 'mine\n');
});

test('override: rspamd files win per name, extra names are added, removal restores the bundled file', () => {
  const s = setup();
  const od = join(s.overrideDir, 'rspamd', 'local.d');
  mkdirSync(od, { recursive: true });
  writeFileSync(join(od, 'actions.conf'), 'reject = 30;\n');
  writeFileSync(join(od, 'multimap.conf'), 'x = 1;\n');
  // overrides for other directories are ignored (only rspamd/local.d is overridable)
  mkdirSync(join(s.overrideDir, 'postgres'), { recursive: true });
  writeFileSync(join(s.overrideDir, 'postgres', '01-init.sql'), 'drop table x;\n');
  const r = syncConfig(s).find((x) => x.dir === 'rspamd/local.d');
  assert.equal(r.overrides, 2);
  const ld = join(s.configDir, 'rspamd', 'local.d');
  assert.equal(readFileSync(join(ld, 'actions.conf'), 'utf8'), 'reject = 30;\n');
  assert.equal(readFileSync(join(ld, 'multimap.conf'), 'utf8'), 'x = 1;\n');
  assert.equal(readFileSync(join(ld, 'worker-controller.inc'), 'utf8'), 'secure_ip = [];\n');
  assert.equal(readFileSync(join(s.configDir, 'postgres', '01-init.sql'), 'utf8'), 'select 1;\n');
  // the override directory is only read
  assert.equal(readFileSync(join(od, 'actions.conf'), 'utf8'), 'reject = 30;\n');

  rmSync(join(od, 'actions.conf'));
  rmSync(join(od, 'multimap.conf'));
  syncConfig(s);
  assert.equal(readFileSync(join(ld, 'actions.conf'), 'utf8'), 'reject = 15;\n');
  assert.equal(existsSync(join(ld, 'multimap.conf')), false);
});

test('override: odd names and oversized files are skipped with a warning', () => {
  const s = setup();
  const od = join(s.overrideDir, 'rspamd', 'local.d');
  mkdirSync(od, { recursive: true });
  writeFileSync(join(od, 'big.conf'), Buffer.alloc(MAX_OVERRIDE_BYTES + 1));
  writeFileSync(join(od, '-x.conf'), 'x\n');
  const lines = [];
  syncConfig({ ...s, log: (m) => lines.push(m) });
  assert.equal(existsSync(join(s.configDir, 'rspamd', 'local.d', 'big.conf')), false);
  assert.equal(existsSync(join(s.configDir, 'rspamd', 'local.d', '-x.conf')), false);
  assert.ok(lines.some((l) => /big\.conf: larger than/.test(l)));
  assert.ok(lines.some((l) => /-x\.conf: unsupported file name/.test(l)));
});

test('symlinks: never followed in the override directory, replaced (not written through) in the target', { skip: !posixFs }, () => {
  const s = setup();
  const secret = join(s.root, 'secret');
  writeFileSync(secret, 'TOP SECRET\n');
  const od = join(s.overrideDir, 'rspamd', 'local.d');
  mkdirSync(od, { recursive: true });
  symlinkSync(secret, join(od, 'leak.conf'));
  const ld = join(s.configDir, 'rspamd', 'local.d');
  mkdirSync(ld, { recursive: true });
  const victim = join(s.root, 'victim');
  writeFileSync(victim, 'untouched\n');
  symlinkSync(victim, join(ld, 'actions.conf'));
  syncConfig(s);
  assert.equal(existsSync(join(ld, 'leak.conf')), false);
  assert.equal(readFileSync(victim, 'utf8'), 'untouched\n');
  assert.equal(readFileSync(join(ld, 'actions.conf'), 'utf8'), 'reject = 15;\n');
});

test('no config mount → nothing written, exit 0', () => {
  const s = setup();
  const lines = [];
  assert.deepEqual(syncConfig({ ...s, configDir: join(s.root, 'missing'), log: (m) => lines.push(m) }), []);
  assert.match(lines[0], /not mounted/);
});

test('CLI: env defaults and exit codes', () => {
  const s = setup();
  const script = join(here, 'init-config.mjs');
  const ok = spawnSync(process.execPath, [script], {
    env: { ...process.env, COREMAIL_CONFIG_BUNDLED_DIR: s.bundledDir, COREMAIL_CONFIG_DIR: s.configDir, COREMAIL_CONFIG_OVERRIDE_DIR: s.overrideDir },
    encoding: 'utf8',
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /\[init-config\] postgres: 2 file\(s\)/);
  assert.equal(spawnSync(process.execPath, [script, '--bogus'], { encoding: 'utf8' }).status, 1);
});

test('the repository files the image bundles exist (Dockerfile.app COPY sources)', () => {
  const dockerfile = readFileSync(join(here, 'Dockerfile.app'), 'utf8');
  for (const src of ['infra/docker/postgres/init.sql', 'infra/docker/postgres/02-app-role.sh',
    'infra/docker/rspamd/local.d/', 'infra/docker/pg-backup/pg-backup.sh', 'infra/docker/init-config.mjs',
    'infra/docker/coremail-init.sh']) {
    assert.ok(dockerfile.includes(`COPY ${src}`), `Dockerfile.app copies ${src}`);
  }
});
