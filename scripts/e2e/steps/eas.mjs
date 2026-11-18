// Step 8: ActiveSync (EAS 14.1) — OPTIONS, Provision, FolderSync, Sync, GetAttachment.
// Requests are encoded like a real client (explicit MS-ASWBXML code pages); responses are
// decoded with the repo decoder (packages/activesync/src/wbxml.ts) AND scanned page-aware
// to verify that each tag is emitted in its own code page.
import { check, assert, creds, http, basic, session } from '../lib.mjs';
import { decodeWbxml } from '../../../packages/activesync/src/wbxml.ts';

// [page, token] per element for the requests we send
const T = {
  Provision: [14, 0x05], Policies: [14, 0x06], Policy: [14, 0x07], PolicyType: [14, 0x08], PolicyKey: [14, 0x09], PStatus: [14, 0x0b],
  FolderSync: [7, 0x16], FSyncKey: [7, 0x12],
  Sync: [0, 0x05], Collections: [0, 0x1c], Collection: [0, 0x0f], SyncKey: [0, 0x0b], CollectionId: [0, 0x12], GetChanges: [0, 0x13], WindowSize: [0, 0x15],
};
function encode(node) {
  const out = [0x03, 0x01, 0x6a, 0x00];
  let page = -1;
  const walk = ([name, kids]) => {
    const [p, t] = T[name];
    if (p !== page) { out.push(0x00, p); page = p; }
    const has = kids !== undefined;
    out.push(t | (has ? 0x40 : 0));
    if (!has) return;
    if (typeof kids === 'string') { out.push(0x03); for (const b of Buffer.from(kids, 'utf8')) out.push(b); out.push(0x00); } else kids.forEach(walk);
    out.push(0x01);
  };
  walk(node);
  return Buffer.from(out);
}
/** Page-aware scan: returns [{ page, token, depth }] for every tag in the response. */
function scanTags(buf) {
  const tags = []; let i = 4, page = 0, depth = 0; // header: version, publicId, charset, strtbl len (all 1 byte here)
  while (i < buf.length) {
    const b = buf[i++];
    if (b === 0x00) { page = buf[i++]; continue; }
    if (b === 0x01) { depth--; continue; }
    if (b === 0x03) { while (buf[i++] !== 0x00); continue; }
    if (b === 0xc3) { let len = 0, x; do { x = buf[i++]; len = (len << 7) | (x & 0x7f); } while (x & 0x80); i += len; continue; }
    tags.push({ page, token: b & 0x3f, depth });
    if (b & 0x40) depth++;
  }
  return tags;
}

export async function run(state) {
  const c = creds();
  const B = state.users.b.email;
  const auth = basic(B, c.userB);
  const qs = (cmd) => `/Microsoft-Server-ActiveSync?Cmd=${cmd}&User=${encodeURIComponent(B)}&DeviceId=E2EDEVICE01&DeviceType=iPhone`;
  const post = (cmd, body, extra = {}) => http('POST', qs(cmd), {
    raw: true, body, headers: { Authorization: auth, 'Content-Type': 'application/vnd.ms-sync.wbxml', 'MS-ASProtocolVersion': '14.1', 'User-Agent': 'Apple-iPhone/1', ...extra },
  });

  await check('eas: OPTIONS advertises 14.1; POST without auth → 401', async () => {
    const o = await http('OPTIONS', '/Microsoft-Server-ActiveSync', { headers: { Authorization: auth } });
    assert(o.status === 200 && /14\.1/.test(o.headers.get('ms-asprotocolversions') ?? ''), `${o.status} ${o.headers.get('ms-asprotocolversions')}`);
    const u = await http('POST', qs('FolderSync'), { headers: { 'MS-ASProtocolVersion': '14.1' }, body: Buffer.alloc(0) });
    assert(u.status === 401, `unauth POST → ${u.status}`);
    return `versions ${o.headers.get('ms-asprotocolversions')}; unauth 401`;
  });

  let policyKey;
  await check('eas: Provision (phase 1 + 2) returns a PolicyKey', async () => {
    const req = encode(['Provision', [['Policies', [['Policy', [['PolicyType', 'MS-EAS-Provisioning-WBXML']]]]]]]);
    const r = await post('Provision', req);
    assert(r.status === 200, `${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const tree = decodeWbxml(buf);
    const pol = tree.children?.find((x) => x.name === 'Policies')?.children?.find((x) => x.name === 'Policy');
    policyKey = pol?.children?.find((x) => x.name === 'PolicyKey')?.text;
    assert(policyKey, `no PolicyKey in ${JSON.stringify(tree).slice(0, 300)}`);
    state.easProvisionRaw = buf.toString('hex');
    const req2 = encode(['Provision', [['Policies', [['Policy', [['PolicyType', 'MS-EAS-Provisioning-WBXML'], ['PolicyKey', policyKey], ['PStatus', '1']]]]]]]);
    const r2 = await post('Provision', req2, { 'X-MS-PolicyKey': policyKey });
    assert(r2.status === 200, `phase 2 ${r2.status}`);
    // [MS-ASPROV]: phase 1 hands out a temporary key, phase 2 the final one for X-MS-PolicyKey
    const tree2 = decodeWbxml(Buffer.from(await r2.arrayBuffer()));
    const pol2 = tree2.children?.find((x) => x.name === 'Policies')?.children?.find((x) => x.name === 'Policy');
    const finalKey = pol2?.children?.find((x) => x.name === 'PolicyKey')?.text;
    assert(finalKey && finalKey !== policyKey, `phase 2 must return a new final PolicyKey: ${JSON.stringify(tree2).slice(0, 300)}`);
    const temporary = policyKey;
    policyKey = finalKey;
    return `temporary ${temporary} → final ${policyKey}`;
  });

  await check('eas: commands need the final policy key (none → 142, temporary/wrong → 144)', async () => {
    const status = async (headers) => {
      const r = await post('FolderSync', encode(['FolderSync', [['FSyncKey', '0']]]), headers);
      assert(r.status === 200, `HTTP ${r.status}`);
      return decodeWbxml(Buffer.from(await r.arrayBuffer())).children?.find((x) => x.name === 'Status')?.text;
    };
    const none = await status({});
    const wrong = await status({ 'X-MS-PolicyKey': String((Number(policyKey) % 4294967294) + 1) });
    assert(none === '142' && wrong === '144', `no key → ${none}, wrong key → ${wrong}`);
    return `no key ${none}, wrong key ${wrong}`;
  });

  await check('eas: Provision response uses the Provision code page for Status (MS-ASWBXML)', async () => {
    const tags = scanTags(Buffer.from(state.easProvisionRaw, 'hex'));
    // every Status (token 0x0b) inside <Provision> must be on page 14; page 0 token 0x0f is AirSync:Status
    const wrong = tags.filter((t) => t.page === 0);
    assert(wrong.length === 0, `tags emitted on AirSync page 0 inside Provision: ${JSON.stringify(wrong)}`);
    return 'all tags on page 14';
  });

  let inboxId, fsRaw;
  await check('eas: FolderSync (SyncKey 0) lists INBOX', async () => {
    const r = await post('FolderSync', encode(['FolderSync', [['FSyncKey', '0']]]), { 'X-MS-PolicyKey': policyKey });
    assert(r.status === 200, `${r.status}`);
    fsRaw = Buffer.from(await r.arrayBuffer());
    const tree = decodeWbxml(fsRaw);
    const adds = tree.children?.find((x) => x.name === 'Changes')?.children?.filter((x) => x.name === 'Add') ?? [];
    const inbox = adds.find((a) => a.children.find((x) => x.name === 'Type')?.text === '2');
    assert(inbox, `no inbox (Type 2) among ${adds.length} folders`);
    inboxId = inbox.children.find((x) => x.name === 'ServerId').text;
    return `${adds.length} folders, inbox ${inboxId}`;
  });

  await check('eas: FolderSync response uses the FolderHierarchy code page (Status/SyncKey)', async () => {
    const tags = scanTags(fsRaw);
    const wrong = tags.filter((t) => t.page !== 7);
    assert(wrong.length === 0, `tags on other pages: ${JSON.stringify(wrong.slice(0, 5))} (page 0 token 0x0f=AirSync:Status, 0x0b=AirSync:SyncKey)`);
    return 'all tags on page 7';
  });

  await check('eas: Sync INBOX returns messages', async () => {
    const s0 = await post('Sync', encode(['Sync', [['Collections', [['Collection', [['SyncKey', '0'], ['CollectionId', inboxId]]]]]]]), { 'X-MS-PolicyKey': policyKey });
    assert(s0.status === 200, `initial ${s0.status}`);
    const t0 = decodeWbxml(Buffer.from(await s0.arrayBuffer()));
    const col0 = JSON.stringify(t0);
    const find = (n, name) => (n.name === name ? n : (n.children ?? []).map((c) => (typeof c === 'string' ? null : find(c, name))).find(Boolean));
    const key = find(t0, 'SyncKey')?.text;
    assert(key && find(t0, 'Status')?.text === '1', `no SyncKey / Status!=1: ${col0.slice(0, 300)}`);
    const s1 = await post('Sync', encode(['Sync', [['Collections', [['Collection', [['SyncKey', key], ['CollectionId', inboxId], ['GetChanges'], ['WindowSize', '100']]]]]]]), { 'X-MS-PolicyKey': policyKey });
    assert(s1.status === 200, `${s1.status}`);
    const t1 = JSON.stringify(decodeWbxml(Buffer.from(await s1.arrayBuffer())));
    const adds0 = (col0.match(/"name":"Add"/g) ?? []).length;
    const adds = (t1.match(/"name":"Add"/g) ?? []).length;
    // [MS-ASCMD] 2.2.3.166.4: the SyncKey=0 response only primes the sync state (no Commands);
    // clients fetch items with the next Sync — items sent in the priming response are not used.
    assert(adds0 === 0, `SyncKey=0 response already carried ${adds0} Add commands (and the follow-up Sync ${adds}) — devices that follow the spec never receive these messages`);
    assert(adds > 0, `no Add in sync response: ${t1.slice(0, 300)}`);
    return `${adds} messages`;
  });

  await check('eas: GetAttachment returns the attachment bytes', async () => {
    const tok = await session(state, 'b', B, c.userB);
    const q = await http('GET', `/api/v1/mail/search?q=${encodeURIComponent('E2E pop3')}`, { token: tok });
    const msg = (q.json?.messages ?? q.json ?? [])[0];
    assert(msg, `search: ${q.status}`);
    const full = await http('GET', `/api/v1/mail/messages/${msg.id}`, { token: tok });
    const att = full.json?.attachments?.[0];
    assert(att, 'no attachment on message');
    const r = await http('POST', `/Microsoft-Server-ActiveSync?Cmd=GetAttachment&AttachmentName=${att.id}&User=${encodeURIComponent(B)}&DeviceId=E2EDEVICE01&DeviceType=iPhone`, {
      raw: true, headers: { Authorization: auth, 'MS-ASProtocolVersion': '14.1', 'X-MS-PolicyKey': policyKey },
    });
    const body = Buffer.from(await r.arrayBuffer());
    assert(r.status === 200 && body.length === att.size, `status ${r.status}, ${body.length} bytes (Content-Length ${r.headers.get('content-length')}, expected ${att.size})`);
    return `${body.length} B`;
  });
}
