/**
 * Sender lists (BCP → Protection → Sender lists, 9.4) — pure validation and CSV
 * import/export. Entries live in the `blacklist` table and are enforced by the
 * security filter (blacklist/index.ts): BLOCK refuses the recipient at RCPT TO, ALLOW
 * overrides a block and skips the spam verdict for an authenticated sender.
 *
 * CSV columns (header line required, comma separated, RFC 4180 quoting):
 *   listType,scope,target,patternType,pattern,comment,active
 * `target` is empty for GLOBAL, the domain name for DOMAIN and the mailbox address for USER.
 */
import { validateRulePattern } from '@coremail/storage';

export const LIST_TYPES = ['BLOCK', 'ALLOW'] as const;
export const LIST_SCOPES = ['GLOBAL', 'DOMAIN', 'USER'] as const;
export const PATTERN_TYPES = ['EXACT', 'WILDCARD', 'REGEX'] as const;
export type ListType = typeof LIST_TYPES[number];
export type ListScope = typeof LIST_SCOPES[number];
export type PatternType = typeof PATTERN_TYPES[number];

export const CSV_COLUMNS = ['listType', 'scope', 'target', 'patternType', 'pattern', 'comment', 'active'] as const;
/** Upper bounds of one import (rows / CSV characters). */
export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_CHARS = 1_000_000;

export interface SenderListInput {
  listType: ListType;
  scope: ListScope;
  /** '' for GLOBAL, domain name (DOMAIN) or mailbox address (USER). */
  target: string;
  patternType: PatternType;
  pattern: string;
  comment: string;
  active: boolean;
}

const ADDRESS_CHARS = /^[^\s<>()[\]\\,;:"]+$/;
const isOneOf = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);

/** Pure: a refusal message for the pattern, or null when it is valid for its type. */
export function patternError(patternType: PatternType, pattern: string): string | null {
  if (pattern.length === 0 || pattern.length > 254) return 'pattern must be 1–254 characters';
  if (/[\u0000-\u001f\u007f]/.test(pattern)) return 'pattern must not contain control characters';
  if (patternType === 'REGEX') {
    const v = validateRulePattern(pattern);
    return v.ok ? null : `invalid regular expression: ${v.error}`;
  }
  if (!ADDRESS_CHARS.test(pattern)) return 'pattern contains characters that never occur in an address';
  if (patternType === 'EXACT' && (pattern.includes('*') || !/^[^@]+@[^@]+$/.test(pattern))) {
    return 'EXACT needs a complete address (name@domain), use WILDCARD for *@domain';
  }
  if (patternType === 'WILDCARD' && !pattern.includes('*')) return 'WILDCARD needs at least one *';
  return null;
}

/** Pure: normalise + validate one entry (from the API body or a CSV row). */
export function normalizeEntry(raw: Record<string, unknown>): { ok: true; entry: SenderListInput } | { ok: false; error: string } {
  const text = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string).trim() : '');
  const listType = text('listType').toUpperCase() || 'BLOCK';
  const scope = text('scope').toUpperCase() || 'GLOBAL';
  const patternType = text('patternType').toUpperCase() || 'EXACT';
  if (!isOneOf(LIST_TYPES, listType)) return { ok: false, error: `listType must be one of ${LIST_TYPES.join(', ')}` };
  if (!isOneOf(LIST_SCOPES, scope)) return { ok: false, error: `scope must be one of ${LIST_SCOPES.join(', ')}` };
  if (!isOneOf(PATTERN_TYPES, patternType)) return { ok: false, error: `patternType must be one of ${PATTERN_TYPES.join(', ')}` };
  // EXACT / WILDCARD compare case-insensitively — stored lower-case; REGEX as written
  const pattern = patternType === 'REGEX' ? text('pattern') : text('pattern').toLowerCase();
  const perr = patternError(patternType, pattern);
  if (perr) return { ok: false, error: perr };
  const target = text('target').toLowerCase();
  if (scope === 'GLOBAL' && target) return { ok: false, error: 'GLOBAL entries have no target' };
  if (scope !== 'GLOBAL' && !target) return { ok: false, error: `${scope} entries need a target (${scope === 'DOMAIN' ? 'domain name' : 'mailbox address'})` };
  const comment = text('comment');
  if (comment.length > 500) return { ok: false, error: 'comment must be at most 500 characters' };
  const activeRaw = raw['active'];
  const active = typeof activeRaw === 'boolean' ? activeRaw : !/^(false|0|no|off)$/i.test(String(activeRaw ?? 'true').trim());
  return { ok: true, entry: { listType, scope, target, patternType, pattern, comment, active } };
}

/** Pure: identity of an entry for duplicate detection. */
export function entryKey(e: { listType: string; scope: string; scopeId: string | null; patternType: string; pattern: string }): string {
  return [e.listType, e.scope, e.scopeId ?? '', e.patternType, e.pattern].join('\u0000');
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/** Spreadsheet formula prefixes (CSV injection): such cells are exported with a leading '. */
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(value: string): string {
  const v = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Pure: entries → CSV (header line + one line per entry, CRLF). */
export function toCsv(entries: ReadonlyArray<SenderListInput>): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const e of entries) {
    lines.push([e.listType, e.scope, e.target, e.patternType, e.pattern, e.comment, String(e.active)].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Pure: RFC 4180 rows (quoted fields with "" escapes, CRLF or LF line ends). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const unescapeFormula = (v: string): string => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);

export interface CsvImportResult {
  entries: Array<SenderListInput & { line: number }>;
  errors: Array<{ line: number; error: string }>;
}

/** Pure: CSV text → validated entries (line numbers 1-based, header = line 1). */
export function parseSenderListCsv(text: string): CsvImportResult {
  const errors: CsvImportResult['errors'] = [];
  if (text.length > MAX_IMPORT_CHARS) return { entries: [], errors: [{ line: 0, error: `file larger than ${MAX_IMPORT_CHARS} characters` }] };
  const rows = parseCsvRows(text.replace(/^﻿/, ''));
  const header = (rows[0] ?? []).map((h) => h.trim());
  const missing = ['pattern'].filter((c) => !header.includes(c));
  if (rows.length === 0 || missing.length) return { entries: [], errors: [{ line: 1, error: `header line with the columns ${CSV_COLUMNS.join(',')} expected` }] };
  if (rows.length - 1 > MAX_IMPORT_ROWS) return { entries: [], errors: [{ line: 0, error: `at most ${MAX_IMPORT_ROWS} entries per import` }] };
  const entries: CsvImportResult['entries'] = [];
  rows.slice(1).forEach((cells, i) => {
    const raw: Record<string, unknown> = {};
    header.forEach((h, j) => { if (isOneOf(CSV_COLUMNS, h)) raw[h] = unescapeFormula(cells[j] ?? ''); });
    const r = normalizeEntry(raw);
    if (r.ok) entries.push({ ...r.entry, line: i + 2 });
    else errors.push({ line: i + 2, error: r.error });
  });
  return { entries, errors };
}
