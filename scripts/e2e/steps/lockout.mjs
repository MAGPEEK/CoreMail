// Step 12: brute-force lockout on IMAP (account lock after repeated failures), cleared via Redis.
import { check, assert, creds, clearMailAuthLocks, redisCli } from '../lib.mjs';
import { imapLogin } from './imap.mjs';

export async function run(state) {
  const c = creds();
  const B = state.users.b.email;
  await check('lockout: repeated wrong IMAP passwords lock the account temporarily', async () => {
    const results = [];
    for (let i = 0; i < 12; i++) {
      const s = await imapLogin(B, `wrong-${i}-password`);
      results.push(s.loginResult.text.replace(/^T\d+ /, ''));
      s.close();
    }
    const ok = await imapLogin(B, c.userB);
    const okText = ok.loginResult.text;
    ok.close();
    assert(!/^T\d+ OK/.test(okText), `correct password accepted while locked: ${okText}`);
    const keys = redisCli(['--scan', '--pattern', 'mailauth:*:lock:*']).trim().split('\n').filter(Boolean);
    const ttl = keys.length ? redisCli(['ttl', keys[0]]).trim() : 'n/a';
    return `after 12 failures correct password → "${okText.replace(/^T\d+ /, '')}"; lock keys ${keys.length}, ttl ${ttl}s; last failure: "${results.at(-1)}"`;
  });
  await check('lockout: cleared via Redis → login works again', async () => {
    const n = clearMailAuthLocks();
    const ok = await imapLogin(B, c.userB);
    const t = ok.loginResult;
    ok.close();
    assert(t.status === 'OK', t.text);
    return `${n} keys removed, LOGIN OK`;
  });
}
