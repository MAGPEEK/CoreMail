/**
 * 9.3: one mail view for every mailbox — the user's own, a Shared Mailbox or a
 * delegated user mailbox. The folder/message components take their API base and
 * query keys from the active mailbox; the folder pane lists the foreign ones under
 * "Freigegebene Postfächer". No imports — unit-tested with `node --test`.
 *
 * API (same request/response shapes for every kind, api-gateway routes/foreign-mailbox.ts):
 *   own        → /mail
 *   shared     → /mail/shared-mailboxes/<SharedMailbox id>  (the pre-9.3 /user/shared-mailboxes/:id/… routes keep their old contract)
 *   delegated  → /mail/delegated-mailboxes/<Mailbox id>
 */
export type ForeignMailboxKind = 'shared' | 'delegated';
export type MailboxRef = { kind: 'own' } | { kind: ForeignMailboxKind; id: string };

export const OWN_MAILBOX: MailboxRef = Object.freeze({ kind: 'own' }) as MailboxRef;

/** One entry of GET /user/accessible-mailboxes. */
export interface AccessibleMailboxEntry {
  ref: string;
  kind: ForeignMailboxKind;
  id: string;
  email: string;
  displayName: string;
  readOnly: boolean;
  permissions: string[];
  hidden: boolean;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** "own" | "shared:<id>" | "delegated:<id>" — URL parameter, query keys, server visibility list. */
export function mailboxKey(ref: MailboxRef): string {
  return ref.kind === 'own' ? 'own' : `${ref.kind}:${ref.id}`;
}

/** Parses a mailbox key; anything invalid (or missing) is the own mailbox. */
export function parseMailboxKey(key: string | null | undefined): MailboxRef {
  const m = /^(shared|delegated):(.+)$/.exec(key ?? '');
  if (!m || !ID_RE.test(m[2]!)) return OWN_MAILBOX;
  return { kind: m[1] as ForeignMailboxKind, id: m[2]! };
}

export function isForeign(ref: MailboxRef): ref is { kind: ForeignMailboxKind; id: string } {
  return ref.kind !== 'own';
}

export function sameMailbox(a: MailboxRef, b: MailboxRef): boolean {
  return mailboxKey(a) === mailboxKey(b);
}

/** API base (relative to /api/v1) for folder/message operations of the mailbox. */
export function mailApiBase(ref: MailboxRef): string {
  if (ref.kind === 'shared') return `/mail/shared-mailboxes/${encodeURIComponent(ref.id)}`;
  if (ref.kind === 'delegated') return `/mail/delegated-mailboxes/${encodeURIComponent(ref.id)}`;
  return '/mail';
}

/** TanStack Query key of the folder list. The own list keeps its pre-9.3 key ['folders']. */
export function foldersQueryKey(ref: MailboxRef): readonly unknown[] {
  return ref.kind === 'own' ? ['folders'] : ['folders', mailboxKey(ref)];
}

/** Webmail URL that opens the mailbox (the /shared-mailbox/:id redirect target). */
export function mailPageUrl(ref: MailboxRef): string {
  return ref.kind === 'own' ? '/mail' : `/mail?mailbox=${encodeURIComponent(mailboxKey(ref))}`;
}

// ── Permissions (German UI labels) ──────────────────────────────────────────
/** SharedMailboxPermType (schema.prisma) → German label. */
export const PERMISSION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  FULL_ACCESS: 'Vollzugriff',
  SEND_AS: 'Senden als',
  SEND_ON_BEHALF: 'Senden im Auftrag',
  READ_ONLY: 'Nur lesen',
});

const PERMISSION_ORDER = ['FULL_ACCESS', 'READ_ONLY', 'SEND_AS', 'SEND_ON_BEHALF'];

export function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? permission;
}

/** "Vollzugriff · Senden als" — known permissions in a fixed order, no duplicates. */
export function permissionSummary(permissions: readonly string[]): string {
  const uniq = [...new Set(permissions)];
  uniq.sort((a, b) => {
    const ia = PERMISSION_ORDER.indexOf(a), ib = PERMISSION_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return uniq.map(permissionLabel).join(' · ');
}

/** Tooltip of every write action that read-only access disables. */
export const READ_ONLY_HINT = 'Nur Lesezugriff – für dieses Postfach nicht erlaubt';
/** Actions that only exist for the own mailbox (snooze, categories, rules, retention tags). */
export const OWN_ONLY_HINT = 'Nur im eigenen Postfach verfügbar';

/**
 * Must write actions be disabled? The own mailbox is writable; a foreign mailbox is
 * read-only unless its entry says otherwise (also while the list is still loading).
 */
export function isReadOnlyMailbox(ref: MailboxRef, entries: readonly AccessibleMailboxEntry[] | undefined): boolean {
  if (ref.kind === 'own') return false;
  const entry = findMailboxEntry(ref, entries);
  return entry ? entry.readOnly : true;
}

export function findMailboxEntry(ref: MailboxRef, entries: readonly AccessibleMailboxEntry[] | undefined): AccessibleMailboxEntry | undefined {
  if (ref.kind === 'own') return undefined;
  const key = mailboxKey(ref);
  return entries?.find((e) => e.ref === key);
}

/** Folder-pane entries: not hidden, in server order (kind, then address). */
export function visibleMailboxes(entries: readonly AccessibleMailboxEntry[] | undefined): AccessibleMailboxEntry[] {
  return (entries ?? []).filter((e) => !e.hidden);
}

export function mailboxTitle(entry: Pick<AccessibleMailboxEntry, 'displayName' | 'email'>): string {
  return entry.displayName || entry.email;
}

// ── Sender choice in compose ────────────────────────────────────────────────
export type SenderMode = 'self' | 'sendAs' | 'sendOnBehalfOf';
export interface SenderOption {
  mode: SenderMode;
  /** Address put into the draft's sendAs / sendOnBehalfOf (empty for 'self'). */
  address: string;
  label: string;
}

/**
 * "Von" options for a compose window opened inside a mailbox. Mirrors the server
 * rule (api-gateway resolveSender): send as with SEND_AS or FULL_ACCESS on a shared
 * mailbox, send on behalf with SEND_ON_BEHALF. Delegations never grant sending.
 * The first option is the default when the user composes inside that mailbox.
 */
export function senderOptions(ownEmail: string, entry: AccessibleMailboxEntry | undefined): SenderOption[] {
  const self: SenderOption = { mode: 'self', address: '', label: ownEmail };
  if (!entry || entry.kind !== 'shared') return [self];
  const out: SenderOption[] = [];
  const name = mailboxTitle(entry);
  if (entry.permissions.includes('SEND_AS') || entry.permissions.includes('FULL_ACCESS')) {
    out.push({ mode: 'sendAs', address: entry.email, label: `${name} <${entry.email}> (Senden als)` });
  }
  if (entry.permissions.includes('SEND_ON_BEHALF')) {
    out.push({ mode: 'sendOnBehalfOf', address: entry.email, label: `${ownEmail} im Auftrag von ${name} <${entry.email}>` });
  }
  return [...out, self];
}

/** Draft fields for the chosen option (exactOptionalPropertyTypes-safe). */
export function senderDraftFields(option: SenderOption | undefined): { sendAs?: string; sendOnBehalfOf?: string } {
  if (!option || option.mode === 'self' || !option.address) return {};
  return option.mode === 'sendAs' ? { sendAs: option.address } : { sendOnBehalfOf: option.address };
}

/** Option matching a reopened draft (its sendAs / sendOnBehalfOf), else undefined. */
export function senderFromDraft(sendAs: string | null | undefined, sendOnBehalfOf: string | null | undefined, ownEmail: string): SenderOption | undefined {
  if (sendAs) return { mode: 'sendAs', address: sendAs, label: `${sendAs} (Senden als)` };
  if (sendOnBehalfOf) return { mode: 'sendOnBehalfOf', address: sendOnBehalfOf, label: `${ownEmail} im Auftrag von ${sendOnBehalfOf}` };
  return undefined;
}

export function senderKey(o: SenderOption): string {
  return `${o.mode}:${o.address.toLowerCase()}`;
}

// ── Folder-pane expand state (persisted per browser) ────────────────────────
/** Toggles a mailbox key in the list of expanded mailbox roots. */
export function toggleExpanded(expanded: readonly string[], key: string, open?: boolean): string[] {
  const has = expanded.includes(key);
  const want = open ?? !has;
  if (want === has) return [...expanded];
  return want ? [...expanded, key] : expanded.filter((k) => k !== key);
}
