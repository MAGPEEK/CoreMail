/**
 * BCP → Schutzfilter → Absenderlisten / Spoofing and the DNSBL action choice (pure, 9.4).
 */

export type ListType = 'BLOCK' | 'ALLOW';
export type ListScope = 'GLOBAL' | 'DOMAIN' | 'USER';
export type PatternType = 'EXACT' | 'WILDCARD' | 'REGEX';

export interface SenderListEntry {
  id: string;
  listType: ListType;
  scope: ListScope;
  scopeId: string | null;
  /** Domain name (DOMAIN) or mailbox address (USER), '' for GLOBAL. */
  target: string;
  patternType: PatternType;
  pattern: string;
  comment: string;
  active: boolean;
}

export const LIST_TYPE_LABEL: Record<ListType, string> = { BLOCK: 'Sperrliste', ALLOW: 'Zulassungsliste' };
export const SCOPE_LABEL: Record<ListScope, string> = { GLOBAL: 'Global', DOMAIN: 'Domain', USER: 'Postfach' };
export const PATTERN_TYPE_LABEL: Record<PatternType, string> = {
  EXACT: 'Adresse', WILDCARD: 'Platzhalter (*)', REGEX: 'Regulärer Ausdruck',
};

/** Placeholder of the pattern field for a pattern type. */
export function patternPlaceholder(type: PatternType): string {
  if (type === 'WILDCARD') return '*@werbung.example';
  if (type === 'REGEX') return '^newsletter-[0-9]+@.*$';
  return 'absender@example.com';
}

/** Pure: entries of one list, optionally filtered by a search text (pattern, target, comment). */
export function filterEntries(entries: readonly SenderListEntry[], listType: ListType, query = ''): SenderListEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter((e) => e.listType === listType
    && (!q || e.pattern.toLowerCase().includes(q) || e.target.toLowerCase().includes(q) || e.comment.toLowerCase().includes(q)));
}

/** Pure: readable list of the CSV import errors returned by the API. */
export function importErrorText(errors: ReadonlyArray<{ line: number; error: string }>): string {
  const shown = errors.slice(0, 5).map((e) => (e.line > 0 ? `Zeile ${e.line}: ${e.error}` : e.error));
  return errors.length > 5 ? [...shown, `… und ${errors.length - 5} weitere`].join('\n') : shown.join('\n');
}

// ── Spoofing ─────────────────────────────────────────────────────────────────

export type SpoofAction = 'policy' | 'junk' | 'reject';

export const SPOOF_ACTION_LABEL: Record<SpoofAction, { title: string; desc: string }> = {
  policy: { title: 'Nach eigener Richtlinie', desc: 'Die veröffentlichte DMARC-/SPF-Richtlinie der eigenen Domain entscheidet (Standard).' },
  junk:   { title: 'Immer Junk-Ordner',       desc: 'Nicht authentifizierte Mails mit eigener Domain werden in den Junk-Ordner zugestellt.' },
  reject: { title: 'Immer ablehnen',          desc: 'Nicht authentifizierte Mails mit eigener Domain werden abgewiesen.' },
};

/** Pure: textarea content → list entries (one per line, also comma separated). */
export function linesToList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

/** Pure: note for a field set by an environment variable (null = not overridden). */
export function envOverrideNote(variable: string | undefined): string | null {
  return variable ? `Per Umgebungsvariable ${variable} festgelegt — diese gilt statt des hier gespeicherten Werts.` : null;
}

// ── DNSBL actions ────────────────────────────────────────────────────────────

export type DnsblAction = 'REJECT' | 'TAG' | 'SCORE_ONLY';

/**
 * Pure: the action choices of a DNSBL zone. „Score" adds the zone's weight to the spam
 * score — without rspamd there is no spam score, so the option is disabled (kept in the
 * list so an existing zone still shows its value).
 */
export function dnsblActionOptions(rspamdAbsent: boolean): Array<{ value: DnsblAction; label: string; disabled: boolean }> {
  return [
    { value: 'REJECT', label: 'Ablehnen', disabled: false },
    { value: 'TAG', label: 'Markieren (nur Statistik)', disabled: false },
    { value: 'SCORE_ONLY', label: rspamdAbsent ? 'Score (nur mit Rspamd)' : 'Score (zum Spam-Score addieren)', disabled: rspamdAbsent },
  ];
}
