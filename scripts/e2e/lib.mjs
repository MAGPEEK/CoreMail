// Shared helpers for the CoreMail e2e runner (Node 22, no dependencies).
import net from 'node:net';
import tls from 'node:tls';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';

export const HOST = process.env.E2E_HOST ?? '127.0.0.1';
export const PORTS = {
  smtp: +(process.env.E2E_SMTP_PORT ?? 12525),
  submission: +(process.env.E2E_SUBMISSION_PORT ?? 12587),
  smtps: +(process.env.E2E_SMTPS_PORT ?? 12465),
  imap: +(process.env.E2E_IMAP_PORT ?? 12143),
  imaps: +(process.env.E2E_IMAPS_PORT ?? 12993),
  pop3: +(process.env.E2E_POP3_PORT ?? 12110),
  pop3s: +(process.env.E2E_POP3S_PORT ?? 12995),
  http: +(process.env.E2E_HTTP_PORT ?? 18080),
  https: +(process.env.E2E_HTTPS_PORT ?? 18443),
  sink: +(process.env.E2E_SINK_PORT ?? 18025),
};
export const BASE = `http://${HOST}:${PORTS.http}`;
export const CONTAINER = process.env.E2E_CONTAINER ?? 'coremail-e2e';
export const DOMAIN = process.env.E2E_DOMAIN ?? 'e2e.test';
/** v7.1 run mode: `minio` (default, MinIO container) or `filesystem` (no MinIO, coremail-data volume). */
export const STORAGE_MODE = process.env.E2E_STORAGE ?? 'minio';
if (!['minio', 'filesystem'].includes(STORAGE_MODE)) { console.error(`E2E_STORAGE must be minio or filesystem (got ${STORAGE_MODE})`); process.exit(2); }

// ── State / credentials (kept OUTSIDE the repo: E2E_STATE_DIR) ───────────────
export const STATE_DIR = process.env.E2E_STATE_DIR;
if (!STATE_DIR) { console.error('E2E_STATE_DIR is required (directory outside the repo)'); process.exit(2); }
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
const stateFile = join(STATE_DIR, 'state.json');
const credFile = join(STATE_DIR, 'credentials.json');

export function loadState() { return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {}; }
export function saveState(s) { writeFileSync(stateFile, JSON.stringify(s, null, 2)); }
export function creds() {
  if (!existsSync(credFile)) {
    const h = (n) => randomBytes(n).toString('hex');
    writeFileSync(credFile, JSON.stringify({
      admin: `Adm-${h(10)}`, userA: `UsA-${h(10)}`, userB: `UsB-${h(10)}`, helpdesk: `Hd-${h(10)}`, userAnew: `UsAn-${h(10)}`,
    }, null, 2));
  }
  return JSON.parse(readFileSync(credFile, 'utf8'));
}
export function setCred(key, value) {
  const c = creds(); c[key] = value; writeFileSync(credFile, JSON.stringify(c, null, 2));
}

// ── Result recording ─────────────────────────────────────────────────────────
const results = [];
export function record(flow, status, note) {
  results.push({ flow, status, note });
  const mark = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : status;
  console.log(`[${mark}] ${flow} — ${note}`);
}
export async function check(flow, fn) {
  try {
    const note = await fn();
    record(flow, 'PASS', note ?? 'ok');
    return true;
  } catch (err) {
    record(flow, 'FAIL', err?.message ?? String(err));
    return false;
  }
}
export function flushResults(name) {
  const file = join(STATE_DIR, `results-${name}.json`);
  writeFileSync(file, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${results.length} checks, ${failed} failed → ${file}`);
  return failed;
}
export function assert(cond, msg) { if (!cond) throw new Error(msg); }

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** One PNG chunk (length, type, data, CRC). */
export function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A real (decodable) RGBA PNG of w×h in one colour; `extra` chunks go before the image data. */
export function makePng(w, h, [r, g, b], extra = []) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b, 255]).flat())]);
  const idat = deflateSync(Buffer.concat(Array.from({ length: h }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), ...extra,
    pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, { timeout = 20000, interval = 500, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

// ── Line-oriented socket client (SMTP/IMAP/POP3) with STARTTLS upgrade ───────
export class LineClient {
  constructor(sock) { this.attach(sock); }
  attach(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.closed = false;
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
    sock.on('close', () => { this.closed = true; this.pump(); });
    sock.on('error', () => { this.closed = true; this.pump(); });
  }
  static connect(port, { implicitTls = false, host = HOST } = {}) {
    return new Promise((resolve, reject) => {
      const s = implicitTls
        ? tls.connect({ host, port, rejectUnauthorized: false, servername: 'mail.' + DOMAIN }, () => resolve(new LineClient(s)))
        : net.connect({ host, port }, () => resolve(new LineClient(s)));
      s.once('error', reject);
      s.setTimeout?.(30000);
    });
  }
  pump() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      const r = w.take(this.buf, this.closed);
      if (r === undefined) return;
      this.waiters.shift();
      clearTimeout(w.timer);
      this.buf = this.buf.subarray(r.consumed);
      if (r.error) w.reject(r.error); else w.resolve(r.value);
    }
  }
  wait(take, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const w = { take, resolve, reject };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`socket read timeout; buffered: ${JSON.stringify(this.buf.toString('latin1').slice(0, 300))}`));
      }, timeout);
      this.waiters.push(w);
      this.pump();
    });
  }
  /** Reads one CRLF line (without CRLF), as latin1 string. */
  readLine(timeout) {
    return this.wait((buf, closed) => {
      const i = buf.indexOf('\r\n');
      if (i >= 0) return { consumed: i + 2, value: buf.subarray(0, i).toString('latin1') };
      if (closed) return { consumed: buf.length, error: new Error(`connection closed (buffered ${JSON.stringify(buf.toString('latin1'))})`) };
      return undefined;
    }, timeout);
  }
  readBytes(n, timeout) {
    return this.wait((buf, closed) => {
      if (buf.length >= n) return { consumed: n, value: Buffer.from(buf.subarray(0, n)) };
      if (closed) return { consumed: buf.length, error: new Error('connection closed during literal') };
      return undefined;
    }, timeout);
  }
  write(s) { this.sock.write(typeof s === 'string' ? Buffer.from(s, 'latin1') : s); }
  async startTls() {
    const plain = this.sock;
    plain.removeAllListeners('data');
    plain.removeAllListeners('close');
    plain.removeAllListeners('error');
    const t = await new Promise((resolve, reject) => {
      const s = tls.connect({ socket: plain, rejectUnauthorized: false, servername: 'mail.' + DOMAIN }, () => resolve(s));
      s.once('error', reject);
    });
    this.attach(t);
    return t;
  }
  close() { try { this.sock.destroy(); } catch { /* ignore */ } }
}

// ── SMTP ─────────────────────────────────────────────────────────────────────
export async function smtpRead(c) {
  const lines = [];
  for (;;) {
    const l = await c.readLine();
    lines.push(l);
    if (/^\d{3} /.test(l) || /^\d{3}$/.test(l)) break;
  }
  return { code: +lines.at(-1).slice(0, 3), text: lines.join('\n') };
}
export async function smtpCmd(c, cmd) { c.write(cmd + '\r\n'); return smtpRead(c); }
export async function smtpOpen(port, { implicitTls = false, ehlo = 'e2e-client.test' } = {}) {
  const c = await LineClient.connect(port, { implicitTls });
  const greet = await smtpRead(c);
  if (greet.code !== 220) throw new Error(`SMTP greeting ${greet.text}`);
  c.ehloName = ehlo;
  c.ehlo = await smtpCmd(c, `EHLO ${ehlo}`);
  return c;
}
export async function smtpStartTls(c) {
  const r = await smtpCmd(c, 'STARTTLS');
  if (r.code !== 220) throw new Error(`STARTTLS: ${r.text}`);
  await c.startTls();
  c.ehlo = await smtpCmd(c, `EHLO ${c.ehloName}`);
  return c;
}
export async function smtpAuthPlain(c, user, pass) {
  return smtpCmd(c, `AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64')}`);
}
/** Sends DATA (raw is CRLF-normalized Buffer/string). Returns final reply. */
export async function smtpData(c, raw) {
  const d = await smtpCmd(c, 'DATA');
  if (d.code !== 354) return d;
  let body = Buffer.isBuffer(raw) ? raw.toString('latin1') : raw;
  body = body.split('\r\n').map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
  if (!body.endsWith('\r\n')) body += '\r\n';
  c.write(body + '.\r\n');
  return smtpRead(c);
}
export async function smtpSend(c, from, rcpts, raw) {
  const m = await smtpCmd(c, `MAIL FROM:<${from}>`);
  if (m.code !== 250) return { stage: 'MAIL', ...m };
  for (const r of rcpts) {
    const rr = await smtpCmd(c, `RCPT TO:<${r}>`);
    if (rr.code !== 250 && rr.code !== 251) return { stage: 'RCPT', ...rr };
  }
  const d = await smtpData(c, raw);
  return { stage: 'DATA', ...d };
}

// ── IMAP ─────────────────────────────────────────────────────────────────────
let imapTagN = 0;
/** Sends a command; returns { tag, status, text, lines[], literals[] }. Untagged literals are collected. */
export async function imapCmd(c, cmd, { literal } = {}) {
  const tag = `T${++imapTagN}`;
  if (literal !== undefined) {
    const buf = Buffer.isBuffer(literal) ? literal : Buffer.from(literal, 'latin1');
    c.write(`${tag} ${cmd} {${buf.length}}\r\n`);
    const cont = await c.readLine();
    if (!cont.startsWith('+')) return { tag, status: cont.split(' ')[1], text: cont, lines: [cont], literals: [] };
    c.write(buf); c.write('\r\n');
  } else {
    c.write(`${tag} ${cmd}\r\n`);
  }
  return imapReadUntilTag(c, tag);
}
export async function imapReadUntilTag(c, tag) {
  const lines = []; const literals = [];
  for (;;) {
    let l = await c.readLine();
    // Literal(s) at line end: {n}
    let m;
    while ((m = l.match(/\{(\d+)\}$/))) {
      const data = await c.readBytes(+m[1]);
      literals.push(data);
      const rest = await c.readLine();
      l = l + `<literal:${literals.length - 1}>` + rest;
    }
    lines.push(l);
    if (l.startsWith(tag + ' ')) {
      const status = l.slice(tag.length + 1).split(' ')[0];
      return { tag, status, text: l, lines, literals };
    }
  }
}
export async function imapOpen(port, { implicitTls = false } = {}) {
  const c = await LineClient.connect(port, { implicitTls });
  c.greeting = await c.readLine();
  return c;
}
export const imapQuote = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// ── POP3 ─────────────────────────────────────────────────────────────────────
export async function popCmd(c, cmd, { multi = false } = {}) {
  if (cmd !== null) c.write(cmd + '\r\n');
  const first = await c.readLine();
  if (!multi || !first.startsWith('+OK')) return { ok: first.startsWith('+OK'), text: first };
  const lines = [];
  for (;;) {
    const l = await c.readLine();
    if (l === '.') break;
    lines.push(l.startsWith('..') ? l.slice(1) : l);
  }
  return { ok: true, text: first, lines, body: lines.join('\r\n') + (lines.length ? '\r\n' : '') };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
export let rateLimitResets = 0;
/**
 * The api-gateway rate limiters (auth: 20 / 15 min per IP) use the in-memory
 * store — a full e2e run from one IP exceeds them. On a 429 the gateway process
 * is restarted (resets the store) and the request retried once; the count is
 * reported so the run stays honest about it.
 */
export async function resetGatewayRateLimits() {
  rateLimitResets++;
  dockerExec(['supervisorctl', '-c', '/etc/supervisord.conf', 'restart', 'gateway:api-gateway']);
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, { timeout: 30000, what: 'api-gateway restart' });
}
export async function http(method, path, { token, body, headers = {}, raw = false, base = BASE, retry429 = true } = {}) {
  const h = { ...headers };
  if (token) h['Authorization'] = `Bearer ${token}`;
  let payload;
  if (body !== undefined && !(typeof body === 'string' || Buffer.isBuffer(body))) {
    h['Content-Type'] ??= 'application/json';
    payload = JSON.stringify(body);
  } else payload = body;
  let res = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual' });
  if (res.status === 429 && retry429 && base === BASE) {
    console.log(`  (429 on ${method} ${path} — resetting gateway rate limits)`);
    await resetGatewayRateLimits();
    res = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual' });
  }
  if (raw) return res;
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, headers: res.headers, text, json };
}
/**
 * Returns a valid access token for `key` (state.sessions[key]), logging in with
 * `email`/`password` or rotating the stored refresh token when it is about to expire.
 */
export async function session(state, key, email, password) {
  state.sessions ??= {};
  const s = state.sessions[key];
  if (s && s.exp > Date.now() + 60_000) return s.access;
  if (s?.refresh) {
    const r = await http('POST', '/auth/refresh', { body: { refreshToken: s.refresh } });
    if (r.status === 200) {
      state.sessions[key] = { access: r.json.accessToken, refresh: r.json.refreshToken, exp: Date.now() + r.json.expiresIn * 1000 };
      return r.json.accessToken;
    }
  }
  const r = await http('POST', '/auth/login', { body: { email, password } });
  if (r.status !== 200 || !r.json?.accessToken) throw new Error(`login ${email}: ${r.status} ${r.text.slice(0, 200)}`);
  state.sessions[key] = { access: r.json.accessToken, refresh: r.json.refreshToken, exp: Date.now() + r.json.expiresIn * 1000 };
  return r.json.accessToken;
}
export const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`, 'utf8').toString('base64');

/**
 * 9.4: the webmail live stream (GET /api/v1/events via a single-use ticket).
 * `next(name, { timeout, match })` resolves with the data of the next event of
 * that name (events received before the call are searched first).
 */
export async function openSse(token) {
  const t = await http('POST', '/api/v1/events/ticket', { token, body: {} });
  if (t.status !== 200 || !t.json?.ticket) throw new Error(`SSE ticket: ${t.status} ${t.text.slice(0, 200)}`);
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/v1/events?ticket=${encodeURIComponent(t.json.ticket)}`, { signal: ctrl.signal });
  if (res.status !== 200) throw new Error(`SSE stream: ${res.status}`);
  const events = [];
  const waiters = new Set();
  const settle = () => {
    for (const w of [...waiters]) {
      const i = events.findIndex((e) => e.name === w.name && w.match(e.data));
      if (i >= 0) { const [e] = events.splice(i, 1); waiters.delete(w); w.resolve(e.data); }
    }
  };
  void (async () => {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, cut); buf = buf.slice(cut + 2);
          const name = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!name) continue;
          let parsed; try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
          events.push({ name, data: parsed });
        }
        settle();
      }
    } catch { /* aborted */ }
  })();
  return {
    next(name, { timeout = 10_000, match = () => true } = {}) {
      return new Promise((resolve, reject) => {
        const w = { name, match, resolve };
        waiters.add(w);
        settle();
        setTimeout(() => { if (waiters.delete(w)) reject(new Error(`no SSE '${name}' event within ${timeout} ms`)); }, timeout).unref();
      });
    },
    close() { ctrl.abort(); },
  };
}

// ── TOTP (RFC 6238, SHA1, 6 digits, 30 s) ────────────────────────────────────
function base32Decode(s) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = ''; for (const ch of s.replace(/=+$/, '').toUpperCase()) { const v = alpha.indexOf(ch); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); }
  const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export function totp(secret, t = Date.now(), step = 0) {
  const counter = Math.floor(t / 1000 / 30) + step;
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}
/** Waits until the next 30-s window starts (TOTP replay protection: one code per step). */
export async function nextTotpWindow() { const ms = 30000 - (Date.now() % 30000) + 300; await sleep(ms); }

// ── Docker helpers ───────────────────────────────────────────────────────────
export function dockerExec(args, { container = CONTAINER, env = {} } = {}) {
  const e = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return execFileSync('docker', ['exec', ...e, container, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
/** `docker compose` arguments of the e2e stack for the current E2E_STORAGE mode. */
export function composeArgs() {
  const project = process.env.E2E_COMPOSE_PROJECT ?? 'coremail-e2e';
  const envFile = process.env.E2E_ENV_FILE ?? join(STATE_DIR, 'e2e.env');
  return ['compose', '-p', project, '--env-file', envFile, '-f', 'infra/docker/docker-compose.yml', '-f', 'infra/docker/docker-compose.e2e.yml',
    ...(STORAGE_MODE === 'filesystem' ? ['-f', 'infra/docker/docker-compose.e2e-filesystem.yml'] : [])];
}
/** Runs `docker compose <args>` for the e2e stack (extra env, e.g. OBJECT_STORAGE, overrides the env file). */
export function compose(args, { env = {} } = {}) {
  execFileSync('docker', [...composeArgs(), ...args], { stdio: 'inherit', env: { ...process.env, ...env } });
}
export function redisCli(args) {
  const env = readFileSync(process.env.E2E_ENV_FILE ?? join(STATE_DIR, 'e2e.env'), 'utf8');
  const pw = env.match(/^REDIS_PASSWORD=(.*)$/m)?.[1] ?? '';
  return execFileSync('docker', ['exec', 'coremail-e2e-redis', 'redis-cli', '--no-auth-warning', '-a', pw, ...args], { encoding: 'utf8' });
}
export function clearMailAuthLocks() {
  const keys = redisCli(['--scan', '--pattern', 'mailauth:*']).split('\n').map((s) => s.trim()).filter(Boolean);
  if (keys.length) redisCli(['del', ...keys]);
  return keys.length;
}

// ── MIME builder ─────────────────────────────────────────────────────────────
export function buildMime({ from, to, cc, bcc, subject, text, attachment, messageId, extraHeaders = [] }) {
  const boundary = `b_${randomBytes(8).toString('hex')}`;
  const mid = messageId ?? `<${randomBytes(8).toString('hex')}@e2e-client.test>`;
  const h = [
    `From: ${from}`, `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []), ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${subject}`, `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${mid}`, 'MIME-Version: 1.0', ...extraHeaders,
  ];
  if (!attachment) {
    return [...h, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 7bit', '', text, ''].join('\r\n');
  }
  const b64 = attachment.data.toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd();
  return [
    ...h, `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    'This is a multi-part message in MIME format.',
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 7bit', '', text, '',
    `--${boundary}`, `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
    'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${attachment.filename}"`, '',
    b64, `--${boundary}--`, '',
  ].join('\r\n');
}
