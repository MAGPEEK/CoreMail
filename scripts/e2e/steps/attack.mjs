// Step (10.6): attack protection core path — BCP → Schutz → Angriffsschutz
// (docs/attack-protection.md). IMAP brute force on a fresh account → the account
// lock is listed (protocol, remaining time) and the events show up per protocol →
// "Entsperren" → the correct password works again; a block list entry for a
// helper container on the stack network → refused on IMAPS and HTTP (403
// IP_BLOCKED) and recorded → entry removed → admitted again.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { check, assert, http as http0, session, creds, DOMAIN, CONTAINER, sleep, waitFor } from '../lib.mjs';
import { imapLogin } from './imap.mjs';

/** One retry on a dropped keep-alive connection (the gateway closes idle sockets after 5 s). */
async function http(...args) {
  try { return await http0(...args); } catch { await sleep(300); return http0(...args); }
}

const IMAGE = process.env.E2E_IMAGE ?? 'coremail-app:e2e';
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The app container's network that is not the rspamd /29 (the compose network "coremail"). */
function stackNetwork() {
  const nets = JSON.parse(docker(['inspect', '-f', '{{json .NetworkSettings.Networks}}', CONTAINER]));
  const name = Object.keys(nets).find((n) => n.endsWith('_coremail')) ?? Object.keys(nets)[0];
  return { name, appIp: nets[name].IPAddress };
}

/** Runs a probe inside the helper container: IMAPS greeting + an HTTP request (as JSON). */
function probe(helper, appIp) {
  const js = `
const tls = require('node:tls');
const out = {};
const s = tls.connect({ host: '${appIp}', port: 993, rejectUnauthorized: false });
let got = '';
const done = (k) => { if (out.imap === undefined) { out.imap = k; s.destroy(); next(); } };
s.on('data', (d) => { got += d; if (got.includes('\\n')) done(got.split('\\n')[0].trim()); });
s.on('error', (e) => done('error ' + (e.code || e.message)));
s.on('close', () => done(got ? got.trim() : 'closed'));
s.setTimeout(8000, () => done('timeout'));
async function next() {
  try { const r = await fetch('http://${appIp}:3000/api/v1/setup/status'); out.http = r.status + ' ' + (await r.text()).slice(0, 120); }
  catch (e) { out.http = 'error ' + (e.cause?.code || e.message); }
  console.log(JSON.stringify(out));
}`;
  return JSON.parse(docker(['exec', helper, 'node', '-e', js]).split('\n').at(-1));
}

export async function run(state) {
  const c = creds();
  const admin = await session(state, 'admin', state.adminEmail, c.admin);
  const email = `attack-${randomBytes(3).toString('hex')}@${DOMAIN}`;
  const password = `Atk-${randomBytes(10).toString('hex')}`;
  let userId = null;

  await check('attack: test account created', async () => {
    const r = await http('POST', '/api/v1/admin/mailboxes', { token: admin, body: { email, displayName: 'Attack E2E', password, role: 'USER', domainId: state.domainId } });
    assert(r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
    userId = r.json.id;
    return email;
  });
  if (!userId) return;

  let lock;
  try {
    await check('attack: IMAP brute force locks the account (11th attempt refused as locked)', async () => {
      const texts = [];
      for (let i = 0; i < 11; i++) {
        const s = await imapLogin(email, `wrong-${i}-password`, { implicitTls: true });
        texts.push(s.loginResult.text.replace(/^T\d+ /, ''));
        s.close();
      }
      assert(texts.slice(0, 10).every((t) => /^NO .*AUTHENTICATIONFAILED/.test(t)), `failures: ${texts.slice(0, 10).join(' | ')}`);
      assert(/^NO /.test(texts[10]) && !/AUTHENTICATIONFAILED/.test(texts[10]), `11th attempt: ${texts[10]}`);
      const ok = await imapLogin(email, password, { implicitTls: true });
      const okText = ok.loginResult.text;
      ok.close();
      assert(ok.loginResult.status !== 'OK', `correct password accepted while locked: ${okText}`);
      return `11th: ${texts[10]}; correct password while locked: ${okText.replace(/^T\d+ /, '')}`;
    });

    await check('attack: the lock is listed in BCP → Angriffsschutz (protocol IMAP, remaining time)', async () => {
      const r = await http('GET', '/api/v1/admin/security/protection/locks', { token: admin });
      assert(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
      lock = r.json.accounts.find((l) => l.account === email);
      assert(lock, `no account lock for ${email}: ${JSON.stringify(r.json.accounts.map((l) => l.account))}`);
      assert(lock.protocol === 'imap', `protocol ${lock.protocol}`);
      assert(lock.remainingSec > 0 && lock.remainingSec <= 3600, `remaining ${lock.remainingSec}`);
      assert(lock.failures === 10 && lock.strikes >= 1, `failures ${lock.failures} strikes ${lock.strikes}`);
      return `account lock: ${lock.remainingSec} s left, level ${lock.strikes}, ${lock.failures} failures`;
    });

    await check('attack: the events show up per protocol (summary IMAP, AUTH_LOCKOUT for the account)', async () => {
      const s = await http('GET', '/api/v1/admin/security/attacks/summary', { token: admin });
      assert(s.status === 200, `${s.status}`);
      const imap = s.json.byProtocol.find((p) => p.protocol === 'imap');
      assert(imap && imap.count > 0, `byProtocol ${JSON.stringify(s.json.byProtocol)}`);
      const ev = await http('GET', '/api/v1/admin/security/attacks?type=AUTH_LOCKOUT&limit=50', { token: admin });
      const mine = ev.json.events.find((e) => e.target === email && e.protocol === 'imap');
      assert(mine, `no AUTH_LOCKOUT event for ${email}`);
      return `IMAP ${imap.count} events (24 h), lock event at ${mine.timestamp}`;
    });

    await check('attack: "Entsperren" lifts the lock → the correct password works again', async () => {
      const r = await http('POST', '/api/v1/admin/security/protection/locks/release', { token: admin, body: { scope: 'account', id: lock.id, resetStrikes: true } });
      assert(r.status === 200 && r.json.released === true, `${r.status} ${r.text.slice(0, 200)}`);
      const l = await http('GET', '/api/v1/admin/security/protection/locks', { token: admin });
      assert(!l.json.accounts.some((x) => x.account === email), 'still listed after the release');
      const ok = await imapLogin(email, password, { implicitTls: true });
      const t = ok.loginResult;
      ok.close();
      assert(t.status === 'OK', t.text);
      return 'released, LOGIN OK';
    });
  } finally {
    // the runner's own address collected failures: forget them (the account is deleted below)
    const rules = await http('GET', '/api/v1/admin/security/protection/rules', { token: admin }).catch(() => null);
    if (rules?.json?.callerIp) await http('POST', '/api/v1/admin/security/protection/locks/release', { token: admin, body: { scope: 'ip', id: rules.json.callerIp, resetStrikes: true } }).catch(() => undefined);
    await http('DELETE', `/api/v1/admin/mailboxes/${userId}`, { token: admin }).catch(() => undefined);
  }

  // ── Block list: a helper container on the stack network is the client ─────
  const helper = `coremail-e2e-attacker-${randomBytes(3).toString('hex')}`;
  let ruleId = null;
  try {
    const { name: network, appIp } = stackNetwork();
    docker(['run', '-d', '--rm', '--name', helper, '--network', network, '--entrypoint', 'sh', IMAGE, '-c', 'sleep 600']);
    const helperIp = JSON.parse(docker(['inspect', '-f', '{{json .NetworkSettings.Networks}}', helper]))[network].IPAddress;

    await check('attack: helper client is admitted before the block list entry', async () => {
      const p = probe(helper, appIp);
      assert(/^\* OK/.test(p.imap), `IMAPS: ${p.imap}`);
      assert(/^200 /.test(p.http), `HTTP: ${p.http}`);
      return `${helperIp}: IMAPS greeting, HTTP 200`;
    });

    await check('attack: block list entry → IMAPS and HTTP refused (403 IP_BLOCKED), refusal recorded', async () => {
      const r = await http('POST', '/api/v1/admin/security/protection/rules', { token: admin, body: { kind: 'BLOCK', cidr: helperIp, note: 'e2e attack step' } });
      assert(r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
      ruleId = r.json.id;
      const p = await waitFor(async () => { const x = probe(helper, appIp); return /^403 /.test(x.http) && !/^\* OK/.test(x.imap) ? x : null; }, { timeout: 15000, interval: 1000, what: 'block list applied' });
      assert(/IP_BLOCKED/.test(p.http), `HTTP: ${p.http}`);
      const ev = await waitFor(async () => {
        const e = await http('GET', `/api/v1/admin/security/attacks?type=IP_BLOCKLIST&ip=${encodeURIComponent(helperIp)}&limit=20`, { token: admin });
        return e.json?.events?.length ? e.json.events : null;
      }, { timeout: 10000, what: 'IP_BLOCKLIST event' });
      return `IMAPS: ${p.imap}; HTTP: ${p.http.slice(0, 60)}; events: ${[...new Set(ev.map((e) => e.protocol))].join(',')}`;
    });

    await check('attack: entry removed → the helper client is admitted again', async () => {
      const d = await http('DELETE', `/api/v1/admin/security/protection/rules/${ruleId}`, { token: admin });
      assert(d.status === 204, `${d.status} ${d.text.slice(0, 200)}`);
      ruleId = null;
      const p = await waitFor(async () => { const x = probe(helper, appIp); return /^\* OK/.test(x.imap) && /^200 /.test(x.http) ? x : null; }, { timeout: 15000, interval: 1000, what: 'block list entry removed' });
      return `IMAPS greeting, HTTP ${p.http.slice(0, 3)}`;
    });
  } finally {
    if (ruleId) await http('DELETE', `/api/v1/admin/security/protection/rules/${ruleId}`, { token: admin }).catch(() => undefined);
    try { docker(['rm', '-f', helper]); } catch { /* not started */ }
  }
}
