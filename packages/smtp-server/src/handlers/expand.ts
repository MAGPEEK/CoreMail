import { prisma } from '@coremail/storage';

/**
 * Löst Empfängeradressen auf:
 *  1. E-Mail-Aliase (EmailAlias) → Target-Primäradresse (User oder SharedMailbox)
 *  2. Reguläre Empfänger (User/SharedMailbox/ResourceMailbox) → unverändert
 *
 * v5.6.1: DistributionGroup-Expansion entfernt (Feature komplett raus).
 * Cycle-Schutz via `visited`-Set verhindert Endlosschleifen bei zyklischen
 * Aliasen.
 *
 * **WICHTIG**: Diese Funktion wird VOR `storeInboundMessage()` aufgerufen damit
 * lokale Empfänger immer auf eine konkrete User-/SharedMailbox-Adresse aufgelöst
 * werden. Sonst würden Aliase silent verworfen.
 */
export async function expandRecipients(
  rcptTo: string[],
  visited = new Set<string>(),
): Promise<string[]> {
  const result: string[] = [];

  for (const email of rcptTo) {
    const normalised = email.toLowerCase();

    // 1. E-Mail-Alias? → ersetzen durch Target-Primäradresse
    const alias = await prisma.emailAlias.findFirst({
      where: { address: normalised, active: true },
      include: {
        targetUser:   { select: { email: true, active: true } },
        targetShared: { select: { email: true, active: true } },
      },
    });
    if (alias) {
      const targetEmail = alias.targetUser?.active
        ? alias.targetUser.email
        : alias.targetShared?.active
          ? alias.targetShared.email
          : null;
      if (targetEmail && !visited.has(normalised)) {
        visited.add(normalised);
        result.push(targetEmail.toLowerCase());
        continue;
      }
    }

    // 2. Regulärer Empfänger (User / SharedMailbox / ResourceMailbox)
    result.push(normalised);
  }

  // Deduplicate
  return [...new Set(result)];
}
