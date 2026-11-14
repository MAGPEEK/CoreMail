/**
 * Pure: would setting `parentId` of mailbox `id` to `newParentId` create a
 * cycle (RFC 8620/8621 Mailbox/set: the tree must stay acyclic)? Walks up
 * from the new parent; reaching `id` (or a pre-existing loop) means yes.
 */
export function createsParentCycle(
  folders: ReadonlyArray<{ id: string; parentId: string | null }>,
  id: string,
  newParentId: string | null,
): boolean {
  if (!newParentId) return false;
  if (newParentId === id) return true;
  const parentOf = new Map(folders.map((f) => [f.id, f.parentId]));
  const seen = new Set<string>();
  let cur: string | null | undefined = newParentId;
  while (cur) {
    if (cur === id) return true;
    if (seen.has(cur)) return true; // existing corrupt loop — refuse to extend it
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}
