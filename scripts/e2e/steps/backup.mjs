// Step (9.3): backup → restore → IMAP.
//  - B gets a folder "E2E-Backup" with two messages (one with an attachment, flags \Flagged \Seen)
//  - mailbox backup of B (ZIP, encrypted in the backup bucket) → restore of the STORED archive into
//    A (mode subfolder) → A sees "Wiederhergestellt <date>.E2E-Backup" over IMAP, raw byte-exact,
//    flags kept, 9.5: the INTERNALDATE set by APPEND kept; a second restore adds nothing; the
//    downloaded ZIP uploaded again adds nothing
//  - RBAC (HELP_DESK 403, SERVER_MANAGEMENT 403 on restore, COMPLIANCE_MANAGEMENT 403 on the
//    system dump download), validation (mode folder without folderId → 400)
//  - "Empfohlene Sicherung einrichten" creates the nightly system + full schedule once; the system
//    schedule run-now writes a pg_dump into system/… (PGDMP); the created schedules are removed again
// Needs the backup bucket (bundled MinIO) — skipped with E2E_STORAGE=filesystem (no MinIO there).
import { createHash, randomBytes } from 'node:crypto';
import {
  check, record, assert, creds, setCred, http, session, waitFor, imapCmd, imapQuote, buildMime, STORAGE_MODE, DOMAIN,
} from '../lib.mjs';
import { imapLogin } from './imap.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
/** IMAP date-time the first source message is appended with (9.5: preserved by the restore). */
const INTERNAL_DATE = '03-Nov-2025 07:08:09 +0000';
const B_URL = '/api/v1/admin/backups';

/** Admin-role user for the RBAC checks (created once via the admin API, like users.mjs); returns a session token. */
async function roleSession(state, admin, key, role) {
  const email = `${key}@${DOMAIN}`;
  let pw = creds()[key];
  if (!pw) { pw = `${key.slice(0, 3)}-${randomBytes(10).toString('hex')}`; setCred(key, pw); }
  const list = (await http('GET', '/api/v1/admin/mailboxes', { token: admin })).json ?? [];
  const existing = list.find((x) => x.email === email);
  if (!existing) {
    const r = await http('POST', '/api/v1/admin/mailboxes', {
      token: admin, body: { email, displayName: `${role} E2E`, password: pw, role, domainId: state.domainId },
    });
    assert(r.status === 201, `create ${role}: ${r.status} ${r.text.slice(0, 200)}`);
  } else if (existing.role !== role) {
    const r = await http('PUT', `/api/v1/admin/mailboxes/${existing.id}`, { token: admin, body: { role, password: pw } });
    assert(r.status === 200, `role ${role}: ${r.status} ${r.text.slice(0, 200)}`);
  }
  return session(state, key, email, pw);
}

async function waitJob(token, jobId, what) {
  return waitFor(async () => {
    const r = await http('GET', `${B_URL}/jobs?limit=200`, { token });
    const j = (r.json ?? []).find((x) => x.id === jobId);
    return j && !['RUNNING', 'PENDING', 'PROCESSING', 'RETRYING', 'SCHEDULED'].includes(j.status) ? j : null;
  }, { timeout: 300000, interval: 2000, what });
}

/** UIDs + raw octets + flags of all messages in `folder` (EXAMINE, read-only). */
async function folderMessages(user, pass, folder) {
  const c = await imapLogin(user, pass);
  try {
    assert(c.loginResult.status === 'OK', `IMAP login ${user}: ${c.loginResult.text}`);
    const ex = await imapCmd(c, `EXAMINE ${imapQuote(folder)}`);
    assert(ex.status === 'OK', `EXAMINE ${folder}: ${ex.text}`);
    const f = await imapCmd(c, 'FETCH 1:* (UID FLAGS INTERNALDATE BODY.PEEK[])');
    if (f.status !== 'OK') return [];
    const out = [];
    f.lines.forEach((l) => {
      const m = l.match(/^\* \d+ FETCH .*?<literal:(\d+)>/);
      if (!m) return;
      out.push({
        flags: (l.match(/FLAGS \(([^)]*)\)/)?.[1] ?? '').split(' ').filter(Boolean),
        internalDate: l.match(/INTERNALDATE "([^"]+)"/)?.[1] ?? null,
        raw: f.literals[+m[1]],
      });
    });
    return out;
  } finally { c.close(); }
}

async function listFolders(user, pass, pattern) {
  const c = await imapLogin(user, pass);
  try {
    const r = await imapCmd(c, `LIST "" ${imapQuote(pattern)}`);
    return r.lines.filter((l) => l.startsWith('* LIST')).map((l) => {
      const q = l.match(/"((?:[^"\\]|\\.)*)"\s*$/);
      return q ? q[1].replace(/\\(.)/g, '$1') : l.split(' ').at(-1);
    });
  } finally { c.close(); }
}

export async function run(state) {
  if (STORAGE_MODE === 'filesystem') {
    record('backup: export → restore → IMAP', 'SKIP', 'E2E_STORAGE=filesystem runs without MinIO — no backup bucket');
    return;
  }
  const c = creds();
  const A = state.users.a, B = state.users.b;
  const passA = state.appPwA ?? c.userA; // MFA users need an app password on IMAP
  const admin = await session(state, 'admin', state.adminEmail, c.admin);
  const token = randomBytes(4).toString('hex');
  const subjects = [`E2E backup attachment ${token}`, `E2E backup plain ${token}`];
  const SRC = 'E2E-Backup';
  const sourceRaw = new Map();

  await check('backup: source folder in B with an attachment and flags (IMAP APPEND)', async () => {
    const s = await imapLogin(B.email, c.userB);
    try {
      assert(s.loginResult.status === 'OK', `IMAP login B: ${s.loginResult.text}`);
      await imapCmd(s, `CREATE ${imapQuote(SRC)}`); // ALREADYEXISTS on a re-run is fine
      const m1 = Buffer.from(buildMime({ from: A.email, to: B.email, subject: subjects[0], text: 'with attachment',
        attachment: { filename: 'e2e.bin', contentType: 'application/octet-stream', data: randomBytes(3000) } }), 'latin1');
      const m2 = Buffer.from(buildMime({ from: A.email, to: B.email, subject: subjects[1], text: 'plain' }), 'latin1');
      // 9.5: an explicit internal date (not the Date header, not "now") — the restore must keep it
      const r1 = await imapCmd(s, `APPEND ${imapQuote(SRC)} (\\Flagged \\Seen) "${INTERNAL_DATE}"`, { literal: m1 });
      const r2 = await imapCmd(s, `APPEND ${imapQuote(SRC)} ()`, { literal: m2 });
      assert(r1.status === 'OK' && r2.status === 'OK', `APPEND: ${r1.text} / ${r2.text}`);
      sourceRaw.set(subjects[0], m1);
      sourceRaw.set(subjects[1], m2);
    } finally { s.close(); }
    return `2 messages in ${SRC}`;
  });

  let backupJob;
  await check('backup: mailbox backup of B (ZIP) completes', async () => {
    const r = await http('POST', `${B_URL}/mailbox/${B.id}`, { token: admin, body: { format: 'zip' } });
    assert(r.status === 202, `${r.status} ${r.text.slice(0, 200)}`);
    backupJob = await waitJob(admin, r.json.jobId, 'mailbox backup');
    assert(backupJob.status === 'COMPLETED' && backupJob.downloadUrl?.endsWith('.zip.enc'), JSON.stringify(backupJob).slice(0, 300));
    return `${backupJob.messageCount} messages → ${backupJob.downloadUrl}`;
  });
  if (!backupJob) return;

  let restoreFolder;
  await check('backup: restore of the stored archive into A (subfolder) — A sees the messages over IMAP, byte-exact, flags kept', async () => {
    const r = await http('POST', `${B_URL}/restore`, { token: admin, body: { jobId: backupJob.id, targetUserId: A.id, mode: 'subfolder' } });
    assert(r.status === 202, `${r.status} ${r.text.slice(0, 300)}`);
    assert(/^Wiederhergestellt \d{4}-\d{2}-\d{2}$/.test(r.json.targetFolder ?? ''), `targetFolder ${r.json.targetFolder}`);
    const job = await waitJob(admin, r.json.jobId, 'restore job');
    assert(job.status === 'COMPLETED', `restore ${job.status}: ${job.errorMsg}`);
    assert(job.scope === 'restore' && job.progressMeta?.imported >= 2, JSON.stringify(job.progressMeta));
    restoreFolder = `${r.json.targetFolder}.${SRC}`;
    const names = await listFolders(A.email, passA, `${r.json.targetFolder}*`);
    assert(names.includes(restoreFolder), `LIST: ${names.join(', ')}`);
    const msgs = await folderMessages(A.email, passA, restoreFolder);
    for (const [subject, raw] of sourceRaw) {
      const hit = msgs.find((m) => m.raw.toString('latin1').includes(subject));
      assert(hit, `"${subject}" not in ${restoreFolder}`);
      assert(sha(hit.raw) === sha(raw), `"${subject}" differs (${hit.raw.length} vs ${raw.length} bytes)`);
      if (subject === subjects[0]) {
        assert(hit.flags.includes('\\Flagged') && hit.flags.includes('\\Seen'), `flags ${hit.flags}`);
        assert(hit.internalDate === INTERNAL_DATE, `INTERNALDATE ${hit.internalDate} — expected the original ${INTERNAL_DATE}`);
      } else assert(!hit.flags.includes('\\Seen'), `unread message restored as read: ${hit.flags}`);
    }
    return `${job.progressMeta.imported} restored into ${restoreFolder}, INTERNALDATE kept`;
  });

  await check('backup: a second restore of the same archive adds nothing (idempotent)', async () => {
    const before = (await folderMessages(A.email, passA, restoreFolder)).length;
    const r = await http('POST', `${B_URL}/restore`, { token: admin, body: { key: backupJob.downloadUrl, targetUserId: A.id, mode: 'subfolder' } });
    assert(r.status === 202, `${r.status} ${r.text.slice(0, 200)}`);
    const job = await waitJob(admin, r.json.jobId, 'second restore');
    assert(job.status === 'COMPLETED' && job.progressMeta?.imported === 0 && job.progressMeta?.duplicates >= 2, JSON.stringify(job.progressMeta));
    const after = (await folderMessages(A.email, passA, restoreFolder)).length;
    assert(after === before, `${before} → ${after} messages`);
    return `${job.progressMeta.duplicates} duplicates skipped`;
  });

  await check('backup: downloaded ZIP uploaded again (upload restore) adds nothing', async () => {
    const dl = await http('GET', `${B_URL}/download/${backupJob.id}`, { token: admin, raw: true });
    assert(dl.status === 200, `download ${dl.status}`);
    const zip = Buffer.from(await dl.arrayBuffer());
    assert(zip.subarray(0, 2).toString('latin1') === 'PK', 'download is the decrypted ZIP');
    const r = await http('POST', `${B_URL}/import/${A.id}?mode=subfolder`, {
      token: admin, body: zip, headers: { 'Content-Type': 'application/octet-stream' },
    });
    assert(r.status === 202 && r.json.format === 'zip', `${r.status} ${r.text.slice(0, 200)}`);
    const job = await waitJob(admin, r.json.jobId, 'upload restore');
    assert(job.status === 'COMPLETED' && job.progressMeta?.imported === 0, JSON.stringify(job.progressMeta));
    return `${job.progressMeta.duplicates} duplicates skipped`;
  });

  await check('backup: restore validation + RBAC (HELP_DESK 403, mode folder needs folderId)', async () => {
    const bad = await http('POST', `${B_URL}/restore`, { token: admin, body: { jobId: backupJob.id, mode: 'folder' } });
    assert(bad.status === 400, `mode folder without folderId → ${bad.status}`);
    const hd = await session(state, 'helpdesk', `helpdesk@${DOMAIN}`, c.helpdesk);
    const r = await http('POST', `${B_URL}/restore`, { token: hd, body: { jobId: backupJob.id } });
    assert(r.status === 403, `HELP_DESK → ${r.status}`);
    return 'ok';
  });

  await check('backup: RBAC — SERVER_MANAGEMENT may not restore (403), but lists jobs', async () => {
    const srv = await roleSession(state, admin, 'srvmgmt', 'SERVER_MANAGEMENT');
    const jobs = await http('GET', `${B_URL}/jobs?limit=5`, { token: srv });
    assert(jobs.status === 200, `SERVER_MANAGEMENT job list → ${jobs.status} (session must be valid)`);
    const r = await http('POST', `${B_URL}/restore`, { token: srv, body: { jobId: backupJob.id, targetUserId: A.id, mode: 'subfolder' } });
    assert(r.status === 403, `SERVER_MANAGEMENT restore → ${r.status} ${r.text.slice(0, 200)}`);
    return '403';
  });

  let systemJobId;
  await check('backup: "Empfohlene Sicherung einrichten" + system backup (pg_dump) run-now', async () => {
    const before = (await http('GET', `${B_URL}/schedules`, { token: admin })).json ?? [];
    const r = await http('POST', `${B_URL}/schedules/recommended`, { token: admin, body: {} });
    assert(r.status === 201 || r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    const created = r.json.created ?? [];
    try {
      const all = (await http('GET', `${B_URL}/schedules`, { token: admin })).json ?? [];
      assert(all.some((s) => s.enabled && s.scope === 'full') && all.some((s) => s.enabled && s.scope === 'system'), 'full + system schedules enabled');
      const again = await http('POST', `${B_URL}/schedules/recommended`, { token: admin, body: {} });
      assert(again.status === 200 && again.json.alreadyConfigured === true, `second call: ${again.status} ${again.text.slice(0, 200)}`);
      const sys = all.find((s) => s.enabled && s.scope === 'system');
      const run = await http('POST', `${B_URL}/schedules/${sys.id}/run-now`, { token: admin, body: {} });
      assert(run.status === 200, `run-now ${run.status} ${run.text.slice(0, 200)}`);
      const job = await waitJob(admin, run.json.jobId, 'system backup');
      assert(job.status === 'COMPLETED' && job.downloadUrl?.startsWith('system/'), `${job.status}: ${job.errorMsg}`);
      const dl = await http('GET', `${B_URL}/download/${job.id}`, { token: admin, raw: true });
      const head = Buffer.from(await dl.arrayBuffer()).subarray(0, 5).toString('latin1');
      assert(dl.status === 200 && head === 'PGDMP', `dump download ${dl.status} ${head}`);
      systemJobId = job.id;
      return `${created.length} schedule(s) created (before: ${before.length}), dump ${job.downloadUrl}`;
    } finally {
      for (const s of created) await http('DELETE', `${B_URL}/schedules/${s.id}`, { token: admin });
    }
  });

  await check('backup: RBAC — COMPLIANCE_MANAGEMENT may not download the system dump (403), but a mailbox backup', async () => {
    if (!systemJobId) return 'skipped — no system backup job';
    const comp = await roleSession(state, admin, 'compmgmt', 'COMPLIANCE_MANAGEMENT');
    const ok = await http('GET', `${B_URL}/download/${backupJob.id}`, { token: comp, raw: true });
    assert(ok.status === 200, `COMPLIANCE_MANAGEMENT mailbox backup download → ${ok.status} (session must be valid)`);
    const r = await http('GET', `${B_URL}/download/${systemJobId}`, { token: comp, raw: true });
    assert(r.status === 403, `COMPLIANCE_MANAGEMENT system dump download → ${r.status}`);
    return '403';
  });
}
