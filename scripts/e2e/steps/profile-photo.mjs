// Step (9.5): profile photos — user A uploads a PNG carrying EXIF/GPS metadata; the stored
// photo is a 512×512 JPEG without any metadata; user B (same domain) can GET it and finds it
// through the batched address lookup; ETag revalidation answers 304; a JPEG scan bomb is refused (415);
// A removes it → 404;
// an admin removes a re-uploaded photo (DELETE /admin/mailboxes/:id/photo) → 404 again.
// 10.1: the webmail background — upload (≤ 2560 px JPEG, metadata stripped), own-only GET + ETag,
// preference "custom", DELETE.
import { check, assert, creds, http, session, makePng, pngChunk } from '../lib.mjs';

/** JPEG segment markers before the scan (FFxx second bytes). */
function jpegMarkers(buf) {
  const out = [];
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const m = buf[i + 1];
    out.push(m);
    if (m === 0xda) break;
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return out;
}

/** Width × height from the SOF0 / SOF2 segment of a JPEG. */
function jpegSize(buf) {
  let i = 2;
  while (i + 9 <= buf.length && buf[i] === 0xff) {
    const m = buf[i + 1];
    if (m === 0xc0 || m === 0xc2) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/** JPEG marker segment with its length. */
function segment(marker, body) {
  const h = Buffer.from([0xff, marker, 0, 0]);
  h.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([h, body]);
}

/** Progressive 2048×2048 JPEG of `scans` tiny end-of-band AC scans (each walks the whole frame when decoded). */
function scanBombJpeg(scans) {
  const lengths = Buffer.alloc(16);
  lengths[0] = 1;
  const dht = segment(0xc4, Buffer.concat([Buffer.from([0x10]), lengths, Buffer.from([0xe0])]));
  const bits = ('0' + '1'.repeat(14)).repeat(3).padEnd(48, '1');
  const data = Buffer.from(bits.match(/.{8}/g).flatMap((b) => (b === '11111111' ? [0xff, 0x00] : [parseInt(b, 2)])));
  const scan = Buffer.concat([segment(0xda, Buffer.from([1, 1, 0x00, 1, 63, 0])), data]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), segment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
    segment(0xc2, Buffer.from([8, 0x08, 0x00, 0x08, 0x00, 1, 1, 0x11, 0])), dht,
    ...Array.from({ length: scans }, () => scan), Buffer.from([0xff, 0xd9]),
  ]);
}

async function getPhoto(token, userId, headers = {}) {
  const res = await http('GET', `/api/v1/users/${userId}/photo`, { token, raw: true, headers });
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
}

export async function run(state) {
  assert(state.users?.a?.id && state.users?.b?.id, 'needs the users step (users A + B)');
  const c = creds();
  const admin = await session(state, 'admin', state.adminEmail, c.admin);
  const A = await session(state, 'a', state.users.a.email, c.userA);
  const B = await session(state, 'b', state.users.b.email, c.userB);
  const aId = state.users.a.id;
  // eXIf chunk with a GPS marker: must never reach the stored photo
  const exif = pngChunk('eXIf', Buffer.from('MM\0*GPSLatitude=48.1 Make=E2E-Cam', 'latin1'));
  const png = makePng(640, 480, [30, 120, 200], [exif]);
  const upload = () => http('PUT', '/api/v1/user/photo', { token: A, body: png, headers: { 'Content-Type': 'image/png' } });
  let etag = '';

  await check('profile photo: upload PNG → stored as JPEG, version returned', async () => {
    const r = await upload();
    assert(r.status === 200 && r.json?.photo?.userId === aId && /^[0-9a-f]{16}$/.test(r.json.photo.version ?? ''), `${r.status} ${r.text.slice(0, 200)}`);
    const profile = await http('GET', '/api/v1/user/profile', { token: A });
    assert(profile.json?.photo?.version === r.json.photo.version, `profile ${JSON.stringify(profile.json?.photo)}`);
    return `version ${r.json.photo.version}`;
  });

  await check('profile photo: GET is a 512×512 JPEG without EXIF / GPS, private cache + ETag', async () => {
    const g = await getPhoto(A, aId);
    assert(g.status === 200, `status ${g.status}`);
    assert(g.headers.get('content-type') === 'image/jpeg', `type ${g.headers.get('content-type')}`);
    assert(g.buf[0] === 0xff && g.buf[1] === 0xd8, 'JPEG magic bytes');
    const size = jpegSize(g.buf);
    assert(size?.width === 512 && size?.height === 512, `size ${JSON.stringify(size)}`);
    assert(!jpegMarkers(g.buf).includes(0xe1), 'no APP1 (EXIF) segment');
    assert(!g.buf.includes(Buffer.from('GPSLatitude')) && !g.buf.includes(Buffer.from('Exif')), 'metadata stripped');
    assert(/private/.test(g.headers.get('cache-control') ?? ''), `cache-control ${g.headers.get('cache-control')}`);
    etag = g.headers.get('etag') ?? '';
    assert(/^"[0-9a-f]{64}"$/.test(etag), `etag ${etag}`);
  });

  await check('profile photo: another user of the organisation can GET it (and revalidate → 304)', async () => {
    const g = await getPhoto(B, aId);
    assert(g.status === 200 && g.headers.get('etag') === etag, `status ${g.status} etag ${g.headers.get('etag')}`);
    const again = await getPhoto(B, aId, { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' });
    assert(again.status === 304, `revalidation ${again.status}`);
    const anon = await getPhoto(undefined, aId);
    assert(anon.status === 401, `anonymous ${anon.status}`);
  });

  await check('profile photo: batched address lookup finds A, not unknown addresses', async () => {
    const r = await http('POST', '/api/v1/users/photos/lookup', { token: B, body: { addresses: [state.users.a.email.toUpperCase(), 'nobody@unknown.invalid'] } });
    assert(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    const entry = r.json.photos?.[state.users.a.email.toLowerCase()];
    assert(entry?.userId === aId, JSON.stringify(r.json));
    assert(Object.keys(r.json.photos).length === 1, 'only internal addresses with a photo');
  });

  await check('profile photo: wrong type refused (415), nothing changes', async () => {
    const r = await http('PUT', '/api/v1/user/photo', { token: A, body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), headers: { 'Content-Type': 'image/png' } });
    assert(r.status === 415 && r.json?.code === 'TYPE', `${r.status} ${r.text.slice(0, 200)}`);
    assert((await getPhoto(B, aId)).status === 200, 'old photo still there');
  });

  await check('profile photo: JPEG scan bomb refused before decoding (415 UNSUPPORTED)', async () => {
    const t0 = Date.now();
    const r = await http('PUT', '/api/v1/user/photo', { token: A, body: scanBombJpeg(2000), headers: { 'Content-Type': 'image/jpeg' } });
    assert(r.status === 415 && r.json?.code === 'UNSUPPORTED', `${r.status} ${r.text.slice(0, 200)}`);
    return `${Date.now() - t0} ms`;
  });

  await check('profile photo: DELETE by the owner → 404 for everyone', async () => {
    const d = await http('DELETE', '/api/v1/user/photo', { token: A });
    assert(d.status === 200 && d.json?.removed === true, `${d.status} ${d.text.slice(0, 200)}`);
    assert((await getPhoto(B, aId)).status === 404, 'B still sees it');
    assert((await getPhoto(A, aId)).status === 404, 'A still sees it');
  });

  await check('profile photo: admin removes a photo (BCP) → 404', async () => {
    assert((await upload()).status === 200, 're-upload');
    const view = await http('GET', `/api/v1/admin/mailboxes/${aId}/photo`, { token: admin, raw: true });
    assert(view.status === 200, `admin view ${view.status}`);
    const d = await http('DELETE', `/api/v1/admin/mailboxes/${aId}/photo`, { token: admin });
    assert(d.status === 200 && d.json?.removed === true, `${d.status} ${d.text.slice(0, 200)}`);
    assert((await getPhoto(B, aId)).status === 404, 'photo still served');
  });

  // ── 10.1: webmail background (same image pipeline, own user only) ───────────
  const getBackground = async (token, headers = {}) => {
    const res = await http('GET', '/api/v1/user/background', { token, raw: true, headers });
    return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
  };

  await check('background: upload a wide PNG → JPEG of at most 2560 px, no metadata, private + ETag', async () => {
    const wide = makePng(3000, 1000, [40, 90, 160], [exif]);
    const r = await http('PUT', '/api/v1/user/background', { token: A, body: wide, headers: { 'Content-Type': 'image/png' } });
    assert(r.status === 200 && /^[0-9a-f]{16}$/.test(r.json?.background?.version ?? ''), `${r.status} ${r.text.slice(0, 200)}`);
    const g = await getBackground(A);
    assert(g.status === 200 && g.headers.get('content-type') === 'image/jpeg', `${g.status} ${g.headers.get('content-type')}`);
    const size = jpegSize(g.buf);
    assert(size?.width === 2560 && size?.height === 853, `size ${JSON.stringify(size)}`);
    assert(!jpegMarkers(g.buf).includes(0xe1) && !g.buf.includes(Buffer.from('GPSLatitude')), 'metadata stripped');
    assert(/private/.test(g.headers.get('cache-control') ?? ''), `cache-control ${g.headers.get('cache-control')}`);
    const etag = g.headers.get('etag') ?? '';
    const again = await getBackground(A, { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' });
    assert(again.status === 304, `revalidation ${again.status}`);
    const info = await http('GET', '/api/v1/user/background/info', { token: A });
    assert(info.json?.background?.version === r.json.background.version, JSON.stringify(info.json));
  });

  await check('background: only the owner — B gets none, anonymous 401; preference "custom" roams', async () => {
    assert((await getBackground(B)).status === 404, 'B must not see A\'s background');
    assert((await getBackground(undefined)).status === 401, 'anonymous');
    const p = await http('PATCH', '/api/v1/user/preferences', { token: A, body: { preferences: { appearance: { background: 'custom' } } } });
    assert(p.status === 200 && p.json?.preferences?.appearance?.background === 'custom', `${p.status} ${p.text.slice(0, 200)}`);
    const bad = await http('PATCH', '/api/v1/user/preferences', { token: A, body: { preferences: { appearance: { background: 'builtin:photo' } } } });
    assert(bad.status === 400, `invalid built-in accepted: ${bad.status}`);
  });

  await check('background: DELETE → 404, info null', async () => {
    const d = await http('DELETE', '/api/v1/user/background', { token: A });
    assert(d.status === 200 && d.json?.removed === true, `${d.status} ${d.text.slice(0, 200)}`);
    assert((await getBackground(A)).status === 404, 'still served');
    const info = await http('GET', '/api/v1/user/background/info', { token: A });
    assert(info.json?.background === null, JSON.stringify(info.json));
  });
}
