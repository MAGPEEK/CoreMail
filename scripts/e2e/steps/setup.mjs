// Step 1: setup wizard via API (setup token from /secrets/setup-token, else the
// container log), smarthost → sink.
import { execFileSync } from 'node:child_process';
import { check, assert, http, creds, DOMAIN, CONTAINER, session, dockerExec } from '../lib.mjs';

export async function run(state) {
  const c = creds();
  state.adminEmail = `admin@${DOMAIN}`;

  await check('runtime: supervisord programs RUNNING', async () => {
    const out = dockerExec(['supervisorctl', '-c', '/etc/supervisord.conf', 'status']);
    const lines = out.trim().split('\n');
    const bad = lines.filter((l) => !/\sRUNNING\s/.test(l));
    assert(bad.length === 0, `not running: ${bad.join('; ')}`);
    return `${lines.length} programs RUNNING`;
  });

  const status = await http('GET', '/api/v1/setup/status');
  if (status.json?.setupRequired === false) {
    console.log('setup already completed earlier — skipping setup checks');
  } else {
    await check('setup: status reports setupRequired + token required', async () => {
      assert(status.json?.setupRequired === true && status.json?.setupTokenRequired === true, JSON.stringify(status.json));
    });
    const body = { domain: DOMAIN, email: state.adminEmail, password: c.admin };
    await check('setup: rejected without token (403)', async () => {
      const r = await http('POST', '/api/v1/setup/complete', { body, retry429: false });
      assert(r.status === 403, `got ${r.status} ${r.text}`);
      return `403 ${r.json?.code}`;
    });
    await check('setup: rejected with wrong token (403)', async () => {
      const r = await http('POST', '/api/v1/setup/complete', { body: { ...body, setupToken: 'x'.repeat(32) }, retry429: false });
      assert(r.status === 403, `got ${r.status} ${r.text}`);
      return `403 ${r.json?.code}`;
    });
    // 10.4: with the secrets directory mounted (Compose files) the token is in
    // /secrets/setup-token and the log only names the file; without it the
    // token is logged as before.
    let token = null;
    let source = 'log';
    try {
      const fromFile = dockerExec(['cat', '/secrets/setup-token']).trim();
      if (/^[A-Za-z0-9_-]{16,}$/.test(fromFile)) { token = fromFile; source = '/secrets/setup-token'; }
    } catch { /* no secrets directory / no file → log */ }
    const logs = execFileSync('docker', ['logs', CONTAINER], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!token) token = [...logs.matchAll(/"setupToken":"([A-Za-z0-9_-]+)"/g)].map((m) => m[1]).at(-1) ?? null;
    await check(`setup: token available (${source})`, async () => { assert(token, 'no setup token in /secrets/setup-token or the log'); return source; });
    if (source !== 'log') {
      await check('setup: token file in use → the log names the file, never the token', async () => {
        assert(!logs.includes(token), 'the token is in the container log');
        assert(/token in \S*setup-token/.test(logs), 'no hint to the token file in the log');
        return 'ok';
      });
    }
    await check(`setup: completes with token from ${source}`, async () => {
      const r = await http('POST', '/api/v1/setup/complete', { body: { ...body, setupToken: token }, retry429: false });
      assert(r.status === 200 || r.status === 201, `got ${r.status} ${r.text}`);
      return `${r.status}`;
    });
  }
  await check('setup: cannot be repeated (409)', async () => {
    const r = await http('POST', '/api/v1/setup/complete', { body: { domain: DOMAIN, email: `x@${DOMAIN}`, password: 'whatever-12345' }, retry429: false });
    assert(r.status === 409 || r.status === 403, `got ${r.status} ${r.text}`);
    const st = await http('GET', '/api/v1/setup/status');
    assert(st.json?.setupRequired === false, 'status still says setupRequired');
    return `${r.status}, status.setupRequired=false`;
  });

  const tok = await session(state, 'admin', state.adminEmail, c.admin);
  const doms = await http('GET', '/api/v1/admin/domains', { token: tok });
  state.domainId = doms.json?.domains?.find((d) => d.name === DOMAIN)?.id;

  // Outbound mail only to the local sink container — never to the internet.
  await check('setup: smarthost → local sink', async () => {
    const r = await http('PUT', '/api/v1/admin/smtp-config/settings', {
      token: tok,
      body: { outboundMode: 'smarthost', smarthostHost: 'sink', smarthostPort: 2525, smarthostTls: false, smarthostImplicitTls: false },
    });
    assert(r.status === 200 && r.json?.outboundMode === 'smarthost', `${r.status} ${r.text.slice(0, 200)}`);
    return 'outboundMode=smarthost sink:2525';
  });
}
