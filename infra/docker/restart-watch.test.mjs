/**
 * restart-watch.py (10.4.2) — the root supervisord event listener behind the
 * BCP container restart. Drives the real script with python3 (skipped when
 * python3 is missing — run it inside the app image, which has python3 + node):
 *
 *   docker run --rm -v "$PWD/infra/docker:/t:ro" --entrypoint node <image> --test /t/restart-watch.test.mjs
 *
 *  - per-boot secret: 64 hex chars, rotated on every start, stale request deleted,
 *    file mode 0400 (0440 root:node when running as root)
 *  - Watch.check: right secret accepted (constant-time compare), the old fixed
 *    token / a wrong secret / oversized / symlink / FIFO rejected, cooldown
 *  - protocol: a wrong request is rejected and logged WITHOUT its content; a
 *    PROCESS_COMMUNICATION event with capture markers + even the right secret
 *    (= text in a log line) never restarts; the right request file stops the
 *    parent (supervisord stand-in) with SIGTERM
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'restart-watch.py');
const hasPython = spawnSync('python3', ['-c', 'import sys; sys.exit(0)']).status === 0;
const skip = hasPython ? false : 'python3 not available (run inside the app image)';
const OLD_FIXED_TOKEN = 'coremail:restart-container';

function py(code, dir) {
  const r = spawnSync('python3', ['-c', code], {
    env: { ...process.env, COREMAIL_RESTART_DIR: dir, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
const load = `import importlib.util as u, os, sys
s = u.spec_from_file_location('rw', ${JSON.stringify(SCRIPT)}); rw = u.module_from_spec(s); s.loader.exec_module(rw)
`;

test('per-boot secret: 64 hex, rotated per start, stale request deleted, not world-readable', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-'));
  writeFileSync(join(dir, 'restart.request'), 'left over from before the start');
  const a = py(`${load}print(rw.write_token())`, dir);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(join(dir, 'restart.token'), 'utf8'), a);
  assert.equal(existsSync(join(dir, 'restart.request')), false, 'stale request deleted');
  const mode = statSync(join(dir, 'restart.token')).mode & 0o777;
  assert.equal(mode, process.getuid?.() === 0 ? 0o440 : 0o400);
  const b = py(`${load}print(rw.write_token())`, dir);
  assert.notEqual(a, b, 'a new secret on every start');
  rmSync(dir, { recursive: true, force: true });
});

test('check: right secret accepted once per cooldown; old fixed token / wrong / oversized / symlink / FIFO rejected', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-'));
  const out = py(`${load}
t = [1000.0]
token = rw.write_token()
w = rw.Watch(token, now=lambda: t[0], cooldown=120)
req = rw.REQUEST_FILE
def put(data):
    with open(req, 'wb') as f: f.write(data)
res = []
res.append(w.check())                                  # none
put(${JSON.stringify(OLD_FIXED_TOKEN)}.encode()); res.append(w.check())
put(('0' * 64).encode()); res.append(w.check())
put(b'<!--XSUPERVISOR:BEGIN-->' + token.encode() + b'<!--XSUPERVISOR:END-->'); res.append(w.check())
put(token.encode() + b'x' * 300); res.append(w.check())
os.symlink(rw.TOKEN_FILE, req); res.append(w.check())   # symlink to the secret itself
os.mkfifo(req); res.append(w.check())
put((token + '\\n').encode()); res.append(w.check())   # accepted
t[0] += 60; put(token.encode()); res.append(w.check()) # within the cooldown
t[0] += 61; put(token.encode()); res.append(w.check()) # after it
res.append(str(os.path.exists(req)))
print('|'.join(res))
`, dir);
  const r = out.split('|');
  assert.equal(r[0], 'none');
  assert.match(r[1], /^reject:wrong secret/, 'the old fixed token no longer works');
  assert.match(r[2], /^reject:wrong secret/);
  assert.match(r[3], /^reject:wrong secret/, 'capture markers around the secret are not a valid request');
  assert.match(r[4], /^reject:oversized/);
  assert.equal(r[5], 'reject:not a regular file');
  assert.equal(r[6], 'reject:not a regular file');
  assert.equal(r[7], 'accept');
  assert.equal(r[8], 'cooldown');
  assert.equal(r[9], 'accept');
  assert.equal(r[10], 'False', 'every request file is consumed');
  for (const v of r) assert.ok(!v.includes(readFileSync(join(dir, 'restart.token'), 'utf8')), 'verdicts never carry the secret');
  rmSync(dir, { recursive: true, force: true });
});

/** The listener under a `sh` parent that stands in for supervisord. */
function startListener(dir) {
  const parent = spawn('sh', ['-c', `python3 ${SCRIPT}; exit 0`], {
    env: { ...process.env, COREMAIL_RESTART_DIR: dir, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  const waiters = [];
  parent.stdout.on('data', (d) => { out += d; for (const w of [...waiters]) w(); });
  parent.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((res) => parent.on('exit', (code, signal) => res({ code, signal })));
  const waitFor = (s) => new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`timeout waiting for ${JSON.stringify(s)}; got ${JSON.stringify(out)}`)), 5000);
    const check = () => { const i = out.indexOf(s); if (i >= 0) { out = out.slice(i + s.length); clearTimeout(timer); waiters.splice(waiters.indexOf(check), 1); res(); } };
    waiters.push(check); check();
  });
  let serial = 0;
  const send = (eventname, payload) => {
    serial += 1;
    const body = Buffer.from(payload);
    parent.stdin.write(`ver:3.0 server:supervisor serial:${serial} pool:restart-watch poolserial:${serial} eventname:${eventname} len:${body.length}\n`);
    parent.stdin.write(body);
  };
  return { parent, exited, waitFor, send, stderr: () => err };
}

test('protocol: log-line injection and wrong requests never restart; the right request does', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-'));
  const l = startListener(dir);
  try {
  await l.waitFor('READY\n');
  const secret = readFileSync(join(dir, 'restart.token'), 'utf8');
  let alive = true;
  void l.exited.then(() => { alive = false; });

  // 1. what an attacker could put into a log line: markers + the old token, and even markers + the real secret
  l.send('PROCESS_COMMUNICATION_STDOUT', `processname:api-gateway groupname:gateway pid:5\n${OLD_FIXED_TOKEN}`);
  await l.waitFor('RESULT 2\nOK'); await l.waitFor('READY\n');
  l.send('PROCESS_COMMUNICATION_STDOUT', `processname:api-gateway groupname:gateway pid:5\n${secret}`);
  await l.waitFor('RESULT 2\nOK'); await l.waitFor('READY\n');
  // 2. a request file with the wrong secret
  writeFileSync(join(dir, 'restart.request'), `<!--XSUPERVISOR:BEGIN-->${OLD_FIXED_TOKEN}<!--XSUPERVISOR:END-->`);
  l.send('TICK_5', 'when:1');
  await l.waitFor('RESULT 2\nOK'); await l.waitFor('READY\n');
  // stderr and stdout are separate pipes — give the log line a moment
  for (let i = 0; i < 50 && !/REJECTED/.test(l.stderr()); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(alive, true, 'no restart');
  assert.match(l.stderr(), /REJECTED a restart request: wrong secret/);
  assert.ok(!l.stderr().includes(OLD_FIXED_TOKEN) && !l.stderr().includes(secret), 'rejections are logged without content; the secret never');

  // 3. the right request → SIGTERM to the parent
  writeFileSync(join(dir, 'restart.request'), `${secret}\n`);
  l.send('TICK_5', 'when:2');
  const { signal } = await l.exited;
  l.parent.stdin.end(); // EOF → the orphaned listener exits like under a stopped supervisord
  l.parent.stdout.destroy();
  l.parent.stderr.destroy();
  assert.equal(signal, 'SIGTERM');
  assert.match(l.stderr(), /restart requested by the api-gateway/);
  assert.ok(!l.stderr().includes(secret));
  } finally {
    // never leave the listener behind (EOF on stdin ends it)
    if (l.parent.exitCode === null && l.parent.signalCode === null) l.parent.kill('SIGKILL');
    l.parent.stdin.destroy(); l.parent.stdout.destroy(); l.parent.stderr.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('symlinked request file pointing at the secret is rejected and removed', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-'));
  const out = py(`${load}
token = rw.write_token()
os.symlink(rw.TOKEN_FILE, rw.REQUEST_FILE)
print(rw.Watch(token).check(), os.path.lexists(rw.REQUEST_FILE))
`, dir);
  assert.equal(out, 'reject:not a regular file False');
  rmSync(dir, { recursive: true, force: true });
});
