/**
 * TOTP verification (RFC 6238, SHA-1, 6 digits, 30 s — the parameters the
 * auth-service setup uses) with replay protection: each time step can be used
 * only once per user (`UserMfa.totpLastUsedStep`, conditional update).
 */
import { createHmac } from 'node:crypto';
import { prisma } from '../prisma/index.js';
import { decryptMfaSecret, encryptMfaSecret } from './mfa-crypto.js';
import { publishUserAuthChange } from './invalidation.js';

const PERIOD = 30;
const DIGITS = 6;

export function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(key: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / PERIOD);
}

/** Generates the code for a base32 secret at a time (used by tests/tools). */
export function totpCode(secretBase32: string, nowMs = Date.now()): string {
  return hotp(base32Decode(secretBase32), currentStep(nowMs));
}

/**
 * Returns the matching time step (±window) or null. Steps ≤ lastUsedStep are
 * rejected (replay). Comparison is constant-time per candidate.
 */
export function matchTotpStep(
  secretBase32: string,
  code: string,
  opts: { nowMs?: number; window?: number; lastUsedStep?: number | null } = {},
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  let key: Buffer;
  try { key = base32Decode(secretBase32); } catch { return null; }
  const now = currentStep(opts.nowMs ?? Date.now());
  const window = opts.window ?? 1;
  let found: number | null = null;
  for (let s = now - window; s <= now + window; s++) {
    const candidate = hotp(key, s);
    let diff = 0;
    for (let i = 0; i < DIGITS; i++) diff |= candidate.charCodeAt(i) ^ code.charCodeAt(i);
    if (diff === 0 && found === null) found = s;
  }
  if (found === null) return null;
  if (opts.lastUsedStep !== null && opts.lastUsedStep !== undefined && found <= opts.lastUsedStep) return null;
  return found;
}

/**
 * Verifies a TOTP code for a user and atomically records the used step.
 * `requireEnabled=false` is for confirming a freshly set-up (pending) secret;
 * on success it also enables TOTP.
 */
export async function verifyUserTotp(
  userId: string,
  code: string,
  opts: { requireEnabled?: boolean; nowMs?: number } = {},
): Promise<boolean> {
  const requireEnabled = opts.requireEnabled ?? true;
  const mfa = await prisma.userMfa.findUnique({ where: { userId } });
  if (!mfa?.totpSecret) return false;
  if (requireEnabled && !mfa.totpEnabled) return false;
  const dec = decryptMfaSecret(mfa.totpSecret);
  if (!dec) return false;
  const step = matchTotpStep(dec.secret, code.trim(), {
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
    lastUsedStep: mfa.totpLastUsedStep ?? null,
  });
  if (step === null) return false;

  // Conditional update: only one request can claim this step (replay / race).
  const claimed = await prisma.userMfa.updateMany({
    where: {
      userId,
      totpSecret: mfa.totpSecret,
      OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }],
    },
    data: {
      totpLastUsedStep: step,
      ...(dec.needsReencrypt ? { totpSecret: encryptMfaSecret(dec.secret) } : {}),
      ...(!requireEnabled ? { totpEnabled: true } : {}),
    },
  });
  // v7.1.0: enabling TOTP makes the primary password invalid for mail
  // protocols — cached mail logins (JMAP) must be dropped immediately.
  if (claimed.count === 1 && !requireEnabled && !mfa.totpEnabled) await publishUserAuthChange(userId, 'mfa-change');
  return claimed.count === 1;
}
