/**
 * 9.4: look of the Settings navigation entries. A sub-entry (e.g. "Gelöschte
 * Elemente" under "Speicher") is indented; active and inactive entries keep
 * the same 2 px left border, so the active marker lines up for both.
 * Pure — unit-tested with `node --test`.
 */

export interface SettingsNavLook {
  active: boolean;
  /** Sub-entry of the entry above it. */
  indent?: boolean | undefined;
}

export function settingsNavClass({ active, indent }: SettingsNavLook): string {
  const pad = indent ? 'pl-9 pr-4' : 'px-4';
  const state = active
    ? 'bg-accent/10 text-accent-fg font-semibold border-l-2 border-accent'
    : 'text-fg-muted hover:bg-surface-2 border-l-2 border-transparent';
  return `w-full flex items-center gap-2.5 ${pad} py-2 text-sm transition-colors ${state}`;
}

/** Icon size: sub-entries get a slightly smaller icon. */
export const settingsNavIconSize = (indent: boolean | undefined): number => (indent ? 12 : 14);
