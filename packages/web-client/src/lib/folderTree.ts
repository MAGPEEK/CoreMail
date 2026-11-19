/**
 * w3: root folders of a mailbox in the folder pane. Pure, unit-tested.
 *
 * components/FolderItem.tsx `buildFolderChildren` groups folders by parent
 * (custom folders without parent under INBOX, system folders under ROOT_KEY).
 * A full mailbox shows its system folders as roots. A folder-scoped foreign
 * mailbox lists only the granted folders and their path, so a folder may hang
 * under a parent that is not in the list (or there is no INBOX at all): such
 * folders become roots after the system folders, instead of disappearing.
 */

/** Group key of the folders without a parent in buildFolderChildren. */
export const ROOT_KEY = '__root__';

interface PaneFolder { id: string; name: string; displayName?: string; noSelect?: boolean }

/**
 * Folder opened when a mailbox is shown without a selection: INBOX, or — when
 * INBOX is missing or only a path entry (folder-scoped mailbox) — the first
 * selectable folder; undefined when there is none.
 */
export function defaultFolderOf<T extends PaneFolder>(folders: readonly T[]): T | undefined {
  const selectable = folders.filter((f) => f.noSelect !== true);
  return selectable.find((f) => f.name === 'INBOX') ?? selectable[0];
}

const labelOf = (f: PaneFolder): string => f.displayName ?? f.name;

export function paneRootFolders<T extends PaneFolder>(
  systemRoots: readonly T[],
  childrenOf: ReadonlyMap<string, readonly T[]>,
  all: readonly T[],
): T[] {
  const ids = new Set(all.map((f) => f.id));
  const taken = new Set(systemRoots.map((f) => f.id));
  const extra: T[] = [];
  for (const [parent, list] of childrenOf) {
    if (parent !== ROOT_KEY && ids.has(parent)) continue;
    for (const f of list) {
      if (!taken.has(f.id)) { taken.add(f.id); extra.push(f); }
    }
  }
  extra.sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  return [...systemRoots, ...extra];
}
