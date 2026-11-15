// Step 14 (v7.1): object storage.
//  - both modes: /healthz + admin API report the driver; RBAC; objects land in the configured store
//  - E2E_STORAGE=filesystem: raw objects are files on the coremail-data volume, no MinIO container
//  - E2E_STORAGE=minio: migration test — deliver mail on MinIO, switch OBJECT_STORAGE to
//    filesystem WITHOUT migrating (startup check must block the mail services), migrate with
//    `coremail storage migrate`, services start, mail byte-exact over IMAP/POP3, resume is a
//    no-op, restart keeps everything.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  check, assert, creds, http, session, waitFor, dockerExec, imapCmd, imapQuote, popCmd, compose, buildMime,
  BASE, CONTAINER, STORAGE_MODE,
} from '../lib.mjs';
import { imapLogin } from './imap.mjs';
import { submit, popLogin } from './pop3.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');

async function health() {
  const r = await fetch(`${BASE}/healthz`).catch(() => null);
  if (!r) return null;
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Raw octets of the message with `subject` in B's INBOX over IMAP and POP3. */
async function readProbe(state, subject) {
  const c = creds();
  const B = state.users.b.email;
  const im = await imapLogin(B, c.userB);
  let imapRaw;
  try {
    assert(im.loginResult.status === 'OK', `IMAP login: ${im.loginResult.text}`);
    await imapCmd(im, 'EXAMINE INBOX');
    const uid = await waitFor(async () => {
      const x = await imapCmd(im, `UID SEARCH SUBJECT ${imapQuote(subject)}`);
      return (x.lines.find((l) => l.startsWith('* SEARCH')) ?? '').split(' ').slice(2).filter(Boolean).at(-1) ?? null;
    }, { timeout: 30000, what: `probe "${subject}" in INBOX` });
    const f = await imapCmd(im, `UID FETCH ${uid} (BODY.PEEK[])`);
    assert(f.status === 'OK' && f.literals.length, `FETCH: ${f.text}`);
    imapRaw = f.literals[0];
  } finally { im.close(); }

  const p = await popLogin(B, c.userB);
  let popRaw;
  try {
    assert(p.loginResult.ok, `POP3 login: ${p.loginResult.text}`);
    const list = await popCmd(p, 'LIST', { multi: true });
    for (const l of list.lines) {
      const id = l.split(' ')[0];
      const top = await popCmd(p, `TOP ${id} 0`, { multi: true });
      if (top.body.includes(subject)) { popRaw = Buffer.from((await popCmd(p, `RETR ${id}`, { multi: true })).body, 'latin1'); }
    }
    await popCmd(p, 'QUIT');
  } finally { p.close(); }
  assert(popRaw, 'probe not found over POP3');
  return { imapRaw, popRaw };
}

function cli(token, args) {
  try {
    return dockerExec(['coremail', '--json', 'storage', ...args], { env: { COREMAIL_TOKEN: token } });
  } catch (err) {
    throw new Error(`coremail storage ${args.join(' ')} failed: ${err.stdout ?? ''}${err.stderr ?? err.message}`.slice(0, 1500));
  }
}

function countRawFiles() {
  return +dockerExec(['sh', '-c', 'find /data/objects/raw -type f ! -name ".tmp-*" 2>/dev/null | wc -l']).trim();
}

export async function run(state) {
  const c = creds();
  const A = state.users.a.email, B = state.users.b.email;
  const passA = state.appPwA ?? c.userA; // MFA users need an app password on SMTP
  const expectedDriver = state.storageMigrated ? 'filesystem' : STORAGE_MODE;
  const admin = await session(state, 'admin', state.adminEmail, c.admin);

  await check('storage: /healthz reports the driver and status ok', async () => {
    const h = await waitFor(async () => { const x = await health(); return x?.body?.storage?.status === 'ok' ? x : null; }, { timeout: 60000, what: 'storage status ok' });
    assert(h.status === 200 && h.body.storage.driver === expectedDriver, JSON.stringify(h.body));
    return `${h.body.storage.driver}: ${h.body.storage.status}`;
  });

  await check('storage: admin API (ORGANIZATION_MANAGEMENT) shows driver + check; USER gets 403', async () => {
    const s = await http('GET', '/api/v1/admin/storage', { token: admin });
    assert(s.status === 200 && s.json.driver === expectedDriver && s.json.health?.status === 'ok', `${s.status} ${s.text.slice(0, 300)}`);
    const tokB = await session(state, 'b', B, c.userB);
    const u = await http('GET', '/api/v1/admin/storage', { token: tokB });
    assert(u.status === 403, `USER → ${u.status}`);
    const m = await http('POST', '/api/v1/admin/storage/migrate', { token: tokB, body: { from: 'minio', to: 'filesystem' } });
    assert(m.status === 403, `USER migrate → ${m.status}`);
    return `${s.json.driver} @ ${s.json.location}, sampled ${s.json.health.sampled}, lifecycle=${s.json.health.lifecycle}`;
  });

  // Probe mail A → B with a 300 KB attachment, delivered on the current driver.
  const subject = `E2E storage probe ${Date.now()}`;
  const raw = buildMime({ from: A, to: B, subject, text: 'storage probe\r\n', attachment: { filename: 'probe.bin', contentType: 'application/octet-stream', data: randomBytes(300 * 1024) } });
  let before;
  await check('storage: probe mail delivered and readable over IMAP + POP3 (identical octets)', async () => {
    await submit(A, passA, B, raw);
    before = await readProbe(state, subject);
    assert(before.imapRaw.equals(before.popRaw), 'IMAP and POP3 octets differ');
    assert(before.imapRaw.subarray(before.imapRaw.length - Buffer.byteLength(raw, 'latin1')).equals(Buffer.from(raw, 'latin1')), 'stored message does not end with the submitted octets');
    return `${before.imapRaw.length} B, sha256 ${sha(before.imapRaw).slice(0, 16)}…`;
  });

  if (STORAGE_MODE === 'filesystem' || state.storageMigrated) {
    await check('storage(filesystem): raw objects are files on the volume, content matches their address', async () => {
      const files = dockerExec(['sh', '-c', 'cd /data/objects && find raw -type f ! -name ".tmp-*"']).trim().split('\n').filter(Boolean);
      assert(files.length > 0, 'no raw files on /data/objects');
      const sums = dockerExec(['sh', '-c', `cd /data/objects && sha256sum ${files.slice(-20).join(' ')}`]).trim().split('\n');
      for (const line of sums) {
        const [sum, path] = line.split(/\s+/);
        assert(path.endsWith(`/${sum}.eml`), `content of ${path} does not match its name`);
      }
      const owner = dockerExec(['stat', '-c', '%U %a', '/data/objects', `/data/objects/${files.at(-1)}`]).trim().split('\n');
      assert(owner[0].startsWith('node 750') && owner[1].startsWith('node 640'), `owner/mode: ${owner.join(' | ')}`);
      return `${files.length} raw files, last ${sums.length} verified, ${owner.join(' | ')}`;
    });
    if (STORAGE_MODE === 'filesystem') {
      await check('storage(filesystem): no MinIO container in this run', async () => {
        const ps = execFileSync('docker', ['ps', '-a', '--filter', `name=^${CONTAINER}-minio$`, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim();
        assert(ps === '', `MinIO container exists: ${ps}`);
        return 'no coremail-e2e-minio';
      });
    }
    return;
  }

  // ── minio mode: migration minio → filesystem ───────────────────────────────
  await check('migrate: dry run counts the objects and writes nothing', async () => {
    const filesBefore = countRawFiles();
    const job = JSON.parse(cli(admin, ['migrate', '--from', 'minio', '--to', 'filesystem', '--dry-run', '--interval', '1']));
    assert(job.progress.phase === 'done' && job.progress.scanned > 0 && job.progress.copied === job.progress.scanned, JSON.stringify(job.progress));
    assert(countRawFiles() === filesBefore, 'dry run wrote files');
    return `${job.progress.scanned} objects (${job.progress.bytesScanned} B) would be copied`;
  });

  await check('migrate: switching OBJECT_STORAGE=filesystem without migrating blocks the mail services', async () => {
    compose(['up', '-d', '--no-deps', 'coremail'], { env: { OBJECT_STORAGE: 'filesystem' } });
    const h = await waitFor(async () => { const x = await health(); return x?.body?.storage?.status === 'missing-objects' ? x : null; }, { timeout: 180000, interval: 2000, what: 'healthz missing-objects' });
    assert(h.status === 503 && h.body.storage.driver === 'filesystem', JSON.stringify(h.body));
    let imapUp = false;
    try { const im = await imapLogin(B, c.userB); imapUp = im.loginResult.status === 'OK'; im.close(); } catch { imapUp = false; }
    assert(!imapUp, 'IMAP served mails although the objects are missing');
    const logs = execFileSync('docker', ['logs', '--since', '5m', CONTAINER], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert(/coremail storage migrate --from minio --to filesystem/.test(logs), 'log does not name the migration command');
    return 'healthz 503 missing-objects, IMAP closed, log names the migration command';
  });

  let job;
  await check('migrate: coremail storage migrate --from minio --to filesystem copies + verifies everything', async () => {
    job = JSON.parse(cli(admin, ['migrate', '--from', 'minio', '--to', 'filesystem', '--interval', '1']));
    const p = job.progress;
    assert(p.phase === 'done' && p.failed === 0 && p.copied > 0 && p.verified >= p.copied, JSON.stringify(p));
    return `${p.copied} copied, ${p.skipped} already present, ${p.verified} verified, ${p.bytesCopied} B`;
  });
  state.storageMigrated = true;

  await check('migrate: mail services start by themselves once the objects are present', async () => {
    const t0 = Date.now();
    await waitFor(async () => { const x = await health(); return x?.status === 200 && x.body.storage.status === 'ok' ? x : null; }, { timeout: 120000, interval: 2000, what: 'healthz ok' });
    await waitFor(async () => { const im = await imapLogin(B, c.userB).catch(() => null); const ok = im?.loginResult.status === 'OK'; im?.close(); return ok; }, { timeout: 150000, interval: 3000, what: 'IMAP login' });
    await waitFor(async () => { const p = await popLogin(B, c.userB).catch(() => null); const ok = p?.loginResult.ok; p?.close(); return ok; }, { timeout: 60000, interval: 3000, what: 'POP3 login' });
    return `services up ${Math.round((Date.now() - t0) / 1000)} s after the migration`;
  });

  await check('migrate: probe + earlier mails byte-exact over IMAP and POP3 from the filesystem', async () => {
    const after = await readProbe(state, subject);
    assert(after.imapRaw.equals(before.imapRaw), 'IMAP octets changed');
    assert(after.popRaw.equals(before.popRaw), 'POP3 octets changed');
    if (state.imapRawSha256 && state.archiveUid) {
      const im = await imapLogin(B, c.userB);
      try {
        await imapCmd(im, 'EXAMINE Archive');
        const f = await imapCmd(im, `UID FETCH ${state.archiveUid} (BODY.PEEK[])`);
        assert(sha(f.literals[0]) === state.imapRawSha256, 'Archive message changed');
      } finally { im.close(); }
    }
    if (state.attachmentId) {
      const tok = await session(state, 'b', B, c.userB);
      const att = await http('GET', `/api/v1/mail/attachments/${state.attachmentId}`, { token: tok, raw: true });
      const body = Buffer.from(await att.arrayBuffer());
      assert(att.status === 200 && sha(body) === state.a2b.attSha256, `attachment ${att.status}`);
    }
    return `probe ${after.imapRaw.length} B identical (IMAP+POP3); Archive message + REST attachment identical`;
  });

  await check('migrate: running it again copies nothing (resumable / idempotent)', async () => {
    const again = JSON.parse(cli(admin, ['migrate', '--from', 'minio', '--to', 'filesystem', '--interval', '1']));
    const p = again.progress;
    assert(p.phase === 'done' && p.copied === 0 && p.skipped === p.scanned && p.scanned >= job.progress.scanned, JSON.stringify(p));
    return `${p.scanned} scanned, all already present`;
  });

  await check('migrate: new mail after the switch is stored on the filesystem; restart keeps it', async () => {
    const n0 = countRawFiles();
    const subject2 = `E2E storage after-switch ${Date.now()}`;
    await submit(A, passA, B, buildMime({ from: A, to: B, subject: subject2, text: 'stored on the filesystem\r\n' }));
    const first = await readProbe(state, subject2);
    assert(countRawFiles() > n0, 'no new raw file on /data/objects');
    compose(['restart', 'coremail']);
    await waitFor(async () => { const x = await health(); return x?.status === 200 && x.body.storage.status === 'ok' ? x : null; }, { timeout: 180000, interval: 2000, what: 'healthz after restart' });
    await waitFor(async () => { const im = await imapLogin(B, c.userB).catch(() => null); const ok = im?.loginResult.status === 'OK'; im?.close(); return ok; }, { timeout: 120000, interval: 3000, what: 'IMAP after restart' });
    const again = await readProbe(state, subject2);
    const probe = await readProbe(state, subject);
    assert(again.imapRaw.equals(first.imapRaw) && probe.imapRaw.equals(before.imapRaw), 'content changed across restart');
    return `raw files ${n0} → ${countRawFiles()}, byte-identical after restart`;
  });
}
