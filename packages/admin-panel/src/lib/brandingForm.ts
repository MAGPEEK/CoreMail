/**
 * Form logic of the BCP branding page (9.3) — pure, unit-tested.
 * API: PUT /api/v1/admin/branding (partial body) → branding object, optionally
 * with `warnings: [{ field, message, suggestion }]`; 400 → `{ error, field }`.
 *
 * The admin answers (GET/PUT/assets/reset) also carry `defaults`
 * {productName, primaryColor} (BRANDING_NAME / BRANDING_COLOR, else
 * CoreMail / #0078d4) and `explicit` {productName, primaryColor, headerColor}
 * (stored in the database or not). Saving sends only the fields the admin
 * changed, so a default that was never touched stays env-driven; "Standard
 * verwenden" sends `null` for a stored name / colour.
 */
import {
  DEFAULT_PRIMARY_COLOR, DEFAULT_PRODUCT_NAME, FOOTER_LINK_ERROR_TEXT, LOGIN_TEXT_MAX, PRODUCT_NAME_MAX,
  normalizeHex, parseBranding, validateFooterLinks,
  type Branding, type FooterLink,
} from './branding.ts';

/** Fields whose default comes from the server environment. */
export type DefaultField = 'productName' | 'primaryColor';

/** Admin view of the branding: the public object + defaults + which values are stored. */
export interface AdminBranding {
  branding: Branding;
  defaults: Record<DefaultField, string>;
  explicit: { productName: boolean; primaryColor: boolean; headerColor: boolean };
}

/**
 * Parses an admin answer. Without `defaults` / `explicit` (older server) the
 * name and colour count as stored, so "Standard verwenden" still sends null.
 */
export function parseAdminBranding(raw: unknown): AdminBranding {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const branding = parseBranding(raw);
  const d = (o['defaults'] && typeof o['defaults'] === 'object' ? o['defaults'] : {}) as Record<string, unknown>;
  const e = (o['explicit'] && typeof o['explicit'] === 'object' ? o['explicit'] : null) as Record<string, unknown> | null;
  const name = typeof d['productName'] === 'string' ? d['productName'].trim() : '';
  const flag = (k: string, fallback: boolean) => (e && typeof e[k] === 'boolean' ? (e[k] as boolean) : fallback);
  return {
    branding,
    defaults: {
      productName: name && [...name].length <= PRODUCT_NAME_MAX ? name : DEFAULT_PRODUCT_NAME,
      primaryColor: normalizeHex(d['primaryColor']) ?? DEFAULT_PRIMARY_COLOR,
    },
    explicit: {
      productName: flag('productName', true),
      primaryColor: flag('primaryColor', true),
      headerColor: flag('headerColor', branding.headerColor !== null),
    },
  };
}

export interface BrandingDraft {
  productName: string;
  /** raw text of the hex field (validated on save) */
  primaryColor: string;
  /** null = header uses the primary colour */
  headerColor: string | null;
  allowUserAccent: boolean;
  showPoweredBy: boolean;
  loginText: string;
  footerLinks: FooterLink[];
  /** true = the field shows and keeps the default (nothing stored, or "Standard verwenden" pressed) */
  useDefault: Record<DefaultField, boolean>;
}

export type DraftField = 'productName' | 'primaryColor' | 'headerColor' | 'loginText' | 'footerLinks';

export function draftFrom(a: AdminBranding): BrandingDraft {
  const b = a.branding;
  return {
    productName: b.productName,
    primaryColor: b.primaryColor,
    headerColor: b.headerColor,
    allowUserAccent: b.allowUserAccent,
    showPoweredBy: b.showPoweredBy,
    loginText: b.loginText,
    footerLinks: b.footerLinks.map((l) => ({ ...l })),
    useDefault: { productName: !a.explicit.productName, primaryColor: !a.explicit.primaryColor },
  };
}

/** Sets a draft field; editing the name or primary colour ends "use the default" for that field. */
export function editDraft<K extends keyof Omit<BrandingDraft, 'useDefault'>>(d: BrandingDraft, key: K, value: BrandingDraft[K]): BrandingDraft {
  const next = { ...d, [key]: value };
  if (key === 'productName' || key === 'primaryColor') next.useDefault = { ...d.useDefault, [key]: false };
  return next;
}

/** "Standard verwenden": the field shows the default and saving removes the stored value. */
export function applyDefault(d: BrandingDraft, field: DefaultField, a: AdminBranding): BrandingDraft {
  return { ...d, [field]: a.defaults[field], useDefault: { ...d.useDefault, [field]: true } };
}

/** Client-side checks (the API checks again); field → message. */
export function validateDraft(d: BrandingDraft): Partial<Record<DraftField, string>> {
  const errors: Partial<Record<DraftField, string>> = {};
  const name = d.productName.trim();
  if (!name) errors.productName = 'Bitte einen Produktnamen eingeben.';
  else if ([...name].length > PRODUCT_NAME_MAX) errors.productName = `Höchstens ${PRODUCT_NAME_MAX} Zeichen.`;
  if (!normalizeHex(d.primaryColor)) errors.primaryColor = 'Bitte eine Farbe im Format #rrggbb eingeben.';
  if (d.headerColor !== null && !normalizeHex(d.headerColor)) errors.headerColor = 'Bitte eine Farbe im Format #rrggbb eingeben.';
  if ([...d.loginText].length > LOGIN_TEXT_MAX) errors.loginText = `Höchstens ${LOGIN_TEXT_MAX} Zeichen.`;
  const links = validateFooterLinks(d.footerLinks);
  if (links.tooMany) errors.footerLinks = 'Höchstens 5 Links.';
  else {
    const i = links.errors.findIndex((e) => e !== null);
    if (i >= 0) errors.footerLinks = `Link ${i + 1}: ${FOOTER_LINK_ERROR_TEXT[links.errors[i]!]}`;
  }
  return errors;
}

const trimLinks = (links: FooterLink[]) => links.map((l) => ({ label: l.label.trim(), url: l.url.trim() }));

/**
 * PUT body from a valid draft: only the fields that differ from the saved
 * state (trimmed, colours normalised). A name / primary colour that follows
 * the default is sent as `null` only when a value is stored; an edited value
 * equal to the current one is not sent (an untouched default stays env-driven).
 */
export function draftToBody(d: BrandingDraft, saved: AdminBranding): Record<string, unknown> {
  const b = saved.branding;
  const body: Record<string, unknown> = {};
  for (const f of ['productName', 'primaryColor'] as const) {
    if (d.useDefault[f]) {
      if (saved.explicit[f]) body[f] = null;
      continue;
    }
    const v = f === 'productName' ? d.productName.trim() : normalizeHex(d.primaryColor);
    if (v !== b[f]) body[f] = v;
  }
  const header = d.headerColor === null ? null : normalizeHex(d.headerColor);
  if (header !== b.headerColor) body['headerColor'] = header;
  if (d.allowUserAccent !== b.allowUserAccent) body['allowUserAccent'] = d.allowUserAccent;
  if (d.showPoweredBy !== b.showPoweredBy) body['showPoweredBy'] = d.showPoweredBy;
  if (d.loginText.trim() !== b.loginText) body['loginText'] = d.loginText.trim();
  const links = trimLinks(d.footerLinks);
  if (JSON.stringify(links) !== JSON.stringify(trimLinks(b.footerLinks))) body['footerLinks'] = links;
  return body;
}

/** Does the draft differ from the saved branding? */
export function isDraftDirty(d: BrandingDraft, saved: AdminBranding): boolean {
  return Object.keys(draftToBody(d, saved)).length > 0;
}

export interface BrandingWarning {
  field: string;
  message: string;
  /** "#rrggbb" or null when the API sent none / an invalid one */
  suggestion: string | null;
}

/** `warnings` of a PUT answer (anything malformed is skipped). */
export function parseWarnings(raw: unknown): BrandingWarning[] {
  const list = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['warnings'] : undefined;
  if (!Array.isArray(list)) return [];
  return list
    .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
    .map((w) => ({
      field: typeof w['field'] === 'string' ? w['field'] : '',
      message: typeof w['message'] === 'string' ? w['message'] : '',
      suggestion: normalizeHex(w['suggestion']),
    }))
    .filter((w) => w.message || w.suggestion);
}

/** Applies a warning's suggestion to the draft (colour fields only). */
export function applySuggestion(d: BrandingDraft, w: BrandingWarning): BrandingDraft {
  if (!w.suggestion) return d;
  if (w.field === 'primaryColor') return editDraft(d, 'primaryColor', w.suggestion);
  if (w.field === 'headerColor') return { ...d, headerColor: w.suggestion };
  return d;
}

/** 400 body `{ error, field }` → field error (unknown fields go to the form level). */
export function parseFieldError(body: unknown, fallback: string): { field: DraftField | null; message: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const message = typeof b['error'] === 'string' && b['error'] ? b['error']
    : typeof b['message'] === 'string' && b['message'] ? b['message'] : fallback;
  const f = b['field'];
  const known: DraftField[] = ['productName', 'primaryColor', 'headerColor', 'loginText', 'footerLinks'];
  return { field: typeof f === 'string' && (known as string[]).includes(f) ? (f as DraftField) : null, message };
}
