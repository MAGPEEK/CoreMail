/**
 * Personal admin tokens of the MCP interface (10.3, docs/mcp.md) — the storage
 * side: token format, hashing and the revocation every "revoke all sessions"
 * of the owner triggers (sessions.ts revokeAllSessions). Creating, listing and
 * verifying tokens lives in the api-gateway (lib/mcp/tokens.ts).
 *
 * Token: `cm_mcp_` + 43 base64url characters (32 random bytes). Only
 * sha256(token) is stored (McpToken.tokenHash); `prefix` (the first
 * MCP_TOKEN_DISPLAY_CHARS characters) identifies a token in lists.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createLogger } from '@coremail/core';
import { prisma } from '../prisma/index.js';

const log = createLogger('auth:mcp-tokens');

export const MCP_TOKEN_PREFIX = 'cm_mcp_';
/** Random bytes per token (≥ 32, the brief of the interface). */
export const MCP_TOKEN_BYTES = 32;
/** Characters of the token shown in lists (`cm_mcp_` + 6 random characters). */
export const MCP_TOKEN_DISPLAY_CHARS = MCP_TOKEN_PREFIX.length + 6;

const TOKEN_RE = /^cm_mcp_[A-Za-z0-9_-]{43}$/;

/** Pure: does `value` have the shape of an MCP token? (Never a proof of validity.) */
export function looksLikeMcpToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

/** Pure: sha256 (hex) of a token — the only form that is stored. */
export function hashMcpToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A new token with its hash and display prefix. The token itself is never stored. */
export function generateMcpToken(): { token: string; tokenHash: string; prefix: string } {
  const token = `${MCP_TOKEN_PREFIX}${randomBytes(MCP_TOKEN_BYTES).toString('base64url')}`;
  return { token, tokenHash: hashMcpToken(token), prefix: token.slice(0, MCP_TOKEN_DISPLAY_CHARS) };
}

/**
 * Revokes every active MCP token of a user (revokedAt = now). Called by
 * revokeAllSessions(), so a role change, deactivation, deletion, password
 * reset / change and "sign out everywhere" end the user's tokens as well.
 * Returns the number of revoked tokens; never throws (a failure is logged —
 * the api-gateway additionally rejects tokens created before a revoke-all mark).
 */
export async function revokeMcpTokensOfUser(userId: string, reason: string): Promise<number> {
  try {
    const r = await prisma.mcpToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason.slice(0, 64) },
    });
    const count = typeof r?.count === 'number' ? r.count : 0;
    if (count > 0) log.info({ userId, count, reason }, 'MCP tokens revoked');
    return count;
  } catch (err) {
    log.error({ err, userId, reason }, 'Could not revoke the MCP tokens of the user');
    return 0;
  }
}
