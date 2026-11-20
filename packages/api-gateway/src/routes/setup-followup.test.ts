/**
 * 10.4.2: the setup wizard's secrets download and finish marker
 * (GET /api/v1/setup/secrets-download, POST /api/v1/setup/finish).
 * Admin session (ORGANIZATION_MANAGEMENT) required; open only while the wizard
 * is not finished and at most 24 h after the setup was completed, otherwise
 * 404; absent file 404; download headers; audit without the content; nothing
 * of the content in the log; the staged copy is removed when the window closes
 * (never the real file); own rate limit.
 * Run: node --import tsx --test --test-force-exit src/routes/setup-followup.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFakePrisma, applySelect, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
let settings: Row = {};
let audits: Row[] = [];
let auditEnabled = true;

installFakePrisma({
  user: {
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      const id = String(q.where['id']);
      return applySelect({ id, email: `${id}@ex.com`, role: id.replace(/^actor-/, ''), active: true }, q.select);
    },
  },
  serverSettings: {
    findUnique: (a) => applySelect({ id: 'singleton', auditLogEnabled: auditEnabled, ...settings }, (a as { select?: Row }).select),
    updateMany: (a) => {
      const q = a as { where: Row; data: Row };
      const w = q.where;
      const completedOk = !('setupCompletedAt' in w) || settings['setupCompletedAt'] instanceof Date;
      const finishedOk = !('setupWizardFinishedAt' in w) || !settings['setupWizardFinishedAt'];
      if (!completedOk || !finishedOk) return { count: 0 };
      settings = { ...settings, ...q.data };
      return { count: 1 };
    },
  },
  adminScope: { findMany: () => [] },
  auditLog: { create: (a) => { audits.push((a as { data: Row }).data); return {}; } },
});

const SECRET_LINE = 'PEPPER=pepper-value-that-must-never-be-logged-0123456789';
const CONTENT = `# secrets 2026-11-20 - generated: JWT_SECRET PEPPER\nJWT_SECRET=jwt-value-abcdefghijklmnopqrstuvwxyz012345\n${SECRET_LINE}\n`;

const root = mkdtempSync(join(tmpdir(), 'cm-setup-dl-'));
const secretsDirPath = join(root, 'secrets');
const stagedDir = join(root, 'staged');
const env: NodeJS.ProcessEnv = { COREMAIL_SECRETS_DIR: secretsDirPath };

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { createSetupFollowUpRouter } = await import('./setup-followup.js');
const { setupFollowUpRateLimit } = await import('../middleware/security.js');
const {
  secretsDownloadWindowOpen, secretsDownloadFilename, secretsDownloadPath, SECRETS_DOWNLOAD_WINDOW_MS,
} = await import('../lib/setup-secrets.js');

const logLines: string[] = [];
const log = {
  info: (o: object, m?: string) => { logLines.push(JSON.stringify([o, m])); },
  warn: (o: object, m?: string) => { logLines.push(JSON.stringify([o, m])); },
};
let clock = new Date('2026-11-20T10:00:00Z');

const token = (role: string) => core.signAccessToken({
  sub: `actor-${role}`, email: `actor-${role}@ex.com`, role: role as never, domainId: 'd1', sessionId: `s-${role}`, mfaVerified: true,
});

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/setup', createSetupFollowUpRouter({ log, env, now: () => clock, rateLimit: (_q, _s, next) => next() }));
  const limited = express.Router();
  limited.get('/probe', setupFollowUpRateLimit, (_q, res) => { res.json({ ok: true }); });
  app.use('/limited', limited);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

function writeSecrets(dir = secretsDirPath, content = CONTENT): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'coremail.env');
  writeFileSync(p, content, { mode: 0o600 });
  return p;
}

beforeEach(() => {
  clock = new Date('2026-11-20T10:00:00Z');
  settings = { setupCompletedAt: new Date('2026-11-20T09:00:00Z'), setupWizardFinishedAt: null, publicHostname: 'mail.example.com' };
  audits = [];
  auditEnabled = true;
  logLines.length = 0;
  delete env['COREMAIL_SECRETS_DOWNLOAD_FILE'];
  rmSync(stagedDir, { recursive: true, force: true });
  writeSecrets();
});

const flush = () => new Promise((r) => setTimeout(r, 20)); // audit() is fire-and-forget

async function download(role?: string) {
  const r = await fetch(`${base}/api/v1/setup/secrets-download`, { headers: role ? { authorization: `Bearer ${token(role)}` } : {} });
  return { status: r.status, headers: r.headers, text: await r.text() };
}
async function finish(role?: string) {
  const r = await fetch(`${base}/api/v1/setup/finish`, { method: 'POST', headers: role ? { authorization: `Bearer ${token(role)}` } : {} });
  return r.status;
}

test('window rule (pure) and file name', () => {
  const done = new Date('2026-11-20T09:00:00Z');
  assert.equal(secretsDownloadWindowOpen({ setupCompletedAt: done }, new Date('2026-11-20T09:00:01Z')), true);
  assert.equal(secretsDownloadWindowOpen({ setupCompletedAt: done }, new Date(done.getTime() + SECRETS_DOWNLOAD_WINDOW_MS)), true, 'exactly 24 h');
  assert.equal(secretsDownloadWindowOpen({ setupCompletedAt: done }, new Date(done.getTime() + SECRETS_DOWNLOAD_WINDOW_MS + 1)), false);
  assert.equal(secretsDownloadWindowOpen({ setupCompletedAt: done, setupWizardFinishedAt: done }, done), false, 'wizard finished');
  assert.equal(secretsDownloadWindowOpen({ setupCompletedAt: null }), false, 'setup not completed');
  assert.equal(secretsDownloadWindowOpen(null), false);
  assert.equal(secretsDownloadFilename('Mail.Example.com', done), 'coremail-secrets-mail.example.com-2026-11-20.env');
  assert.equal(secretsDownloadFilename('"evil";\r\nx', done), 'coremail-secrets-evil-x-2026-11-20.env', 'header-safe');
  assert.equal(secretsDownloadFilename(null, done), 'coremail-secrets-server-2026-11-20.env');
  // the real secrets file is never treated as a disposable copy
  assert.equal(secretsDownloadPath({ COREMAIL_SECRETS_DIR: '/secrets', COREMAIL_SECRETS_DOWNLOAD_FILE: '/secrets/coremail.env' }), join('/secrets', 'coremail.env'));
  assert.equal(secretsDownloadPath({ COREMAIL_SECRETS_DIR: '/secrets', COREMAIL_SECRETS_DOWNLOAD_FILE: 'relative/x.env' }), join('/secrets', 'coremail.env'));
});

test('authentication: anonymous 401, other roles 403 (download and finish)', async () => {
  assert.equal((await download()).status, 401);
  assert.equal(await finish(), 401);
  for (const role of ['USER', 'HELP_DESK', 'SERVER_MANAGEMENT', 'VIEW_ONLY_ORG']) {
    assert.equal((await download(role)).status, 403, role);
    assert.equal(await finish(role), 403, role);
  }
  assert.equal(settings['setupWizardFinishedAt'], null, 'nothing written');
});

test('10.5: with requireMfaForAdmins on (fresh installations) the wizard session without MFA still downloads and finishes', async () => {
  settings = { ...settings, requireMfaForAdmins: true };
  const noMfa = core.signAccessToken({
    sub: 'actor-ORGANIZATION_MANAGEMENT', email: 'actor-ORGANIZATION_MANAGEMENT@ex.com', role: 'ORGANIZATION_MANAGEMENT' as never,
    domainId: 'd1', sessionId: 's-wizard', mfaVerified: false,
  });
  const r = await fetch(`${base}/api/v1/setup/secrets-download`, { headers: { authorization: `Bearer ${noMfa}` } });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(await r.text(), CONTENT);
  const f = await fetch(`${base}/api/v1/setup/finish`, { method: 'POST', headers: { authorization: `Bearer ${noMfa}` } });
  assert.equal(f.status, 204);
  assert.ok(settings['setupWizardFinishedAt'] instanceof Date);
  const after = await fetch(`${base}/api/v1/setup/secrets-download`, { headers: { authorization: `Bearer ${noMfa}` } });
  assert.equal(after.status, 404, 'closed again after the wizard finished');
});

test('download inside the window: the file, attachment headers, audit without content, nothing in the log', async () => {
  const r = await download('ORGANIZATION_MANAGEMENT');
  assert.equal(r.status, 200);
  assert.equal(r.text, CONTENT, 'byte-identical');
  assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="coremail-secrets-mail.example.com-2026-11-20.env"');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  await flush();
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!['action'], 'setup.secrets.download');
  assert.equal(audits[0]!['success'], true);
  assert.equal(audits[0]!['actorId'], 'actor-ORGANIZATION_MANAGEMENT');
  const recorded = JSON.stringify(audits) + logLines.join('\n');
  for (const secret of ['pepper-value-that-must-never-be-logged', 'jwt-value-abcdefghij']) {
    assert.ok(!recorded.includes(secret), `${secret} leaked into audit/log`);
  }
  assert.ok(logLines.some((l) => l.includes('downloaded')), 'the download itself is logged');
});

test('the download is always audited, even with the audit log switched off', async () => {
  auditEnabled = false;
  assert.equal((await download('ORGANIZATION_MANAGEMENT')).status, 200);
  await flush();
  assert.equal(audits.length, 1);
});

test('more than 24 h after the setup → 404, refused attempt audited', async () => {
  clock = new Date('2026-11-21T09:00:01Z');
  const r = await download('ORGANIZATION_MANAGEMENT');
  assert.equal(r.status, 404);
  assert.ok(!r.text.includes('PEPPER'));
  await flush();
  assert.equal(audits[0]!['success'], false);
  assert.equal(audits[0]!['action'], 'setup.secrets.download');
});

test('setup not completed → 404', async () => {
  settings = { setupCompletedAt: null };
  assert.equal((await download('ORGANIZATION_MANAGEMENT')).status, 404);
});

test('after "finish" → 404; finish is idempotent and keeps the first time', async () => {
  assert.equal((await download('ORGANIZATION_MANAGEMENT')).status, 200);
  assert.equal(await finish('ORGANIZATION_MANAGEMENT'), 204);
  const first = settings['setupWizardFinishedAt'];
  assert.ok(first instanceof Date);
  clock = new Date('2026-11-20T11:00:00Z');
  assert.equal(await finish('ORGANIZATION_MANAGEMENT'), 204);
  assert.equal(settings['setupWizardFinishedAt'], first);
  assert.equal((await download('ORGANIZATION_MANAGEMENT')).status, 404);
});

test('absent file → 404 (also a symlink, never followed)', async () => {
  rmSync(join(secretsDirPath, 'coremail.env'));
  assert.equal((await download('ORGANIZATION_MANAGEMENT')).status, 404);
  const target = join(root, 'elsewhere.env');
  writeFileSync(target, CONTENT);
  let linked = false;
  try { symlinkSync(target, join(secretsDirPath, 'coremail.env')); linked = true; } catch { /* no symlink rights (Windows) */ }
  if (linked) assert.equal((await download('ORGANIZATION_MANAGEMENT')).status, 404);
});

test('staged copy: served instead of the real file, removed on finish and outside the window; the real file stays', async () => {
  const staged = writeSecrets(stagedDir, CONTENT.replace('PEPPER', 'PEPPER_STAGED'));
  env['COREMAIL_SECRETS_DOWNLOAD_FILE'] = staged;
  const r = await download('ORGANIZATION_MANAGEMENT');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('PEPPER_STAGED'), 'the staged copy is served');
  assert.equal(await finish('ORGANIZATION_MANAGEMENT'), 204);
  assert.equal(existsSync(staged), false, 'copy removed on finish');
  assert.equal(existsSync(join(secretsDirPath, 'coremail.env')), true, 'real file kept');

  // a copy left over (restart) is removed by a request outside the window
  settings = { setupCompletedAt: new Date('2026-11-18T09:00:00Z'), setupWizardFinishedAt: null };
  writeSecrets(stagedDir);
  assert.equal((await download('ORGANIZATION_MANAGEMENT')).status, 404);
  assert.equal(existsSync(staged), false);
  assert.equal(existsSync(join(secretsDirPath, 'coremail.env')), true);
});

test('own rate limit: 10 requests per hour, then 429', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await fetch(`${base}/limited/probe`)).status, 200, `request ${i + 1}`);
  assert.equal((await fetch(`${base}/limited/probe`)).status, 429);
});
