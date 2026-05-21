import { prisma } from '@coremail/storage';

/**
 * Löst Empfängeradressen rekursiv auf:
 *  1. Verteilergruppen (DistributionGroup) → einzelne Mitglieder-Adressen
 *  2. E-Mail-Aliase (EmailAlias) → Target-Primäradresse (User oder SharedMailbox)
 *  3. Reguläre Empfänger (User/SharedMailbox/ResourceMailbox) → unverändert
 *
 * Cycle-Schutz via `visited`-Set verhindert Endlosschleifen bei verschachtelten
 * Gruppen oder zyklischen Aliasen.
 *
 * **WICHTIG**: Diese Funktion wird VOR `storeInboundMessage()` aufgerufen damit
 * lokale Empfänger immer auf eine konkrete User-/SharedMailbox-Adresse aufgelöst
 * werden. Sonst würden Aliase und Gruppen silent verworfen.
 */
export async function expandRecipients(
  rcptTo: string[],
  visited = new Set<string>(),
): Promise<string[]> {
  const result: string[] = [];

  for (const email of rcptTo) {
    const normalised = email.toLowerCase();

    // 1. Distribution Group?
    const group = await prisma.distributionGroup.findFirst({
      where: { email: normalised, active: true },
      include: { members: true },
    });
    if (group && !visited.has(normalised)) {
      visited.add(normalised);
      const memberEmails = group.members.map((m) => m.memberEmail);
      const expanded = await expandRecipients(memberEmails, visited);
      result.push(...expanded);
      continue;
    }

    // 2. E-Mail-Alias? → ersetzen durch Target-Primäradresse
    if (!group) {
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
        if (targetEmail) {
          if (!visited.has(normalised)) {
            visited.add(normalised);
            result.push(targetEmail.toLowerCase());
            continue;
          }
        }
      }
    }

    // 3. Regulärer Empfänger (User / SharedMailbox / ResourceMailbox)
    if (!group) {
      result.push(normalised);
    }
  }

  // Deduplicate
  return [...new Set(result)];
}
