// Step 8b: ActiveSync 14.1 bodies + attachments — Sync with AirSyncBase BodyPreference
// (MIME byte-exact, HTML truncation), GetItemEstimate, ItemOperations Fetch (attachment by
// FileReference, full message by ServerId, foreign reference refused).
// Needs the pop3 step's "E2E pop3" message (it carries an attachment) in user B's INBOX.
import { check, assert, creds, http, basic } from '../lib.mjs';
import { decodeWbxml } from '../../../packages/activesync/src/wbxml.ts';

const T = {
  Provision: [14, 0x05], Policies: [14, 0x06], Policy: [14, 0x07], PolicyType: [14, 0x08], PolicyKey: [14, 0x09], PStatus: [14, 0x0b],
  FolderSync: [7, 0x16], FSyncKey: [7, 0x12],
  Sync: [0, 0x05], Collections: [0, 0x1c], Collection: [0, 0x0f], SyncKey: [0, 0x0b], CollectionId: [0, 0x12], ServerId: [0, 0x0d],
  GetChanges: [0, 0x13], WindowSize: [0, 0x15], Options: [0, 0x17], MIMESupport: [0, 0x22],
  BodyPreference: [17, 0x05], Type: [17, 0x06], TruncationSize: [17, 0x07], FileReference: [17, 0x11],
  GetItemEstimate: [6, 0x05], GCollections: [6, 0x07], GCollection: [6, 0x08], GCollectionId: [6, 0x0a],
  ItemOperations: [20, 0x05], Fetch: [20, 0x06], Store: [20, 0x07], IOOptions: [20, 0x08],
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
    if (typeof kids === 'string') { out.push(0x03, ...Buffer.from(kids, 'utf8'), 0x00); } else kids.forEach(walk);
    out.push(0x01);
  };
  walk(node);
  return Buffer.from(out);
}
const find = (n, name, page) => (n.name === name && (page === undefined || n.page === page) ? n
  : (n.children ?? []).map((c) => (typeof c === 'string' ? null : find(c, name, page))).find(Boolean));
const findAll = (n, name, acc = []) => { if (n.name === name) acc.push(n); (n.children ?? []).forEach((c) => typeof c !== 'string' && findAll(c, name, acc)); return acc; };

export async function run(state) {
  const c = creds();
  const B = state.users.b.email;
  const auth = basic(B, c.userB);
  const qs = (cmd) => `/Microsoft-Server-ActiveSync?Cmd=${cmd}&User=${encodeURIComponent(B)}&DeviceId=E2EDEVICE02&DeviceType=iPhone`;
  let policyKey;
  const post = async (cmd, node) => {
    const r = await http('POST', qs(cmd), {
      raw: true, body: encode(node),
      headers: { Authorization: auth, 'Content-Type': 'application/vnd.ms-sync.wbxml', 'MS-ASProtocolVersion': '14.1', 'User-Agent': 'Apple-iPhone/1', ...(policyKey ? { 'X-MS-PolicyKey': policyKey } : {}) },
    });
    assert(r.status === 200, `${cmd} → ${r.status}`);
    return decodeWbxml(Buffer.from(await r.arrayBuffer()));
  };

  let inboxId;
  await check('eas-body: provision + FolderSync', async () => {
    const p1 = await post('Provision', ['Provision', [['Policies', [['Policy', [['PolicyType', 'MS-EAS-Provisioning-WBXML']]]]]]]);
    policyKey = find(p1, 'PolicyKey')?.text;
    await post('Provision', ['Provision', [['Policies', [['Policy', [['PolicyType', 'MS-EAS-Provisioning-WBXML'], ['PolicyKey', policyKey], ['PStatus', '1']]]]]]]);
    const fs = await post('FolderSync', ['FolderSync', [['FSyncKey', '0']]]);
    const inbox = findAll(fs, 'Add').find((a) => find(a, 'Type')?.text === '2');
    inboxId = find(inbox, 'ServerId')?.text;
    assert(inboxId, 'no inbox');
    return `inbox ${inboxId}`;
  });

  const syncWith = (key, options) => post('Sync', ['Sync', [['Collections', [['Collection', [
    ['SyncKey', key], ['CollectionId', inboxId], ['GetChanges'], ['WindowSize', '512'], ...(options ? [['Options', options]] : []),
  ]]]]]]);

  let primingKey, mimeKey, item, mimeData, attRef, attSize;
  await check('eas-body: Sync with BodyPreference Type 4 + MIMESupport 2 returns AirSyncBase MIME + Attachments', async () => {
    const p = await syncWith('0', [['MIMESupport', '2'], ['BodyPreference', [['Type', '4']]]]);
    primingKey = find(p, 'SyncKey')?.text;
    const s = await syncWith(primingKey);   // options are sticky
    mimeKey = find(s, 'SyncKey')?.text;
    const adds = findAll(s, 'Add');
    item = adds.find((a) => /E2E pop3/.test(find(a, 'Subject', 2)?.text ?? '') && find(a, 'Attachments', 17));
    assert(item, `no "E2E pop3" message with airsyncbase:Attachments among ${adds.length} items`);
    const body = find(item, 'Body', 17);
    assert(body && find(body, 'Type', 17)?.text === '4', `Body type ${find(body ?? {}, 'Type')?.text}`);
    assert(!find(item, 'Body', 2), 'legacy Email:Body still sent');
    mimeData = find(body, 'Data', 17)?.bytes;
    assert(mimeData && String(mimeData.length) === find(body, 'EstimatedDataSize', 17)?.text, 'MIME data size != EstimatedDataSize');
    assert(/^[\x21-\x7e]+:/.test(mimeData.toString('latin1')) && /\r\n\r\n/.test(mimeData.toString('latin1')), 'Data is not an RFC 5322 message');
    const att = find(item, 'Attachment', 17);
    attRef = find(att, 'FileReference', 17)?.text;
    attSize = Number(find(att, 'EstimatedDataSize', 17)?.text);
    assert(attRef && attSize > 0, 'attachment without FileReference/size');
    return `${adds.length} items, MIME ${mimeData.length} B, attachment ${attRef}`;
  });

  await check('eas-body: GetItemEstimate counts the same window (priming key → all, current key → 0)', async () => {
    const est = async (key) => {
      const t = await post('GetItemEstimate', ['GetItemEstimate', [['GCollections', [['GCollection', [['SyncKey', key], ['GCollectionId', inboxId]]]]]]]);
      return [find(t, 'Status', 6)?.text, find(t, 'Estimate', 6)?.text];
    };
    const delivered = findAll(await syncWith(primingKey), 'Add').length;
    const [st1, all] = await est(primingKey);
    const [st2, none] = await est(mimeKey);
    const [st3] = await est('0');
    assert(st1 === '1' && Number(all) === delivered, `priming key: status ${st1} estimate ${all}, Sync delivered ${delivered}`);
    assert(st2 === '1' && none === '0', `current key: status ${st2} estimate ${none}`);
    assert(st3 === '3', `SyncKey 0 → status ${st3} (expected 3 = not primed)`);
    return `estimate ${all} = ${delivered} delivered`;
  });

  await check('eas-body: Sync HTML with TruncationSize 16 → Truncated 1', async () => {
    const t = await syncWith(primingKey, [['BodyPreference', [['Type', '2'], ['TruncationSize', '16']]]]);
    const it = findAll(t, 'Add').find((a) => find(a, 'ServerId')?.text === find(item, 'ServerId')?.text);
    const body = find(it, 'Body', 17);
    assert(find(body, 'Truncated', 17)?.text === '1', `Truncated ${find(body, 'Truncated', 17)?.text}`);
    assert((find(body, 'Data', 17)?.bytes?.length ?? 0) <= 16, 'Data longer than TruncationSize');
    return `type ${find(body, 'Type', 17)?.text}, estimated ${find(body, 'EstimatedDataSize', 17)?.text} B`;
  });

  await check('eas-body: ItemOperations Fetch FileReference returns the attachment bytes', async () => {
    const t = await post('ItemOperations', ['ItemOperations', [['Fetch', [['Store', 'Mailbox'], ['FileReference', attRef]]]]]);
    const f = find(t, 'Fetch', 20);
    assert(find(f, 'Status', 20)?.text === '1', `status ${find(f, 'Status', 20)?.text}`);
    const data = Buffer.from(find(f, 'Data', 20)?.text ?? '', 'base64');
    assert(data.length === attSize, `${data.length} B, expected ${attSize}`);
    const bad = await post('ItemOperations', ['ItemOperations', [['Fetch', [['Store', 'Mailbox'], ['FileReference', 'not-an-attachment']]]]]);
    assert(find(bad, 'Status', 20) && find(find(bad, 'Fetch', 20), 'Status', 20)?.text === '15', 'unknown FileReference not refused with 15');
    return `${data.length} B`;
  });

  await check('eas-body: ItemOperations Fetch ServerId (Type 4) returns the same MIME octets as Sync', async () => {
    const t = await post('ItemOperations', ['ItemOperations', [['Fetch', [
      ['Store', 'Mailbox'], ['CollectionId', inboxId], ['ServerId', find(item, 'ServerId').text],
      ['IOOptions', [['MIMESupport', '2'], ['BodyPreference', [['Type', '4']]]]],
    ]]]]);
    const f = find(t, 'Fetch', 20);
    assert(find(f, 'Status', 20)?.text === '1', `status ${find(f, 'Status', 20)?.text}`);
    const data = find(find(f, 'Body', 17), 'Data', 17)?.bytes;
    assert(data && data.equals(mimeData), 'ItemOperations MIME differs from the Sync MIME');
    return `${data.length} B identical`;
  });
}
