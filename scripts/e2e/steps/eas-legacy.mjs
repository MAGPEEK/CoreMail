// Step 8c: older ActiveSync devices — an EAS 12.1 flow (Provision → FolderSync → Sync →
// SendMail in the 12.1 query-string form with a raw MIME body, plus a base64-encoded request
// line) and an EAS 14.0 flow. Every WBXML response is checked to carry only tags the
// negotiated version defines (tagsNewerThan, [MS-ASWBXML]). Runs after `eas` (needs the users
// and the mail already delivered to user B).
import { check, assert, creds, http, basic, session, waitFor } from '../lib.mjs';
import { decodeWbxml, tagsNewerThan } from '../../../packages/activesync/src/wbxml.ts';

/** Node: [page, token, children | text | undefined] — encoded like a device does. */
function encode(root) {
  const out = [0x03, 0x01, 0x6a, 0x00];
  let page = -1;
  const walk = ([p, t, kids]) => {
    if (p !== page) { out.push(0x00, p); page = p; }
    out.push(t | (kids !== undefined ? 0x40 : 0));
    if (kids === undefined) return;
    if (typeof kids === 'string') out.push(0x03, ...Buffer.from(kids, 'utf8'), 0x00); else kids.forEach(walk);
    out.push(0x01);
  };
  walk(root);
  return Buffer.from(out);
}
const kid = (e, name) => e?.children?.find((c) => typeof c !== 'string' && c.name === name);
const all = (e, name) => (e?.children ?? []).filter((c) => typeof c !== 'string' && c.name === name);
const findTag = (e, pred) => (pred(e) ? e : (e.children ?? []).map((c) => (typeof c === 'string' ? null : findTag(c, pred))).find(Boolean));

const PV = (t, k) => [14, t, k];
const provisionReq = (key) => PV(0x05, [PV(0x06, [PV(0x07, [PV(0x08, 'MS-EAS-Provisioning-WBXML'), ...(key ? [PV(0x09, key), PV(0x0b, '1')] : [])])])]);
const A = (t, k) => [0, t, k];
const syncReq = (inbox, key, extra = []) => A(0x05, [A(0x1c, [A(0x0f, [A(0x10, 'Email'), A(0x0b, key), A(0x12, inbox), ...extra])])]);

/** An EAS device of one protocol version (plain request line, version header). */
function device(state, version, deviceId) {
  const c = creds();
  const B = state.users.b.email;
  const auth = basic(B, c.userB);
  const dev = { version, deviceId, policyKey: undefined, B, auth };
  dev.url = (cmd, params = '') => `/Microsoft-Server-ActiveSync?Cmd=${cmd}&User=${encodeURIComponent(B)}&DeviceId=${deviceId}&DeviceType=TestPhone${params}`;
  dev.headers = (extra = {}) => ({
    Authorization: auth, 'MS-ASProtocolVersion': version, 'User-Agent': 'E2E-Legacy/1',
    ...(dev.policyKey ? { 'X-MS-PolicyKey': dev.policyKey } : {}), ...extra,
  });
  /** WBXML command → decoded tree; asserts HTTP 200 and only tags of `version`. */
  dev.post = async (cmd, node, { headers = {} } = {}) => {
    const r = await http('POST', dev.url(cmd), { raw: true, body: encode(node), headers: dev.headers({ 'Content-Type': 'application/vnd.ms-sync.wbxml', ...headers }) });
    const buf = Buffer.from(await r.arrayBuffer());
    assert(r.status === 200 && buf.length > 0, `${version} ${cmd} → HTTP ${r.status} (${buf.length} B)`);
    const newer = tagsNewerThan(buf, version);
    assert(newer.length === 0, `${version} ${cmd}: tags newer than ${version}: ${JSON.stringify(newer)}`);
    return decodeWbxml(buf);
  };
  /** WBXML command → { status, body } without assertions (empty 14.x compose success, refusals). */
  dev.postRaw = async (cmd, node, { headers = {} } = {}) => {
    const r = await http('POST', dev.url(cmd), { raw: true, body: encode(node), headers: dev.headers({ 'Content-Type': 'application/vnd.ms-sync.wbxml', ...headers }) });
    return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
  };
  dev.provision = async () => {
    const p1 = await dev.post('Provision', provisionReq());
    const temp = kid(kid(kid(p1, 'Policies'), 'Policy'), 'PolicyKey')?.text;
    assert(temp, `${version} Provision phase 1: no PolicyKey`);
    const p2 = await dev.post('Provision', provisionReq(temp));
    dev.policyKey = kid(kid(kid(p2, 'Policies'), 'Policy'), 'PolicyKey')?.text;
    assert(dev.policyKey && dev.policyKey !== temp, `${version} Provision phase 2: no final key`);
  };
  dev.inbox = async () => {
    const fs = await dev.post('FolderSync', [7, 0x16, [[7, 0x12, '0']]]);
    const inbox = all(kid(fs, 'Changes'), 'Add').find((a) => kid(a, 'Type')?.text === '2');
    assert(inbox, `${version} FolderSync: no inbox`);
    return kid(inbox, 'ServerId').text;
  };
  dev.syncAdds = async (inbox) => {
    const primed = await dev.post('Sync', syncReq(inbox, '0'));
    const key = findTag(primed, (x) => x.name === 'SyncKey')?.text;
    assert(key, `${version} Sync: no SyncKey`);
    const tree = await dev.post('Sync', syncReq(inbox, key, [A(0x13), A(0x15, '50'), A(0x17, [[17, 0x05, [[17, 0x06, '2'], [17, 0x07, '2048']]]])]));
    const adds = [];
    const collect = (e) => { if (e.name === 'Add') adds.push(e); (e.children ?? []).forEach((c) => typeof c !== 'string' && collect(c)); };
    collect(tree);
    assert(adds.length > 0, `${version} Sync: no Add`);
    return adds;
  };
  return dev;
}

/** Mail from user B with `subject` reached user A. */
async function deliveredToA(state, subject) {
  const c = creds();
  const tok = await session(state, 'a', state.users.a.email, c.userA);
  await waitFor(async () => {
    const q = await http('GET', `/api/v1/mail/search?q=${encodeURIComponent(subject)}`, { token: tok });
    return (q.json?.messages ?? q.json ?? []).some((m) => m.subject === subject);
  }, { what: `"${subject}" in A's mailbox`, timeout: 30000 });
}

const mimeFromB = (state, subject) => Buffer.from([
  `From: ${state.users.b.email}`, `To: ${state.users.a.email}`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`,
  `Message-ID: <e2e-legacy-${Date.now()}@e2e.test>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'Sent by an EAS e2e device.', '',
].join('\r\n'), 'utf8');

export async function run(state) {
  await check('eas-legacy: OPTIONS announces 12.1, 14.0 and 14.1; an unannounced version is served as 14.1', async () => {
    const o = await http('OPTIONS', '/Microsoft-Server-ActiveSync', { headers: { Authorization: device(state, '12.1', 'E2ELEGACY121').auth } });
    const versions = o.headers.get('ms-asprotocolversions') ?? '';
    assert(o.status === 200 && versions === '12.1,14.0,14.1', `${o.status} ${versions}`);
    // 2.5 is not announced: served as 14.1 (as before 9.4) — not provisioned → Status 142 inside the WBXML response
    const old = device(state, '2.5', 'E2ELEGACY25');
    const r = await http('POST', old.url('FolderSync'), { raw: true, body: encode([7, 0x16, [[7, 0x12, '0']]]), headers: { ...old.headers(), 'Content-Type': 'application/vnd.ms-sync.wbxml' } });
    const buf = Buffer.from(await r.arrayBuffer());
    assert(r.status === 200 && buf.length > 0, `version 2.5 → HTTP ${r.status}`);
    assert(kid(decodeWbxml(buf), 'Status')?.text === '142', `version 2.5 → ${JSON.stringify(decodeWbxml(buf)).slice(0, 120)}`);
    return `versions ${versions}; 2.5 → served as 14.1 (Status 142)`;
  });

  const legacy = device(state, '12.1', 'E2ELEGACY121');
  let legacyInbox;
  await check('eas-legacy: 12.1 device without policy key → HTTP 449 (no global status codes before 14.0)', async () => {
    const r = await http('POST', legacy.url('FolderSync'), { raw: true, body: encode([7, 0x16, [[7, 0x12, '0']]]), headers: { ...legacy.headers(), 'Content-Type': 'application/vnd.ms-sync.wbxml' } });
    assert(r.status === 449, `HTTP ${r.status}`);
    return 'HTTP 449';
  });

  await check('eas-legacy: 12.1 Provision → FolderSync → Sync (AirSyncBase body, no Email2 / 14.x tags)', async () => {
    await legacy.provision();
    legacyInbox = await legacy.inbox();
    const adds = await legacy.syncAdds(legacyInbox);
    const email2 = adds.find((a) => findTag(a, (x) => x.page === 22));
    assert(!email2, '12.1 Sync carried Email2 tags');
    assert(adds.some((a) => findTag(a, (x) => x.name === 'Body' && x.page === 17)), 'no airsyncbase:Body');
    return `PolicyKey ${legacy.policyKey}, ${adds.length} Add(s)`;
  });

  await check('eas-legacy: 12.1 SendMail in the query-string form (raw MIME, SaveInSent=T) → 200 without body, delivered', async () => {
    const subject = `E2E EAS 12.1 SendMail ${Date.now()}`;
    const r = await http('POST', legacy.url('SendMail', '&SaveInSent=T'), {
      raw: true, body: mimeFromB(state, subject), headers: legacy.headers({ 'Content-Type': 'message/rfc822' }),
    });
    const body = Buffer.from(await r.arrayBuffer());
    assert(r.status === 200 && body.length === 0, `HTTP ${r.status}, ${body.length} B body`);
    await deliveredToA(state, subject);
    return 'sent and delivered';
  });

  await check('eas-legacy: 12.1 base64-encoded request line (FolderSync)', async () => {
    const id = Buffer.from(legacy.deviceId);
    const type = Buffer.from('TestPhone');
    const key = Buffer.alloc(4);
    key.writeUInt32LE(Number(legacy.policyKey));
    const blob = Buffer.from([121, 9, 0x09, 0x04, id.length, ...id, 4, ...key, type.length, ...type]);
    const r = await http('POST', `/Microsoft-Server-ActiveSync?${encodeURIComponent(blob.toString('base64'))}`, {
      raw: true, body: encode([7, 0x16, [[7, 0x12, '0']]]),
      headers: { Authorization: legacy.auth, 'Content-Type': 'application/vnd.ms-sync.wbxml', 'User-Agent': 'E2E-Legacy/1' },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    assert(r.status === 200, `HTTP ${r.status} ${buf.toString('utf8').slice(0, 80)}`);
    const tree = decodeWbxml(buf);
    assert(kid(tree, 'Status')?.text === '1' && kid(kid(tree, 'Changes'), 'Count'), JSON.stringify(tree).slice(0, 200));
    assert(tagsNewerThan(buf, '12.1').length === 0, 'tags newer than 12.1');
    return `${kid(kid(tree, 'Changes'), 'Count').text} folders`;
  });

  const v14 = device(state, '14.0', 'E2ELEGACY140');
  await check('eas-legacy: 14.0 device without policy key → Status 142 inside the WBXML response', async () => {
    const tree = await v14.post('FolderSync', [7, 0x16, [[7, 0x12, '0']]]);
    assert(kid(tree, 'Status')?.text === '142', `Status ${kid(tree, 'Status')?.text}`);
    return 'Status 142';
  });

  await check('eas-legacy: 14.0 Provision → FolderSync → Sync (Email2 ConversationId, no 14.1 tags)', async () => {
    await v14.provision();
    const inbox = await v14.inbox();
    const adds = await v14.syncAdds(inbox);
    assert(adds.some((a) => findTag(a, (x) => x.page === 22 && x.name === 'ConversationId')), '14.0 Sync without Email2:ConversationId');
    return `PolicyKey ${v14.policyKey}, ${adds.length} Add(s)`;
  });

  await check('eas-legacy: 14.0 Settings UserInformation (EmailAddresses form) + SendMail as ComposeMail WBXML', async () => {
    const S = (t, k) => [18, t, k];
    const settings = await v14.post('Settings', S(0x05, [S(0x1d, [S(0x07)])]));
    const get = kid(kid(settings, 'UserInformation'), 'Get');
    const addrs = all(kid(get, 'EmailAddresses'), 'SmtpAddress').map((x) => x.text);
    assert(!kid(get, 'Accounts') && addrs.includes(v14.B.toLowerCase()), `UserInformation ${JSON.stringify(get).slice(0, 200)}`);
    const subject = `E2E EAS 14.0 SendMail ${Date.now()}`;
    const CM = (t, k) => [21, t, k];
    const sent = await v14.postRaw('SendMail', CM(0x05, [CM(0x11, `e2e-legacy-${Date.now()}`), CM(0x08), CM(0x10, mimeFromB(state, subject).toString('utf8'))]));
    // 9.4: [MS-ASCMD] 2.2.1.17 — a successful SendMail returns an empty response
    assert(sent.status === 200 && sent.body.length === 0, `SendMail → HTTP ${sent.status}, ${sent.body.length} B`);
    await deliveredToA(state, subject);
    return `addresses ${addrs.join(', ')}; mail delivered (empty response)`;
  });

  // 9.4: [MS-ASPROV] — Ping is one of the commands a device may send without X-MS-PolicyKey.
  await check('eas-legacy: Ping without X-MS-PolicyKey is served for a provisioned device, refused for an unknown one', async () => {
    // HeartbeatInterval 10 s is below the minimum: the command answers at once with Status 5
    // (heartbeat out of range) — which proves the request passed the device policy check.
    const inbox = await v14.inbox();
    const PING = [13, 0x05, [[13, 0x08, '10'], [13, 0x09, [[13, 0x0a, [[13, 0x0b, inbox], [13, 0x0c, 'Email']]]]]]];
    const key = v14.policyKey;
    v14.policyKey = undefined; // no header
    try {
      const ok = await v14.postRaw('Ping', PING);
      assert(ok.status === 200 && ok.body.length > 0, `provisioned device: HTTP ${ok.status}`);
      const status = kid(decodeWbxml(ok.body), 'Status')?.text;
      assert(status === '5', `provisioned device: Ping Status ${status} (expected 5 — heartbeat out of range)`);
      const sync = await v14.postRaw('FolderSync', [7, 0x16, [[7, 0x12, '0']]]);
      assert(kid(decodeWbxml(sync.body), 'Status')?.text === '142', 'other commands still need the policy key');
      const unknown = device(state, '14.0', `E2ENOKEY${Date.now() % 100000}`);
      const r = await unknown.postRaw('Ping', PING);
      assert(kid(decodeWbxml(r.body), 'Status')?.text === '142', `unknown device: HTTP ${r.status}`);
      return `Ping Status ${status}; FolderSync without key → 142; unknown device → 142`;
    } finally { v14.policyKey = key; }
  });

  await check('eas-legacy: SendMail above the maximum message size → Status 122 (14.0) / HTTP 413 (12.1); body cap follows the setting', async () => {
    // BCP → Settings → Mail: 1 MB — the settings reload drops the cached limit in the
    // services at once (request-body cap: 1 MB × 4/3 + 1 MB ≈ 2.3 MB, body-limit.ts)
    const admin = await session(state, 'admin', state.adminEmail, creds().admin);
    const set = (mb) => http('PUT', '/api/v1/admin/settings/mail', { token: admin, body: { maxMessageSizeMb: mb } });
    assert((await set(1)).status === 200, 'maxMessageSizeMb=1 not saved');
    try {
      await new Promise((r) => setTimeout(r, 3_000)); // Redis settings reload → activesync
      const big = Buffer.concat([mimeFromB(state, `E2E EAS too large ${Date.now()}`), Buffer.alloc(2 * 1024 * 1024, 0x61)]);
      const CM = (t, k) => [21, t, k];
      const r14 = await v14.postRaw('SendMail', CM(0x05, [CM(0x11, `e2e-big-${Date.now()}`), CM(0x08), CM(0x10, big.toString('latin1'))]));
      assert(r14.status === 200 && kid(decodeWbxml(r14.body), 'Status')?.text === '122', `14.0 → HTTP ${r14.status} ${r14.body.length} B`);
      const r12 = await http('POST', legacy.url('SendMail'), { raw: true, body: big, headers: legacy.headers({ 'Content-Type': 'message/rfc822' }) });
      assert(r12.status === 413, `12.1 → HTTP ${r12.status}`);
      // a body above the cap is refused by the body parser before the command runs
      const huge = Buffer.concat([mimeFromB(state, `E2E EAS over cap ${Date.now()}`), Buffer.alloc(3 * 1024 * 1024, 0x61)]);
      const rCap = await http('POST', legacy.url('SendMail'), { raw: true, body: huge, headers: legacy.headers({ 'Content-Type': 'message/rfc822' }) });
      assert(rCap.status === 413, `body above the cap → HTTP ${rCap.status}`);
      return '14.0 Status 122, 12.1 HTTP 413 (limit 1 MB, message 2 MB); 3 MB body → 413 at the body cap';
    } finally {
      await set(25);
    }
  });
}
