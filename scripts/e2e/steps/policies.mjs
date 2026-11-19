// Step: webmail policies (9.4, docs/webmail-policies.md).
// The admin switches the calendar and tasks modules off for B → B's webmail API
// answers 403 FEATURE_DISABLED for them (mail keeps working), GET /user/features
// reports them off (the webmail hides them), CalDAV refuses B's calendars.
// A blocked file type (by extension) cannot be downloaded (403
// ATTACHMENT_BLOCKED), a "save only" type is refused for inline display, and
// "always block" refuses the image proxy. With the module "App-Passwörter" off
// an existing app password of B fails on IMAP / JMAP (the primary password
// works). Everything back to inherit at the end.
import { check, assert, basic, creds, http, session } from '../lib.mjs';
import { imapLogin } from './imap.mjs';

const ADMIN_PATH = '/api/v1/admin/webmail-policies';

async function attachmentOfB(state, tok) {
  if (state.attachmentId) return state.attachmentId;
  const q = await http('GET', `/api/v1/mail/search?q=${encodeURIComponent(state.a2b.subject)}`, { token: tok });
  const list = q.json?.messages ?? q.json ?? [];
  assert(list.length, `search ${q.status}`);
  const m = await http('GET', `/api/v1/mail/messages/${list[0].id}`, { token: tok });
  const att = m.json.attachments.find((a) => a.filename === 'e2e-data.bin');
  assert(att, 'attachment not listed');
  return att.id;
}

export async function run(state) {
  const c = creds();
  const admin = await session(state, 'admin', state.adminEmail, c.admin);
  const B = state.users.b.email;
  const userPath = `${ADMIN_PATH}/users/${state.users.b.id}`;
  const setB = (body) => http('PUT', userPath, { token: admin, body });
  const tokB = await session(state, 'b', B, c.userB);

  await check('policies: server level readable, every module on by default', async () => {
    const r = await http('GET', ADMIN_PATH, { token: admin });
    assert(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    assert(r.json.settings.features.calendar === 'on' && r.json.effective.content.externalImages, JSON.stringify(r.json.settings));
    const bad = await http('PUT', ADMIN_PATH, { token: admin, body: { features: { calendar: 'inherit' } } });
    assert(bad.status === 400, `inherit on the server level → ${bad.status}`);
    return `calendar ${r.json.settings.features.calendar}, images ${r.json.effective.content.externalImages}; inherit 400`;
  });

  try {
    await check('policies: calendar + tasks off for B → 403 FEATURE_DISABLED, hidden, mail unaffected', async () => {
      const r = await setB({ features: { calendar: 'off', tasks: 'off' } });
      assert(r.status === 200 && r.json.effective.features.calendar === false && r.json.sources.features.calendar === 'user',
        `${r.status} ${r.text.slice(0, 200)}`);
      const cal = await http('GET', '/api/v1/calendar', { token: tokB });
      assert(cal.status === 403 && cal.json?.code === 'FEATURE_DISABLED' && cal.json?.feature === 'calendar', `calendar ${cal.status} ${cal.text.slice(0, 200)}`);
      const tasks = await http('GET', '/api/v1/tasks', { token: tokB });
      assert(tasks.status === 403 && tasks.json?.feature === 'tasks', `tasks ${tasks.status}`);
      const features = await http('GET', '/api/v1/user/features', { token: tokB });
      assert(features.status === 200 && features.json.features.calendar === false && features.json.features.contacts === true,
        `features ${features.status} ${features.text.slice(0, 200)}`);
      const mail = await http('GET', '/api/v1/mail/folders', { token: tokB });
      assert(mail.status === 200, `mail ${mail.status}`);
      return 'calendar/tasks 403, features hide them, mail 200';
    });

    await check('policies: CalDAV refuses B\'s calendars with the calendar module off', async () => {
      const r = await http('PROPFIND', `/dav/calendars/${state.users.b.id}/`, { token: tokB, headers: { Depth: '0' }, raw: true });
      assert(r.status === 403, `PROPFIND ${r.status}`);
      // 9.5: the task list follows the tasks module
      const t = await http('PROPFIND', `/dav/calendars/${state.users.b.id}/tasks/`, { token: tokB, headers: { Depth: '0' }, raw: true });
      assert(t.status === 403, `task list PROPFIND ${t.status}`);
      return 'calendar home 403, task list 403';
    });

    const attId = await attachmentOfB(state, tokB);
    await check('policies: a blocked file type cannot be downloaded (403 ATTACHMENT_BLOCKED)', async () => {
      const set = await setB({ features: { calendar: 'inherit', tasks: 'inherit' }, content: { blockedExtensions: ['bin'] } });
      assert(set.status === 200 && set.json.effective.content.blockedExtensions.includes('bin'), `${set.status} ${set.text.slice(0, 200)}`);
      const r = await http('GET', `/api/v1/mail/attachments/${attId}`, { token: tokB });
      assert(r.status === 403 && r.json?.code === 'ATTACHMENT_BLOCKED', `${r.status} ${r.text.slice(0, 200)}`);
      return `403 ${r.json.extension}`;
    });

    await check('policies: "save only" types are refused for inline display, still downloadable', async () => {
      const set = await setB({ content: { blockedExtensions: null, downloadOnlyExtensions: ['bin'] } });
      assert(set.status === 200, `${set.status} ${set.text.slice(0, 200)}`);
      const inline = await http('GET', `/api/v1/mail/attachments/${attId}?inline=1`, { token: tokB });
      assert(inline.status === 403 && inline.json?.code === 'INLINE_PREVIEW_DISABLED', `inline ${inline.status} ${inline.text.slice(0, 200)}`);
      const dl = await http('GET', `/api/v1/mail/attachments/${attId}`, { token: tokB, raw: true });
      assert(dl.status === 200 && /^attachment;/.test(dl.headers.get('content-disposition') ?? ''), `download ${dl.status}`);
      return 'inline 403, download 200 (attachment)';
    });

    await check('policies: "always block" refuses the image proxy (403 EXTERNAL_IMAGES_BLOCKED)', async () => {
      const set = await setB({ content: { downloadOnlyExtensions: null, externalImages: 'block' } });
      assert(set.status === 200, `${set.status} ${set.text.slice(0, 200)}`);
      const r = await http('GET', `/api/v1/mail/image-proxy?url=${encodeURIComponent('https://example.org/pixel.png')}`, { token: tokB });
      assert(r.status === 403 && r.json?.code === 'EXTERNAL_IMAGES_BLOCKED', `${r.status} ${r.text.slice(0, 200)}`);
      return '403';
    });
  } finally {
    await setB({
      features: { calendar: 'inherit', tasks: 'inherit' },
      content: { blockedExtensions: null, downloadOnlyExtensions: null, externalImages: null },
    });
  }

  await check('policies: module "App-Passwörter" off → B\'s existing app password stops working on IMAP and JMAP, back on → works', async () => {
    const ap = await http('POST', '/auth/app-passwords', { token: tokB, body: { name: 'e2e policy', currentPassword: c.userB } });
    assert(ap.status === 201 && ap.json?.password, `create ${ap.status} ${ap.text.slice(0, 200)}`);
    const imapStatus = async (pass) => { const im = await imapLogin(B, pass); const s = im.loginResult.status; im.close(); return s; };
    const jmapStatus = async () => (await http('GET', '/jmap/session', { headers: { Authorization: basic(B, ap.json.password) } })).status;
    try {
      assert(await imapStatus(ap.json.password) === 'OK' && await jmapStatus() === 200, 'app password works while the module is on');
      const off = await setB({ features: { appPasswords: 'off' } });
      assert(off.status === 200 && off.json.effective.features.appPasswords === false, `${off.status} ${off.text.slice(0, 200)}`);
      const imapOff = await imapStatus(ap.json.password);
      const jmapOff = await jmapStatus();
      assert(imapOff === 'NO' && jmapOff === 401, `module off: IMAP ${imapOff}, JMAP ${jmapOff}`);
      assert(await imapStatus(c.userB) === 'OK', 'the primary password still works');
      const list = await http('GET', '/auth/app-passwords', { token: tokB });
      assert(list.status === 403 && list.json?.code === 'FEATURE_DISABLED', `list ${list.status}`);
      await setB({ features: { appPasswords: 'inherit' } });
      assert(await imapStatus(ap.json.password) === 'OK', 'works again after inherit');
      return `off: IMAP ${imapOff}, JMAP ${jmapOff}, password OK; inherit: OK`;
    } finally {
      await setB({ features: { appPasswords: 'inherit' } });
      await http('DELETE', `/auth/app-passwords/${ap.json.id}`, { token: tokB });
    }
  });

  await check('policies: back to inherit → calendar and the attachment work again', async () => {
    const cal = await http('GET', '/api/v1/calendar', { token: tokB });
    const att = await http('GET', `/api/v1/mail/attachments/${await attachmentOfB(state, tokB)}`, { token: tokB, raw: true });
    assert(cal.status === 200 && att.status === 200, `calendar ${cal.status}, attachment ${att.status}`);
    return 'calendar 200, attachment 200';
  });
}
