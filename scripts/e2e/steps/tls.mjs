// Step 10b (9.3): protocol TLS — assigning SMTP/IMAP/POP3 IS the switch.
//  - upload a CA-signed certificate for mail.<E2E_DOMAIN> (CA + leaf generated with openssl
//    inside the app container) WITHOUT services → nothing changes on the mail ports;
//  - assign the mail services via PUT only (no activate-protocol call) → 993 / 465 (implicit
//    TLS), 143 / 587 (STARTTLS), 995 (TLS) and 110 (STLS) serve exactly that certificate
//    (SHA-256 fingerprint) incl. the intermediate; GET /certificates/served agrees;
//  - remove the services → every port falls back to the self-signed default for the public
//    host name (CN = mail.<E2E_DOMAIN>, not mail.localhost);
//  - cleanup: the uploaded certificate is deleted.
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { check, assert, creds, http, session, waitFor, dockerExec, LineClient, smtpRead, smtpCmd, HOST, PORTS, DOMAIN } from '../lib.mjs';

const HOSTNAME = `mail.${DOMAIN}`;

/** CA + leaf for HOSTNAME, generated inside the app container (openssl is part of the image). */
function makeCaSignedCert() {
  const script = [
    'set -e', 'd=$(mktemp -d)', 'cd "$d"',
    'openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 2 -subj "/CN=CoreMail e2e CA" >/dev/null 2>&1',
    `openssl req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr -subj "/CN=${HOSTNAME}" >/dev/null 2>&1`,
    `printf "subjectAltName=DNS:${HOSTNAME}\\nbasicConstraints=CA:FALSE\\nextendedKeyUsage=serverAuth\\n" > ext.cnf`,
    'openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out leaf.pem -days 2 -extfile ext.cnf >/dev/null 2>&1',
    'cat leaf.pem; echo "#KEY#"; cat leaf.key; echo "#CA#"; cat ca.pem', 'rm -rf "$d"',
  ].join('; ');
  const out = dockerExec(['sh', '-c', script]);
  const [leaf, rest] = out.split('#KEY#');
  const [key, ca] = rest.split('#CA#');
  return { certPem: leaf.trim() + '\n', keyPem: key.trim() + '\n', chainPem: ca.trim() + '\n' };
}

/** Peer certificate (detailed, with issuer chain) of one mail port. */
async function peerOf(kind) {
  const servername = HOSTNAME;
  const implicit = async (port) => new Promise((resolve, reject) => {
    const s = tls.connect({ host: HOST, port, servername, rejectUnauthorized: false }, () => { const c = s.getPeerCertificate(true); s.end(); resolve(c); });
    s.once('error', reject);
    s.setTimeout(10_000, () => { s.destroy(); reject(new Error(`timeout ${port}`)); });
  });
  const viaClient = async (c) => { const t = await c.startTls(); const cert = t.getPeerCertificate(true); c.close(); return cert; };
  switch (kind) {
    case 'imaps': return implicit(PORTS.imaps);
    case 'smtps': return implicit(PORTS.smtps);
    case 'pop3s': return implicit(PORTS.pop3s);
    case 'imap': {
      const c = await LineClient.connect(PORTS.imap);
      await c.readLine();
      c.write('t1 STARTTLS\r\n');
      const l = await c.readLine();
      assert(/^t1 OK/i.test(l), `IMAP STARTTLS: ${l}`);
      return viaClient(c);
    }
    case 'submission': {
      const c = await LineClient.connect(PORTS.submission);
      await smtpRead(c);
      await smtpCmd(c, 'EHLO e2e-tls.test');
      const r = await smtpCmd(c, 'STARTTLS');
      assert(r.code === 220, `SMTP STARTTLS: ${r.text}`);
      return viaClient(c);
    }
    case 'pop3': {
      const c = await LineClient.connect(PORTS.pop3);
      await c.readLine();
      c.write('STLS\r\n');
      const l = await c.readLine();
      assert(l.startsWith('+OK'), `POP3 STLS: ${l}`);
      return viaClient(c);
    }
    default: throw new Error(kind);
  }
}

const KINDS = ['imaps', 'smtps', 'imap', 'submission', 'pop3s', 'pop3'];
const fpOf = (peer) => new X509Certificate(peer.raw).fingerprint256;

/** Waits until every port serves a certificate for which `pred(peer)` holds; returns the fingerprints. */
async function waitAllPorts(pred, what) {
  return waitFor(async () => {
    const out = {};
    for (const k of KINDS) {
      const peer = await peerOf(k);
      if (!pred(peer)) throw new Error(`${k} serves CN=${peer.subject?.CN} (${fpOf(peer).slice(0, 23)}…)`);
      out[k] = fpOf(peer);
    }
    return out;
  }, { timeout: 30_000, interval: 1_000, what });
}

export async function run(state) {
  const c = creds();
  const admin = await session(state, 'admin', state.adminEmail, c.admin);
  let material;
  let certId;
  let leafFp;

  await check('tls: CA-signed certificate for the public host name uploaded without services — ports unchanged', async () => {
    material = makeCaSignedCert();
    leafFp = new X509Certificate(material.certPem).fingerprint256;
    const r = await http('POST', '/api/v1/admin/certificates/upload', { token: admin, body: {
      name: 'e2e-tls', domains: [HOSTNAME], services: [], ...material,
    } });
    assert(r.status === 201, `${r.status} ${r.text.slice(0, 300)}`);
    certId = r.json.id;
    state.tlsCertId = certId;
    const peer = await peerOf('imaps');
    assert(fpOf(peer) !== leafFp, '993 switched although no service was assigned');
    return `${certId} fp ${leafFp.slice(0, 23)}…`;
  });
  if (!certId) return;

  await check('tls: PUT services SMTP/IMAP/POP3 only → 993/465/143/587/995/110 serve exactly that certificate (+ chain)', async () => {
    const r = await http('PUT', `/api/v1/admin/certificates/${certId}`, { token: admin, body: { services: ['SMTP', 'IMAP', 'POP3'] } });
    assert(r.status === 200, `${r.status} ${r.text.slice(0, 300)}`);
    assert(r.json.protocolApplied === true && r.json.isActiveProtocol === true, `not applied: ${r.text.slice(0, 300)}`);
    await waitAllPorts((p) => fpOf(p) === leafFp, 'uploaded certificate on every mail port');
    const chained = await peerOf('submission');
    assert(chained.issuerCertificate?.subject?.CN === 'CoreMail e2e CA', `587 sends no intermediate (issuer ${chained.issuerCertificate?.subject?.CN})`);
    return KINDS.join(', ');
  });

  await check('tls: GET /certificates/served reports the uploaded certificate on every mail port', async () => {
    const r = await http('GET', '/api/v1/admin/certificates/served', { token: admin });
    assert(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    const ports = r.json.ports ?? [];
    const tlsPorts = ports.filter((p) => p.ok);
    assert(tlsPorts.length >= 6, `only ${tlsPorts.length} ports probed: ${JSON.stringify(ports.map((p) => [p.port, p.error]))}`);
    const wrong = tlsPorts.filter((p) => p.certId !== certId || p.problem);
    assert(wrong.length === 0, `mismatch: ${JSON.stringify(wrong.map((p) => [p.port, p.certId, p.problem]))}`);
    return `${tlsPorts.length} ports, problem=${r.json.problem}`;
  });

  await check('tls: private keys are stored encrypted (enc:v1) and never returned by the API', async () => {
    const pg = process.env.E2E_PG_CONTAINER ?? 'coremail-e2e-postgres';
    const sql = `SELECT count(*) FILTER (WHERE "keyPem" NOT LIKE 'enc:v1:%' OR "acmeAccount" NOT LIKE 'enc:v1:%'), count(*)`
      + ` FROM certificates WHERE "keyPem" IS NOT NULL OR "acmeAccount" IS NOT NULL;`
      + ` SELECT coalesce("tlsKey" LIKE 'enc:v1:%', true) FROM server_settings WHERE id = 'singleton';`;
    const out = execFileSync('docker', ['exec', pg, 'sh', '-c', `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAq -c "${sql.replace(/"/g, '\\"')}"`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n');
    const [plain, total] = out[0].split('|').map(Number);
    assert(total > 0 && plain === 0, `certificates with a plain private key: ${plain} of ${total}`);
    assert(out[1] === 't', `server_settings.tlsKey not encrypted (${out[1]})`);
    const list = await http('GET', '/api/v1/admin/certificates', { token: admin });
    const one = await http('GET', `/api/v1/admin/certificates/${certId}`, { token: admin });
    assert(!/keyPem|PRIVATE KEY|enc:v1:/.test(list.text + one.text), 'private key material in an API response');
    return `${total} keys encrypted, tlsKey encrypted, none in responses`;
  });

  await check('tls: removing the services falls back to the self-signed default for the host name on every port', async () => {
    const r = await http('PUT', `/api/v1/admin/certificates/${certId}`, { token: admin, body: { services: [] } });
    assert(r.status === 200, `${r.status} ${r.text.slice(0, 300)}`);
    const fps = await waitAllPorts((p) => fpOf(p) !== leafFp && p.subject?.CN === p.issuer?.CN && p.subject?.CN === HOSTNAME,
      'self-signed default on every mail port');
    assert(new Set(Object.values(fps)).size === 1, `ports serve different self-signed certs: ${JSON.stringify(fps)}`);
    const list = (await http('GET', '/api/v1/admin/certificates', { token: admin })).json ?? [];
    const active = list.filter((x) => x.isActiveProtocol);
    assert(active.length === 1 && active[0].type === 'SELF_SIGNED' && active[0].domains.includes(HOSTNAME),
      `protocol cert: ${JSON.stringify(active.map((x) => [x.name, x.type, x.services]))}`);
    assert(['SMTP', 'IMAP', 'POP3'].every((s) => active[0].services.includes(s)), `services ${active[0].services}`);
    return `${active[0].name} (${Object.values(fps)[0].slice(0, 23)}…)`;
  });

  await check('tls: staging certificates cannot get the mail services (409)', async () => {
    const r = await http('PUT', `/api/v1/admin/certificates/${certId}`, { token: admin, body: { acmeStaging: true } });
    // the uploaded cert is CUSTOM → staging is a Let's Encrypt-only setting (400)
    assert(r.status === 400, `${r.status} ${r.text.slice(0, 200)}`);
    return 'CUSTOM: 400';
  });

  await check('tls: cleanup — uploaded certificate deleted', async () => {
    const r = await http('DELETE', `/api/v1/admin/certificates/${certId}`, { token: admin });
    assert(r.status === 204, `${r.status} ${r.text.slice(0, 200)}`);
    delete state.tlsCertId;
    return 'deleted';
  });
}
