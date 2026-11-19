/**
 * 9.4: webmail policies (admin API /admin/webmail-policies) — the level view
 * the API returns and the pure logic of the BCP editor: the editable draft,
 * the PUT body, extension lists. Tri-state switches resolve like the
 * protocol switches (lib/protocolAccess.ts).
 */
import type { ProtocolSetting } from './protocolAccess.ts';

export const WEBMAIL_FEATURES = [
  'calendar', 'contacts', 'tasks', 'notes', 'rules', 'signatures', 'categories', 'recoverItems',
  'changePassword', 'themes', 'externalClients', 'appPasswords', 'sharedMailboxes', 'profilePhoto',
] as const;
export type WebmailFeature = typeof WEBMAIL_FEATURES[number];

export const EXTERNAL_IMAGE_MODES = ['ask', 'contacts', 'block'] as const;
export type ExternalImageMode = typeof EXTERNAL_IMAGE_MODES[number];

export type PolicyLevel = 'global' | 'domain' | 'user';
export type ValueSource = PolicyLevel | 'default';
export const CONTENT_KEYS = ['blockedExtensions', 'downloadOnlyExtensions', 'maxUploadMb', 'externalImages'] as const;
export type ContentKey = typeof CONTENT_KEYS[number];

export interface ContentSettings {
  blockedExtensions: string[] | null;
  downloadOnlyExtensions: string[] | null;
  maxUploadMb: number | null;
  externalImages: ExternalImageMode | null;
}
export interface ContentPolicy {
  blockedExtensions: string[];
  downloadOnlyExtensions: string[];
  maxUploadMb: number | null;
  externalImages: ExternalImageMode;
}

/** GET/PUT /admin/webmail-policies[/domains/:id|/users/:id]. */
export interface WebmailPolicyView {
  level: PolicyLevel;
  id?: string;
  features: WebmailFeature[];
  settings: { features: Record<WebmailFeature, ProtocolSetting>; content: ContentSettings };
  inherited: { features: Record<WebmailFeature, boolean>; content: ContentPolicy };
  effective: { features: Record<WebmailFeature, boolean>; content: ContentPolicy };
  sources: { features: Record<WebmailFeature, ValueSource>; content: Record<ContentKey, ValueSource> };
  /** PUT only: accounts in scope. */
  users?: number;
}

/** Largest accepted upload limit (MB) — same as the server. */
export const MAX_UPLOAD_MB = 10_240;

/** "EXE, .js; bat" → ['exe', 'js', 'bat'] (lower case, no dots, no duplicates, no garbage). */
export function parseExtensionText(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/[\s,;]+/)) {
    const ext = raw.trim().toLowerCase().replace(/^\.+/, '');
    if (/^[a-z0-9][a-z0-9_+-]{0,19}$/.test(ext)) out.add(ext);
  }
  return [...out];
}

export function formatExtensions(list: readonly string[]): string {
  return list.join(', ');
}

/** A content value in the editor: inherited (below the server level), or an own value as text. */
export interface ValueDraft { inherit: boolean; text: string }

export interface PolicyDraft {
  features: Record<WebmailFeature, ProtocolSetting>;
  blockedExtensions: ValueDraft;
  downloadOnlyExtensions: ValueDraft;
  maxUploadMb: ValueDraft;
  externalImages: ExternalImageMode | 'inherit';
}

const listDraft = (v: string[] | null, inherited: string[]): ValueDraft =>
  (v === null ? { inherit: true, text: formatExtensions(inherited) } : { inherit: false, text: formatExtensions(v) });

/** The editor state of a level view. */
export function draftFromView(view: WebmailPolicyView): PolicyDraft {
  const c = view.settings.content;
  const global = view.level === 'global';
  return {
    features: { ...view.settings.features },
    blockedExtensions: listDraft(c.blockedExtensions, view.inherited.content.blockedExtensions),
    downloadOnlyExtensions: listDraft(c.downloadOnlyExtensions, view.inherited.content.downloadOnlyExtensions),
    // server level: empty = no own limit; below: inherit = the broader value
    maxUploadMb: c.maxUploadMb === null
      ? { inherit: !global, text: global ? '' : String(view.inherited.content.maxUploadMb ?? '') }
      : { inherit: false, text: String(c.maxUploadMb) },
    externalImages: c.externalImages ?? 'inherit',
  };
}

export interface PolicyPatch {
  features?: Partial<Record<WebmailFeature, ProtocolSetting>>;
  content?: Partial<ContentSettings>;
}

export type PatchResult = { ok: true; patch: PolicyPatch } | { ok: false; error: 'maxUploadMb' };

function sameList(a: readonly string[] | null, b: readonly string[] | null): boolean {
  return a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));
}

/** The PUT body: only what differs from the stored level; an invalid upload limit is refused. */
export function patchFromDraft(view: WebmailPolicyView, draft: PolicyDraft): PatchResult {
  const features: Partial<Record<WebmailFeature, ProtocolSetting>> = {};
  for (const f of WEBMAIL_FEATURES) if (draft.features[f] !== view.settings.features[f]) features[f] = draft.features[f];
  const stored = view.settings.content;
  const content: Partial<ContentSettings> = {};
  for (const key of ['blockedExtensions', 'downloadOnlyExtensions'] as const) {
    const next = draft[key].inherit ? null : parseExtensionText(draft[key].text);
    if (!sameList(next, stored[key])) content[key] = next;
  }
  let upload: number | null = null;
  if (!draft.maxUploadMb.inherit && draft.maxUploadMb.text.trim() !== '') {
    const n = Number(draft.maxUploadMb.text.trim());
    if (!Number.isInteger(n) || n < 1 || n > MAX_UPLOAD_MB) return { ok: false, error: 'maxUploadMb' };
    upload = n;
  }
  if (upload !== stored.maxUploadMb) content.maxUploadMb = upload;
  const images = draft.externalImages === 'inherit' ? null : draft.externalImages;
  if (images !== stored.externalImages) content.externalImages = images;
  const patch: PolicyPatch = {
    ...(Object.keys(features).length ? { features } : {}),
    ...(Object.keys(content).length ? { content } : {}),
  };
  return { ok: true, patch };
}

export function isEmptyPatch(p: PolicyPatch): boolean {
  return !p.features && !p.content;
}
