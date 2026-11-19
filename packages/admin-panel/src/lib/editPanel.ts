/**
 * Pure logic of the BCP edit panel (components/EditPanel.tsx): tab keyboard
 * navigation, the remembered tab per panel kind and the unsaved-changes guard.
 */

/** Tab that a key press selects (WAI-ARIA tabs pattern, automatic activation); null = key not handled. */
export function tabForKey(ids: readonly string[], current: string, key: string): string | null {
  if (ids.length === 0) return null;
  const index = Math.max(0, ids.indexOf(current));
  switch (key) {
    case 'ArrowRight': return ids[(index + 1) % ids.length]!;
    case 'ArrowLeft': return ids[(index - 1 + ids.length) % ids.length]!;
    case 'Home': return ids[0]!;
    case 'End': return ids[ids.length - 1]!;
    default: return null;
  }
}

/** Last tab per panel kind for the browser session (a new panel of the same kind opens on it). */
export type TabMemory = Map<string, string>;

export function rememberTab(memory: TabMemory, panelKind: string, tabId: string): void {
  memory.set(panelKind, tabId);
}

/** Remembered tab when it still exists in this panel, else the first tab. */
export function initialTab(memory: TabMemory, panelKind: string, ids: readonly string[]): string {
  const remembered = memory.get(panelKind);
  return remembered !== undefined && ids.includes(remembered) ? remembered : ids[0] ?? '';
}

/** Ids of the tabs with unsaved changes. */
export type DirtyTabs = ReadonlySet<string>;

export function withDirty(dirty: DirtyTabs, tabId: string, isDirty: boolean): DirtyTabs {
  if (dirty.has(tabId) === isDirty) return dirty;
  const next = new Set(dirty);
  if (isDirty) next.add(tabId); else next.delete(tabId);
  return next;
}

/** Closing needs a confirmation only while some tab has unsaved changes. */
export function needsDiscardConfirm(dirty: DirtyTabs): boolean {
  return dirty.size > 0;
}
