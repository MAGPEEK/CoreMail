// Step 9: REST / web — login, refresh rotation + reuse detection, logout, paging,
// attachment download, removed endpoints, security headers.
import { createHash } from 'node:crypto';
import { check, assert, creds, http, session } from '../lib.mjs';

export async function run(state) {
  const c = creds();
  const B = state.users.b.email;

  let t1;
  await check('rest: login B → access + refresh token', async () => {
    const r = await http('POST', '/auth/login', { body: { email: B, password: c.userB } });
    assert(r.status === 200 && r.json?.accessToken && r.json?.refreshToken, `${r.status} ${r.text.slice(0, 200)}`);
    t1 = r.json;
    const bad = await http('POST', '/auth/login', { body: { email: B, password: 'wrong-password-1' } });
    assert(bad.status === 401, `wrong password → ${bad.status}`);
    return 'ok; wrong password 401';
  });

  await check('rest: refresh rotates; reusing the old refresh token revokes the session', async () => {
    const r1 = await http('POST', '/auth/refresh', { body: { refreshToken: t1.refreshToken } });
    assert(r1.status === 200 && r1.json.refreshToken !== t1.refreshToken, `rotate ${r1.status}`);
    const reuse = await http('POST', '/auth/refresh', { body: { refreshToken: t1.refreshToken } });
    assert(reuse.status === 401, `reuse → ${reuse.status}`);
    const after = await http('POST', '/auth/refresh', { body: { refreshToken: r1.json.refreshToken } });
    assert(after.status === 401, `new token after reuse detection → ${after.status} (session not revoked)`);
    const me = await http('GET', '/api/v1/user/me', { token: r1.json.accessToken });
    return `reuse ${reuse.status} ${reuse.json?.code}; rotated token now ${after.status}; access token of revoked session → ${me.status}`;
  });

  await check('rest: logout invalidates the refresh token (and access token)', async () => {
    const l = await http('POST', '/auth/login', { body: { email: B, password: c.userB } });
    const out = await http('POST', '/auth/logout', { body: { refreshToken: l.json.refreshToken }, token: l.json.accessToken });
    assert(out.status === 200, `logout ${out.status}`);
    const r = await http('POST', '/auth/refresh', { body: { refreshToken: l.json.refreshToken } });
    assert(r.status === 401, `refresh after logout → ${r.status}`);
    const me = await http('GET', '/api/v1/user/me', { token: l.json.accessToken });
    assert(me.status === 401, `access token still valid after logout (${me.status})`);
    const ap = await http('POST', '/auth/app-passwords', { token: l.json.accessToken, body: { name: 'after-logout' } });
    assert(ap.status === 401, `app password created with a logged-out access token (${ap.status})`);
    return 'refresh 401, access 401, app-password API 401';
  });

  const tok = await session(state, 'b', B, c.userB);
  let inbox;
  await check('rest: message list paging (limit/offset/total)', async () => {
    const f = await http('GET', '/api/v1/mail/folders', { token: tok });
    inbox = (f.json?.folders ?? f.json).find((x) => x.name === 'INBOX');
    const p1 = await http('GET', `/api/v1/mail/folders/${inbox.id}/messages?limit=2&offset=0`, { token: tok });
    const p2 = await http('GET', `/api/v1/mail/folders/${inbox.id}/messages?limit=2&offset=2`, { token: tok });
    assert(p1.status === 200 && p1.json.messages.length === 2, `p1 ${p1.status} ${p1.json?.messages?.length}`);
    const ids1 = p1.json.messages.map((m) => m.id), ids2 = p2.json.messages.map((m) => m.id);
    assert(ids2.length > 0 && !ids2.some((i) => ids1.includes(i)), 'pages overlap/empty');
    assert(p1.json.total >= 4, `total ${p1.json.total}`);
    return `total ${p1.json.total}, pages disjoint`;
  });

  await check('rest: attachment download GET /api/v1/mail/attachments/:id', async () => {
    const q = await http('GET', `/api/v1/mail/search?q=${encodeURIComponent(state.a2b.subject)}`, { token: tok });
    const list = q.json?.messages ?? q.json ?? [];
    assert(list.length, `search ${q.status}`);
    const m = await http('GET', `/api/v1/mail/messages/${list[0].id}`, { token: tok });
    const att = m.json.attachments.find((a) => a.filename === 'e2e-data.bin');
    assert(att, 'attachment not listed');
    const r = await http('GET', `/api/v1/mail/attachments/${att.id}`, { token: tok, raw: true });
    const body = Buffer.from(await r.arrayBuffer());
    const sha = createHash('sha256').update(body).digest('hex');
    assert(r.status === 200, `${r.status}`);
    assert(sha === state.a2b.attSha256, `content mismatch (${body.length} B)`);
    const cd = r.headers.get('content-disposition') ?? '';
    assert(/^attachment;/.test(cd) && /e2e-data\.bin/.test(cd), `Content-Disposition ${cd}`);
    assert(r.headers.get('x-content-type-options') === 'nosniff', 'nosniff missing');
    const noauth = await http('GET', `/api/v1/mail/attachments/${att.id}`);
    // another (non-MFA) user — A may already have TOTP from an earlier mfa step
    const a = await session(state, 'helpdesk', state.users.helpdesk.email, c.helpdesk);
    const other = await http('GET', `/api/v1/mail/attachments/${att.id}`, { token: a });
    assert(noauth.status === 401 && other.status === 404, `no auth ${noauth.status}, other user ${other.status}`);
    state.attachmentId = att.id;
    return `${body.length} B sha ok; ${r.headers.get('content-type')}; ${cd}; unauth 401, other user 404`;
  });

  await check('rest: /EWS, /OAB → 404 (GET + POST)', async () => {
    const out = [];
    for (const p of ['/EWS/Exchange.asmx', '/ews/exchange.asmx', '/OAB/oab.xml']) {
      for (const m of ['GET', 'POST']) {
        const r = await http(m, p, { body: m === 'POST' ? '<x/>' : undefined, headers: { 'Content-Type': 'text/xml' } });
        out.push(`${m} ${p} ${r.status}`);
        assert(r.status === 404, `${m} ${p} → ${r.status}`);
      }
    }
    return 'all 404';
  });

  await check('rest: security headers on SPA and API responses', async () => {
    const spa = await http('GET', '/');
    const api = await http('GET', '/api/v1/user/me', { token: tok });
    const need = ['content-security-policy', 'x-content-type-options', 'referrer-policy'];
    const miss = [];
    for (const [name, r] of [['/', spa], ['/api', api]]) for (const h of need) if (!r.headers.get(h)) miss.push(`${name}:${h}`);
    const frame = spa.headers.get('x-frame-options') ?? (/frame-ancestors/.test(spa.headers.get('content-security-policy') ?? '') ? 'csp frame-ancestors' : null);
    if (!frame) miss.push('/:x-frame-options');
    assert(miss.length === 0, `missing ${miss.join(', ')}`);
    assert(!spa.headers.get('x-powered-by'), 'X-Powered-By leaked');
    return `CSP, nosniff, ${spa.headers.get('referrer-policy')}, frame=${frame}, no X-Powered-By`;
  });

  await check('rest: /api/v1/user/me returns identity', async () => {
    const r = await http('GET', '/api/v1/user/me', { token: tok });
    assert(r.status === 200 && r.json?.email === B, `${r.status} ${r.text.slice(0, 200)}`);
    return Object.keys(r.json).join(',');
  });
}
