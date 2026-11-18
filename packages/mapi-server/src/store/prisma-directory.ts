/**
 * Production sources of the address book endpoint:
 *  - the directory: active users and Shared Mailboxes of the caller's own
 *    domain with their active aliases and the GAL visibility of their mail
 *    flow policy — the GAL scope of every CoreMail directory lookup (webmail,
 *    ActiveSync, JMAP);
 *  - the public MAPI endpoint URLs (storage mapiEndpointsFor over the server
 *    settings, cached 60 s).
 */
import { mapiEndpointsFor, prisma, type MapiEndpoints } from '@coremail/storage';
import type { DirectoryRecord, DirectoryStore } from './types.js';

/** Upper bound of one address book (an SMB server lists far fewer). */
export const MAX_DIRECTORY_ENTRIES = 20_000;
const SETTINGS_TTL_MS = 60_000;

export function createPrismaDirectory(): DirectoryStore {
  return {
    async listDirectory(user) {
      const visibility = { mailFlowPolicy: { select: { hiddenFromGal: true } } } as const;
      const [users, shared] = await Promise.all([
        prisma.user.findMany({
          where: { domainId: user.domainId, active: true },
          select: { id: true, email: true, displayName: true, domainId: true, ...visibility },
          take: MAX_DIRECTORY_ENTRIES,
        }),
        prisma.sharedMailbox.findMany({
          where: { domainId: user.domainId, active: true },
          select: { id: true, email: true, displayName: true, domainId: true, ...visibility },
          take: MAX_DIRECTORY_ENTRIES,
        }),
      ]);
      // Defence in depth: the domain is the boundary.
      const inDomain = <T extends { domainId: string }>(rows: T[]): T[] => rows.filter((r) => r.domainId === user.domainId);
      const ownUsers = inDomain(users);
      const ownShared = inDomain(shared);
      const aliases = await prisma.emailAlias.findMany({
        where: {
          active: true,
          OR: [{ targetUserId: { in: ownUsers.map((u) => u.id) } }, { targetSharedId: { in: ownShared.map((s) => s.id) } }],
        },
        select: { address: true, targetUserId: true, targetSharedId: true },
      });
      const aliasesOf = (id: string): string[] => aliases
        .filter((a) => a.targetUserId === id || a.targetSharedId === id).map((a) => a.address.toLowerCase());
      const record = (kind: DirectoryRecord['kind']) => (r: typeof ownUsers[number]): DirectoryRecord => ({
        id: r.id, kind, email: r.email.toLowerCase(), displayName: r.displayName || r.email,
        aliases: aliasesOf(r.id), hidden: r.mailFlowPolicy?.hiddenFromGal === true,
      });
      return [...ownUsers.map(record('user')), ...ownShared.map(record('shared'))];
    },
  };
}

/** The public MAPI URLs from the server settings (cached; null when no public host name is set). */
export function createEndpointProvider(now: () => number = () => Date.now()): () => Promise<MapiEndpoints | null> {
  let cached: { value: MapiEndpoints | null; until: number } | null = null;
  return async () => {
    if (cached && now() < cached.until) return cached.value;
    const s = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { owaUrl: true, publicHostname: true } });
    const value = s ? mapiEndpointsFor(s) : null;
    cached = { value, until: now() + SETTINGS_TTL_MS };
    return value;
  };
}
