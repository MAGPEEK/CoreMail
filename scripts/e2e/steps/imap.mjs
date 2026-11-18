// Step 4: IMAP 143 (STARTTLS) + 993.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { check, assert, creds, PORTS, STATE_DIR, imapOpen, imapCmd, imapQuote, waitFor, http, session } from '../lib.mjs';

export async function imapLogin(user, pass, { implicitTls = false } = {}) {
  const c = await imapOpen(implicitTls ? PORTS.imaps : PORTS.imap, { implicitTls });
  if (!implicitTls) {
    const st = await imapCmd(c, 'STARTTLS');
    if (st.status !== 'OK') throw new Error(`STARTTLS: ${st.text}`);
    await c.startTls();
  }
  const r = await imapCmd(c, `LOGIN ${imapQuote(user)} ${imapQuote(pass)}`);
  c.loginResult = r;
  return c;
}

export async function run(state) {
  const c = creds();
  const B = state.users.b.email;
  const sentRaw = readFileSync(join(STATE_DIR, 'a2b.eml'));

  await check('imap143: LOGIN before STARTTLS refused (PRIVACYREQUIRED)', async () => {
    const s = await imapOpen(PORTS.imap);
    try {
      const cap = await imapCmd(s, 'CAPABILITY');
      const capLine = cap.lines.find((l) => l.startsWith('* CAPABILITY')) ?? '';
      const r = await imapCmd(s, `LOGIN ${imapQuote(B)} ${imapQuote(c.userB)}`);
      assert(r.status === 'NO' || r.status === 'BAD', r.text);
      assert(/PRIVACYREQUIRED/.test(r.text), `no PRIVACYREQUIRED: ${r.text}`);
      return `LOGINDISABLED=${/LOGINDISABLED/.test(capLine)} STARTTLS=${/STARTTLS/.test(capLine)}; ${r.text}`;
    } finally { s.close(); }
  });

  const s = await imapLogin(B, c.userB);
  try {
    await check('imap143: STARTTLS + LOGIN as B', async () => { assert(s.loginResult.status === 'OK', s.loginResult.text); return s.loginResult.text; });
    const caps = (await imapCmd(s, 'CAPABILITY')).lines.find((l) => l.startsWith('* CAPABILITY')) ?? '';
    state.imapCaps = caps;

    let uid;
    await check('imap: SELECT INBOX + SEARCH SUBJECT finds the A→B mail', async () => {
      const sel = await imapCmd(s, 'SELECT INBOX');
      assert(sel.status === 'OK', sel.text);
      const r = await waitFor(async () => {
        const x = await imapCmd(s, `UID SEARCH SUBJECT ${imapQuote(state.a2b.subject)}`);
        const ids = (x.lines.find((l) => l.startsWith('* SEARCH')) ?? '').split(' ').slice(2).filter(Boolean);
        return ids.length ? ids : null;
      }, { timeout: 30000, what: 'A→B mail in INBOX' });
      uid = r.at(-1);
      const seq = await imapCmd(s, `SEARCH SUBJECT ${imapQuote(state.a2b.subject)}`);
      const seqIds = (seq.lines.find((l) => l.startsWith('* SEARCH')) ?? '').split(' ').slice(2).filter(Boolean);
      assert(seqIds.length >= 1, 'non-UID SEARCH found nothing');
      return `UID ${uid} (${sel.lines.find((l) => /EXISTS/.test(l))})`;
    });
    state.imapUid = uid;

    await check('imap: UID FETCH BODY[] equals the submitted raw message', async () => {
      const r = await imapCmd(s, `UID FETCH ${uid} (BODY.PEEK[] RFC822.SIZE)`);
      assert(r.status === 'OK' && r.literals.length, r.text);
      const got = r.literals[0];
      const size = +(r.lines.join(' ').match(/RFC822\.SIZE (\d+)/)?.[1] ?? -1);
      const exact = got.equals(sentRaw);
      const suffix = got.subarray(got.length - sentRaw.length).equals(sentRaw);
      const prefixHeaders = suffix && !exact ? got.subarray(0, got.length - sentRaw.length).toString('latin1') : '';
      state.imapRawSha256 = createHash('sha256').update(got).digest('hex');
      assert(exact || suffix, `BODY[] (${got.length} B) differs from sent message (${sentRaw.length} B)`);
      assert(size === got.length, `RFC822.SIZE ${size} != literal ${got.length}`);
      return exact ? `byte-identical (${got.length} B)` : `sent bytes identical; server prepended ${prefixHeaders.split('\r\n').filter(Boolean).map((l) => l.split(':')[0]).join(', ')}`;
    });

    await check('imap: BODYSTRUCTURE shows the attachment', async () => {
      const r = await imapCmd(s, `UID FETCH ${uid} (BODYSTRUCTURE)`);
      const line = r.lines.join(' ');
      assert(/"e2e-data\.bin"/i.test(line), `no filename in ${line.slice(0, 400)}`);
      assert(/"BASE64"/i.test(line), 'no BASE64 part');
      assert(/"MIXED"/i.test(line), 'not multipart/mixed');
      return line.match(/\("APPLICATION".*?\)\)/i)?.[0]?.slice(0, 160) ?? 'ok';
    });

    await check('imap: BODY[2] attachment decodes to the original bytes', async () => {
      const r = await imapCmd(s, `UID FETCH ${uid} (BODY.PEEK[2])`);
      const b64 = r.literals[0]?.toString('latin1') ?? '';
      const data = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
      const sha = createHash('sha256').update(data).digest('hex');
      assert(sha === state.a2b.attSha256, `sha mismatch (${data.length} B)`);
      return `${data.length} B, sha256 ok`;
    });

    await check('imap: UID STORE +FLAGS (\\Flagged) persists', async () => {
      const r = await imapCmd(s, `UID STORE ${uid} +FLAGS (\\Flagged)`);
      assert(r.status === 'OK', r.text);
      const f = await imapCmd(s, `UID FETCH ${uid} (FLAGS)`);
      const line = f.lines.find((l) => /FETCH/.test(l)) ?? '';
      assert(/\\Flagged/.test(line), line);
      return line;
    });

    // 9.4: \Flagged is the boolean view of the follow-up flag — set via IMAP, visible in REST
    await check('imap→rest: \\Flagged set via IMAP is a follow-up flag in /api/v1/mail/follow-up', async () => {
      const tok = await session(state, 'b', B, c.userB);
      const r = await waitFor(async () => {
        const x = await http('GET', '/api/v1/mail/follow-up?status=flagged', { token: tok });
        return x.status === 200 && x.json.some((m) => m.subject === state.a2b.subject) ? x : null;
      }, { what: 'IMAP flag in REST follow-up list' });
      const item = r.json.find((m) => m.subject === state.a2b.subject);
      assert(item.flagStatus === 'flagged', JSON.stringify(item));
      return `flagStatus=${item.flagStatus} (${item.folderName})`;
    });

    await check('imap: SEARCH FLAGGED / UNSEEN / FROM / BODY / LARGER', async () => {
      const out = {};
      for (const crit of ['FLAGGED', 'UNSEEN', `FROM ${imapQuote('alice')}`, `BODY ${imapQuote('see attachment')}`, 'LARGER 20000', 'SINCE 1-Jan-2020']) {
        const r = await imapCmd(s, `UID SEARCH ${crit}`);
        const ids = (r.lines.find((l) => l.startsWith('* SEARCH')) ?? '').split(' ').slice(2).filter(Boolean);
        out[crit.split(' ')[0]] = r.status === 'OK' ? ids.includes(uid) : `ERR ${r.text}`;
      }
      const missing = Object.entries(out).filter(([k, v]) => v !== true && k !== 'UNSEEN');
      assert(missing.length === 0, JSON.stringify(out));
      return JSON.stringify(out);
    });

    await check('imap: STATUS INBOX (MESSAGES UIDNEXT SIZE)', async () => {
      const r = await imapCmd(s, 'STATUS INBOX (MESSAGES UIDNEXT UNSEEN SIZE)');
      const line = r.lines.find((l) => l.startsWith('* STATUS')) ?? r.text;
      assert(r.status === 'OK', r.text);
      const size = +(line.match(/SIZE (\d+)/)?.[1] ?? 0);
      assert(size > 0, `SIZE=${size}: ${line}`);
      return line;
    });

    await check('imap: UID MOVE to Archive returns COPYUID, message has new UID', async () => {
      const r = await imapCmd(s, `UID MOVE ${uid} Archive`);
      assert(r.status === 'OK', r.text);
      const all = r.lines.join('\n');
      const cu = all.match(/COPYUID (\d+) ([\d:,]+) ([\d:,]+)/);
      assert(cu, `no COPYUID in ${all}`);
      const ex = await imapCmd(s, `UID FETCH ${uid} (FLAGS)`);
      assert(!ex.lines.some((l) => /^\* \d+ FETCH/.test(l)), `message still in INBOX: ${ex.lines.join(' | ')}`);
      const sel = await imapCmd(s, 'EXAMINE Archive');
      assert(sel.status === 'OK', sel.text);
      const f = await imapCmd(s, `UID FETCH ${cu[3]} (FLAGS BODY.PEEK[HEADER.FIELDS (SUBJECT)])`);
      const fl = f.lines.find((l) => /^\* \d+ FETCH/.test(l));
      assert(fl, `new UID ${cu[3]} not in Archive`);
      assert(/\\Flagged/.test(fl), `flags not preserved by MOVE: ${fl}`);
      state.archiveUid = cu[3];
      return `COPYUID ${cu[1]} ${cu[2]} ${cu[3]}, \\Flagged preserved`;
    });

    await check('imap: APPEND with literal (APPENDUID) round-trips byte-exact', async () => {
      const msg = Buffer.from(`From: ${B}\r\nTo: ${B}\r\nSubject: E2E append ${Date.now()}\r\nMessage-ID: <append-${Date.now()}@e2e.test>\r\nDate: ${new Date().toUTCString()}\r\n\r\nappended body äöü\r\n`, 'utf8');
      const r = await imapCmd(s, 'APPEND Drafts (\\Draft \\Seen)', { literal: msg });
      assert(r.status === 'OK', r.text);
      const au = r.text.match(/APPENDUID (\d+) (\d+)/);
      assert(au, `no APPENDUID: ${r.text}`);
      await imapCmd(s, 'EXAMINE Drafts');
      const f = await imapCmd(s, `UID FETCH ${au[2]} (FLAGS BODY.PEEK[])`);
      const got = f.literals[0];
      assert(got && got.equals(msg), `APPENDed message differs (${got?.length} vs ${msg.length})`);
      const flags = f.lines.find((l) => /FLAGS/.test(l)) ?? '';
      assert(/\\Draft/.test(flags), `flags ${flags}`);
      return `APPENDUID ${au[1]} ${au[2]}, byte-identical, ${flags.match(/FLAGS \([^)]*\)/)?.[0]}`;
    });

    await check('imap: LIST shows special-use folders', async () => {
      const r = await imapCmd(s, 'LIST "" "*"');
      const names = r.lines.filter((l) => l.startsWith('* LIST')).map((l) => l.replace(/^\* LIST /, ''));
      assert(names.some((n) => /\\Sent/.test(n)) && names.some((n) => /\\Trash/.test(n)), names.join(' | '));
      return `${names.length} folders`;
    });

    await check('imap: DELETE of a folder with mail — the messages go to Trash, inferior names stay', async () => {
      const name = `E2E-Del-${Date.now()}`;
      for (const n of [name, `${name}.Sub`]) {
        const cr = await imapCmd(s, `CREATE ${imapQuote(n)}`);
        assert(cr.status === 'OK', `CREATE ${n}: ${cr.text}`);
      }
      const subject = `E2E delete-to-trash ${Date.now()}`;
      const msg = Buffer.from(`From: ${B}\r\nTo: ${B}\r\nSubject: ${subject}\r\nMessage-ID: <del-${Date.now()}@e2e.test>\r\nDate: ${new Date().toUTCString()}\r\n\r\nbody\r\n`, 'utf8');
      const ap = await imapCmd(s, `APPEND ${imapQuote(name)}`, { literal: msg });
      assert(ap.status === 'OK', `APPEND: ${ap.text}`);
      const del = await imapCmd(s, `DELETE ${imapQuote(name)}`);
      assert(del.status === 'OK', `DELETE: ${del.text}`);
      const list = (await imapCmd(s, 'LIST "" "*"')).lines.join('\n');
      assert(list.includes(`${name}.Sub`), 'inferior name removed');
      await imapCmd(s, 'EXAMINE Trash');
      const found = await imapCmd(s, `UID SEARCH SUBJECT ${imapQuote(subject)}`);
      const uids = (found.lines.find((l) => l.startsWith('* SEARCH')) ?? '').replace('* SEARCH', '').trim();
      assert(uids.length > 0, `message not in Trash: ${found.lines.join(' | ')}`);
      await imapCmd(s, 'CLOSE');
      assert((await imapCmd(s, `DELETE ${imapQuote(`${name}.Sub`)}`)).status === 'OK', 'cleanup');
      return `Trash UID ${uids}, ${name}.Sub kept`;
    });
    await imapCmd(s, 'LOGOUT');
  } finally { s.close(); }

  await check('imap993: implicit TLS LOGIN + SELECT', async () => {
    const t = await imapLogin(B, c.userB, { implicitTls: true });
    try {
      assert(t.loginResult.status === 'OK', t.loginResult.text);
      const sel = await imapCmd(t, 'SELECT INBOX');
      assert(sel.status === 'OK', sel.text);
      return 'OK';
    } finally { t.close(); }
  });
}
