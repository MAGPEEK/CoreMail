// Step contacts (9.5): structured contacts and contact groups — CardDAV PUT of a
// multi-value vCard and a group, read back over REST; a REST edit keeps the
// CardDAV-only properties; the group expands to recipients; notes categories.
import { randomUUID } from 'node:crypto';
import { check, assert, creds, http, basic, session } from '../lib.mjs';

export async function run(state) {
  const c = creds();
  const B = state.users.b.email, uid = state.users.b.id;
  const H = (extra = {}) => ({ Authorization: basic(B, c.userB), ...extra });
  const AB = `/dav/addressbooks/${uid}/default`;
  const tok = () => session(state, 'b', B, c.userB);
  const vcf = (...lines) => ['BEGIN:VCARD', ...lines, 'END:VCARD', ''].join('\r\n');

  const cardUid = `e2e-${randomUUID()}`;
  const cardId = `e2e-card-${randomUUID()}`;
  const card = vcf(
    'VERSION:3.0', `UID:${cardUid}`, 'N:Muster;Erika;Maria;Dr.;', 'FN:Dr. Erika Maria Muster', 'NICKNAME:Riki',
    'item1.EMAIL;type=INTERNET;type=WORK;type=pref:erika@firma-e2e.test', 'EMAIL;type=INTERNET;type=HOME:erika@privat-e2e.test',
    'TEL;type=CELL:+49 170 5550001', 'TEL;type=WORK;type=VOICE:+49 30 5550002', 'TEL;type=WORK;type=FAX:+49 30 5550003',
    'ADR;type=WORK:;;Hauptstr. 1;Berlin;;10115;Deutschland', 'URL;type=WORK:https://firma-e2e.test',
    'IMPP;type=HOME:xmpp:erika@chat-e2e.test', 'BDAY;X-APPLE-OMIT-YEAR=1604:1604-05-17', 'X-ANNIVERSARY:2010-06-12',
    'CATEGORIES:Kunden,VIP', 'X-E2E-CUSTOM:kept', 'PHOTO;ENCODING=b;TYPE=JPEG:QUJDRA==',
  );
  let contactId;
  await check('contacts: CardDAV PUT of a multi-value vCard 3 → 201', async () => {
    const r = await http('PUT', `${AB}/${cardId}.vcf`, { headers: H({ 'Content-Type': 'text/vcard; charset=utf-8', 'If-None-Match': '*' }), body: card });
    assert(r.status === 201 || r.status === 204, `${r.status} ${r.text.slice(0, 200)}`);
    return `${r.status} ETag ${r.headers.get('etag')}`;
  });

  await check('contacts: REST reads every structured field of the CardDAV card', async () => {
    const r = await http('GET', `/api/v1/contacts/${cardId}`, { token: await tok() });
    assert(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    const x = r.json;
    contactId = x.id;
    assert(x.name?.given === 'Erika' && x.name?.middle === 'Maria' && x.name?.prefix === 'Dr.', `name ${JSON.stringify(x.name)}`);
    assert(JSON.stringify(x.emails) === JSON.stringify([{ type: 'work', value: 'erika@firma-e2e.test' }, { type: 'home', value: 'erika@privat-e2e.test' }]), `emails ${JSON.stringify(x.emails)}`);
    assert(x.phones?.map((p) => p.type).join(',') === 'mobile,work,fax', `phones ${JSON.stringify(x.phones)}`);
    assert(x.addresses?.[0]?.city === 'Berlin' && x.addresses[0].type === 'work', `addresses ${JSON.stringify(x.addresses)}`);
    assert(x.urls?.[0]?.value === 'https://firma-e2e.test' && x.ims?.[0]?.value === 'xmpp:erika@chat-e2e.test', 'urls / ims');
    assert(x.birthday === '--05-17' && x.anniversary === '2010-06-12', `dates ${x.birthday} ${x.anniversary}`);
    assert(JSON.stringify(x.categories) === '["Kunden","VIP"]', `categories ${JSON.stringify(x.categories)}`);
    assert(x.email === 'erika@firma-e2e.test' && x.mobile === '+49 170 5550001' && x.phone === '+49 30 5550002', 'flat columns');
    const search = await http('GET', `/api/v1/contacts?q=${encodeURIComponent('chat-e2e')}`, { token: await tok() });
    assert(search.json?.some((s) => s.id === cardId), 'search does not cover the IM address');
    return 'names, typed lists, dates, categories, flat columns, search';
  });

  await check('contacts: a REST edit keeps the CardDAV-only properties', async () => {
    const r = await http('PUT', `/api/v1/contacts/${contactId}`, { token: await tok(), body: { phones: [{ type: 'mobile', value: '+49 170 5550001' }, { type: 'pager', value: '5550009' }], categories: ['VIP'] } });
    assert(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    const g = await http('GET', `${AB}/${cardId}.vcf`, { headers: H() });
    const text = g.text.replace(/\r?\n[ \t]/g, '');
    for (const kept of ['X-E2E-CUSTOM:kept', 'PHOTO;ENCODING=b;TYPE=JPEG:QUJDRA==', 'item1.EMAIL;type=INTERNET;type=WORK;type=pref:erika@firma-e2e.test', `UID:${cardUid}`]) {
      assert(text.includes(kept), `lost ${kept}:\n${text}`);
    }
    assert(/TEL;TYPE=PAGER:5550009/.test(text) && !/FAX/.test(text), `phones not written:\n${text}`);
    assert(/^CATEGORIES:VIP\r?$/m.test(text), 'categories not written');
    return 'PHOTO, X-, grouped EMAIL and UID kept';
  });

  const groupId = `e2e-group-${randomUUID()}`;
  await check('contacts: CardDAV PUT of a vCard 4 group (KIND:group + MEMBER) → REST group with members', async () => {
    const group = vcf('VERSION:4.0', 'KIND:group', 'FN:E2E Projekt', `UID:urn:uuid:${randomUUID()}`,
      `MEMBER:urn:uuid:${cardUid}`, 'MEMBER:mailto:extern@partner-e2e.test');
    const put = await http('PUT', `${AB}/${groupId}.vcf`, { headers: H({ 'Content-Type': 'text/vcard; charset=utf-8' }), body: group });
    assert(put.status === 201 || put.status === 204, `${put.status} ${put.text.slice(0, 200)}`);
    const r = await http('GET', `/api/v1/contacts/groups/${groupId}`, { token: await tok() });
    assert(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    const kinds = r.json.members.map((m) => `${m.kind}:${m.email ?? ''}`);
    assert(r.json.name === 'E2E Projekt' && kinds.join(',') === 'contact:erika@firma-e2e.test,address:extern@partner-e2e.test', kinds.join(','));
    return kinds.join(', ');
  });

  await check('contacts: the group expands to recipients and is offered by the autocomplete', async () => {
    const t = await tok();
    const exp = await http('GET', `/api/v1/contacts/groups/${groupId}/expand`, { token: t });
    const addrs = (exp.json?.recipients ?? []).map((x) => x.address);
    assert(addrs.join(',') === 'erika@firma-e2e.test,extern@partner-e2e.test', `recipients ${addrs.join(',')}`);
    const auto = await http('GET', '/api/v1/contacts?q=E2E%20Projekt&groups=1', { token: t });
    assert(auto.json?.some((s) => s.id === `group-${groupId}` && s.kind === 'group'), 'group not in the autocomplete');
    return addrs.join(', ');
  });

  await check('contacts: a REST group change is visible over CardDAV; deleting the contact leaves the group', async () => {
    const t = await tok();
    const put = await http('PUT', `/api/v1/contacts/groups/${groupId}`, { token: t, body: { members: [{ contactId }, { email: 'neu@partner-e2e.test', name: 'Neu' }] } });
    assert(put.status === 200, `${put.status} ${put.text.slice(0, 200)}`);
    let g = await http('GET', `${AB}/${groupId}.vcf`, { headers: H() });
    assert(/MEMBER:mailto:neu@partner-e2e\.test/.test(g.text) && !/extern@partner/.test(g.text), `vCard not rewritten:\n${g.text}`);
    assert((await http('DELETE', `${AB}/${cardId}.vcf`, { headers: H() })).status === 204, 'contact delete');
    g = await http('GET', `${AB}/${groupId}.vcf`, { headers: H() });
    assert(!g.text.includes(cardUid), `deleted contact still a member:\n${g.text}`);
    assert((await http('DELETE', `/api/v1/contacts/groups/${groupId}`, { token: t })).status === 200, 'group delete');
    return 'MEMBER lines follow REST and deletions';
  });

  await check('contacts: a percent-encoded CR/LF in a mailto member never reaches the stored members or a rewritten vCard', async () => {
    const t = await tok();
    const evilId = `e2e-group-${randomUUID()}`;
    const evil = vcf('VERSION:4.0', 'KIND:group', 'FN:E2E Evil', `UID:urn:uuid:${randomUUID()}`,
      'MEMBER:mailto:x%0D%0AEMAIL:injected@partner-e2e.test%0D%0AX@partner-e2e.test', 'MEMBER:mailto:ok@partner-e2e.test');
    const put = await http('PUT', `${AB}/${evilId}.vcf`, { headers: H({ 'Content-Type': 'text/vcard; charset=utf-8' }), body: evil });
    assert(put.status === 201 || put.status === 204, `${put.status} ${put.text.slice(0, 200)}`);
    const r = await http('GET', `/api/v1/contacts/groups/${evilId}`, { token: t });
    assert(r.json?.members?.length === 1 && r.json.members[0].email === 'ok@partner-e2e.test', JSON.stringify(r.json?.members));
    await http('PUT', `/api/v1/contacts/groups/${evilId}`, { token: t, body: { name: 'E2E Evil 2' } });
    const g = await http('GET', `${AB}/${evilId}.vcf`, { headers: H() });
    assert(!/^EMAIL/m.test(g.text), `injected property:\n${g.text}`);
    await http('DELETE', `/api/v1/contacts/groups/${evilId}`, { token: t });
    return 'unsafe member dropped';
  });

  await check('notes: categories are stored and filterable; colours are case-insensitive', async () => {
    const t = await tok();
    const n = await http('POST', '/api/v1/notes', { token: t, body: { subject: 'E2E Notiz', color: 'blue', categories: ['E2E-Kategorie'] } });
    assert(n.json?.color === 'BLUE', `colour ${n.json?.color}`);
    assert(n.status === 201 && n.json?.categories?.[0] === 'E2E-Kategorie', `${n.status} ${n.text.slice(0, 200)}`);
    const list = await http('GET', '/api/v1/notes?category=E2E-Kategorie', { token: t });
    assert(list.json?.some((x) => x.id === n.json.id), 'category filter');
    await http('DELETE', `/api/v1/notes/${n.json.id}`, { token: t });
    return 'ok';
  });
}
