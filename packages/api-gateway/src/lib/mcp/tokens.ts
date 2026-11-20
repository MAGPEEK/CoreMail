/**
 * Admin MCP interface (10.3) — personal MCP tokens: create, list, revoke and
 * verify (the bearer check of every /mcp request). Storage side (format, hash,
 * revocation on "revoke all"): @coremail/storage/auth mcp-tokens.ts.
 *
 * Verification, in order (any failure → the token does not work):
 *   format → row by sha256 (unique index; hashes compared in constant time) →
 *   not revoked, not expired → owner active and still an admin (current role
 *   from the database, 15 s cache dropped on every auth event) → no "revoke all"
 *   mark newer than the token (shared Redis marks — covers a lost DB update) →
 *   forced 2FA for admins (the token must come from an MFA-verified session
 *   while requireMfaForAdmins is on).
 */
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import {
  generateMcpToken, hashMcpToken, isAccessTokenRevokedShared, looksLikeMcpToken, publishUserAuthChange,
} from '@coremail/storage/auth';
import { currentAdminState, adminMfaRefusal } from '../../middleware/auth.js';
import { isAdminRole } from '../rbac.js';
import type { AdminScope } from '../admin-scope.js';
import { endSessionsOfToken, mcpSessionKey } from './sessions.js';

const log = createLogger('mcp:tokens');

export const MCP_TOKEN_MODES = ['read', 'write'] as const;
export type McpTokenMode = typeof MCP_TOKEN_MODES[number];
export const MCP_TOKEN_DEFAULT_DAYS = 90;
export const MCP_TOKEN_MAX_DAYS = 365;
/** Active (not revoked, not expired) tokens one admin may hold. */
export const MCP_TOKENS_PER_ADMIN = 20;

/** Columns returned by the token API — never the hash. */
export const TOKEN_PUBLIC_SELECT = {
  id: true, userId: true, name: true, prefix: true, mode: true, mfaVerified: true,
  expiresAt: true, lastUsedAt: true, lastUsedIp: true, createdAt: true, revokedAt: true, revokedReason: true,
} as const;

export interface VerifiedMcpToken {
  tokenId: string;
  tokenName: string;
  userId: string;
  email: string;
  /** Current role of the owner (database). */
  role: string;
  domainId: string;
  mode: McpTokenMode;
  mfaVerified: boolean;
  scope: AdminScope;
}

export type McpTokenCheck =
  | { ok: true; token: VerifiedMcpToken }
  /** unknown / malformed: a guess (counted against the client IP); the rest: a known token that no longer works. */
  | { ok: false; reason: 'malformed' | 'unknown' | 'revoked' | 'expired' | 'inactive' | 'not-admin' }
  | { ok: false; reason: 'mfa'; code: 'MFA_REQUIRED' | 'MFA_NOT_VERIFIED'; error: string };

const equalHex = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

/** Throttle of the lastUsedAt / lastUsedIp write (per token, in process). */
const TOUCH_INTERVAL_MS = 60_000;
const touched = new Map<string, { at: number; ip: string }>();

function touch(tokenId: string, ip: string): void {
  const now = Date.now();
  const last = touched.get(tokenId);
  if (last && last.ip === ip && now - last.at < TOUCH_INTERVAL_MS) return;
  if (touched.size > 10_000) touched.clear();
  touched.set(tokenId, { at: now, ip });
  void prisma.mcpToken.update({ where: { id: tokenId }, data: { lastUsedAt: new Date(now), lastUsedIp: ip.slice(0, 64) } })
    .catch((err: unknown) => log.warn({ err, tokenId }, 'Could not record the MCP token use'));
}

/**
 * Verifies a bearer token. Throws on database errors (the caller answers 503 —
 * never "allowed").
 */
export async function verifyMcpToken(raw: string, ip: string): Promise<McpTokenCheck> {
  if (!looksLikeMcpToken(raw)) return { ok: false, reason: 'malformed' };
  const hash = hashMcpToken(raw);
  const row = await prisma.mcpToken.findUnique({
    where: { tokenHash: hash },
    select: {
      id: true, name: true, tokenHash: true, mode: true, mfaVerified: true, expiresAt: true, createdAt: true, revokedAt: true,
      user: { select: { id: true, email: true, role: true, active: true, domainId: true } },
    },
  });
  if (!row || !equalHex(row.tokenHash, hash)) return { ok: false, reason: 'unknown' };
  if (row.revokedAt) return { ok: false, reason: 'revoked' };
  if (new Date(row.expiresAt).getTime() <= Date.now()) {
    endSessionsOfToken(row.id, 'expired');
    return { ok: false, reason: 'expired' };
  }
  const user = row.user;
  if (!user || user.active === false) return { ok: false, reason: 'inactive' };
  // current role + management scope (the same lookup the admin guards use)
  const state = await currentAdminState(user.id);
  if (state.role === null) return { ok: false, reason: 'inactive' };
  if (!isAdminRole(state.role)) return { ok: false, reason: 'not-admin' };
  // A "revoke all" of the owner after the token was created (the DB revocation
  // in revokeAllSessions is the primary path; this covers a failed update).
  const created = new Date(row.createdAt).getTime();
  if (await isAccessTokenRevokedShared(user.id, Math.floor(created / 1000), undefined, created)) {
    await revokeTokenRow(row.id, 'sessions-revoked').catch(() => undefined);
    return { ok: false, reason: 'revoked' };
  }
  const mfa = await adminMfaRefusal(user.id, row.mfaVerified);
  if (mfa) return { ok: false, reason: 'mfa', code: mfa.code, error: mfa.error };
  touch(row.id, ip);
  return {
    ok: true,
    token: {
      tokenId: row.id,
      tokenName: row.name,
      userId: user.id,
      email: user.email,
      role: state.role,
      domainId: user.domainId,
      mode: row.mode === 'write' ? 'write' : 'read',
      mfaVerified: row.mfaVerified,
      scope: state.scope,
    },
  };
}

async function revokeTokenRow(id: string, reason: string): Promise<boolean> {
  const r = await prisma.mcpToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
  return (r?.count ?? 0) > 0;
}

/** Validation error of a create request, or null. */
export function tokenInputError(input: { name: string; mode: string; expiresInDays: number }): string | null {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 64) return 'name must be 1–64 characters';
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'name must not contain control characters';
  if (!(MCP_TOKEN_MODES as readonly string[]).includes(input.mode)) return 'mode must be read or write';
  if (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > MCP_TOKEN_MAX_DAYS) {
    return `expiresInDays must be an integer from 1 to ${MCP_TOKEN_MAX_DAYS}`;
  }
  return null;
}

export interface CreatedMcpToken {
  /** The token — returned exactly once, never stored. */
  token: string;
  id: string;
  name: string;
  prefix: string;
  mode: McpTokenMode;
  expiresAt: Date;
  createdAt: Date;
}

/** Creates a token for `userId`. `null` when the admin already holds MCP_TOKENS_PER_ADMIN active tokens. */
export async function createMcpToken(
  userId: string, input: { name: string; mode: McpTokenMode; expiresInDays: number }, mfaVerified: boolean,
): Promise<CreatedMcpToken | null> {
  const active = await prisma.mcpToken.count({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } } });
  if (active >= MCP_TOKENS_PER_ADMIN) return null;
  const { token, tokenHash, prefix } = generateMcpToken();
  const row = await prisma.mcpToken.create({
    data: {
      userId,
      name: input.name.trim(),
      tokenHash,
      prefix,
      mode: input.mode,
      mfaVerified,
      expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000),
    },
    select: { id: true, name: true, prefix: true, mode: true, expiresAt: true, createdAt: true },
  });
  return { token, ...row, mode: row.mode === 'write' ? 'write' : 'read' };
}

/**
 * Revokes a token and ends its sessions on every gateway instance (the live
 * connections of the token carry the session id `mcp:<tokenId>`). Returns
 * false when it was already revoked.
 */
export async function revokeMcpToken(token: { id: string; userId: string }, reason: string): Promise<boolean> {
  const changed = await revokeTokenRow(token.id, reason);
  endSessionsOfToken(token.id, 'revoked');
  // 'sessions-revoked' with only this id: other credentials and live
  // connections of the admin are not affected (core connectionAffected).
  await publishUserAuthChange(token.userId, 'sessions-revoked', { sessionIds: [mcpSessionKey(token.id)] });
  return changed;
}

/** Pure: display status of a token row. */
export function tokenStatus(row: { revokedAt: Date | string | null; expiresAt: Date | string }, now = Date.now()): 'active' | 'revoked' | 'expired' {
  if (row.revokedAt) return 'revoked';
  return new Date(row.expiresAt).getTime() <= now ? 'expired' : 'active';
}
