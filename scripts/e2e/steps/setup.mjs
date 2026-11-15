// Step 1: setup wizard via API (setup token from the container log), smarthost → sink.
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
    const logs = execFileSync('docker', ['logs', CONTAINER], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const tokens = [...logs.matchAll(/"setupToken":"([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
    const token = tokens.at(-1);
    await check('setup: token printed in container log', async () => { assert(token, 'no setup token in log'); return 'found'; });
    await check('setup: completes with log token', async () => {
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
