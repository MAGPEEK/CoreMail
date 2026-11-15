// Step 13: `docker compose restart coremail` — services come back, data persists.
// Run with: node scripts/e2e/run.mjs restart   (needs E2E_ENV_FILE / E2E_COMPOSE_PROJECT like docs/e2e.md)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { check, assert, creds, http, session, waitFor, dockerExec, imapCmd, BASE, STATE_DIR } from '../lib.mjs';
import { imapLogin } from './imap.mjs';
import { join } from 'node:path';

export async function run(state) {
  const c = creds();
  const project = process.env.E2E_COMPOSE_PROJECT ?? 'coremail-e2e';
  const envFile = process.env.E2E_ENV_FILE ?? join(STATE_DIR, 'e2e.env');
  await check('restart: docker compose restart coremail → healthy again', async () => {
    const t0 = Date.now();
    execFileSync('docker', ['compose', '-p', project, '--env-file', envFile, '-f', 'infra/docker/docker-compose.yml', '-f', 'infra/docker/docker-compose.e2e.yml', 'restart', 'coremail'], { stdio: 'inherit' });
    await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, { timeout: 180000, interval: 2000, what: 'healthz' });
    await waitFor(async () => {
      const out = dockerExec(['supervisorctl', '-c', '/etc/supervisord.conf', 'status']);
      return out.trim().split('\n').every((l) => /\sRUNNING\s/.test(l)) ? out : null;
    }, { timeout: 60000, what: 'all programs RUNNING' });
    return `healthy after ${Math.round((Date.now() - t0) / 1000)} s, all programs RUNNING`;
  });
  delete state.sessions;
  await check('restart: users, sessions and messages persist (raw bytes unchanged)', async () => {
    const tok = await session(state, 'b', state.users.b.email, c.userB);
    assert(tok, 'login failed');
    const im = await waitFor(async () => { const s = await imapLogin(state.users.b.email, c.userB); return s.loginResult.status === 'OK' ? s : (s.close(), null); }, { timeout: 60000, what: 'IMAP login' });
    try {
      await imapCmd(im, 'EXAMINE Archive');
      const f = await imapCmd(im, `UID FETCH ${state.archiveUid} (BODY.PEEK[])`);
      const sha = createHash('sha256').update(f.literals[0]).digest('hex');
      assert(sha === state.imapRawSha256, 'raw message changed after restart');
    } finally { im.close(); }
    const att = await http('GET', `/api/v1/mail/attachments/${state.attachmentId}`, { token: tok, raw: true });
    const body = Buffer.from(await att.arrayBuffer());
    assert(att.status === 200 && createHash('sha256').update(body).digest('hex') === state.a2b.attSha256, `attachment after restart ${att.status}`);
    return 'login OK, Archive message byte-identical, attachment (MinIO) intact';
  });
  await check('restart: app password + TOTP state survive', async () => {
    if (!state.appPwA) return 'skipped (mfa step not run)';
    const im = await imapLogin(state.users.a.email, state.appPwA);
    const ok = im.loginResult.status === 'OK'; im.close();
    const l = await http('POST', '/auth/login', { body: { email: state.users.a.email, password: c.userA } });
    assert(ok && l.json?.mfaRequired, `app pw IMAP ${ok}, mfaRequired ${l.json?.mfaRequired}`);
    return 'app password IMAP OK, web login still mfaRequired';
  });
}
