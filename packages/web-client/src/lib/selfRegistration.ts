/**
 * 10.6: self-registration form — pure helpers (unit-tested with node --test).
 * Server: api-gateway routes/self-registration.ts (GET /auth/register/config,
 * POST /auth/register), docs/self-registration.md.
 */
import type { TranslationKey } from '../i18n/translations.js';

export const REGISTER_CONFIG_URL = '/auth/register/config';
export const REGISTER_URL = '/auth/register';

export interface RegisterConfig {
  enabled: true;
  domains: Array<{ id: string; name: string }>;
  inviteRequired: boolean;
  mode: 'approval' | 'immediate';
  minPasswordLength: number;
  formToken: string;
}

export interface RegisterForm {
  displayName: string;
  localPart: string;
  domainId: string;
  password: string;
  passwordConfirm: string;
  inviteCode: string;
}

export type RegisterField = 'displayName' | 'localPart' | 'password' | 'passwordConfirm' | 'inviteCode' | 'form';

/** Same rule as the server: lower-case letters, digits, . - _; letter or digit at both ends; no doubled separators. */
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function validLocalPart(raw: string): boolean {
  const lp = raw.trim().toLowerCase();
  return LOCAL_PART_RE.test(lp) && !/[._-]{2}/.test(lp);
}

/** A config answer the form can use, or null (feature off → the page says so). */
export function parseRegisterConfig(body: unknown): RegisterConfig | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Partial<RegisterConfig>;
  if (b.enabled !== true || !Array.isArray(b.domains) || b.domains.length === 0 || typeof b.formToken !== 'string') return null;
  const domains = b.domains.filter((d): d is { id: string; name: string } =>
    !!d && typeof d.id === 'string' && typeof d.name === 'string');
  if (domains.length === 0) return null;
  return {
    enabled: true,
    domains,
    inviteRequired: b.inviteRequired === true,
    mode: b.mode === 'immediate' ? 'immediate' : 'approval',
    minPasswordLength: typeof b.minPasswordLength === 'number' && b.minPasswordLength > 0 ? b.minPasswordLength : 8,
    formToken: b.formToken,
  };
}

/** First client-side problem of the form (the server checks everything again). */
export function checkRegisterForm(f: RegisterForm, cfg: Pick<RegisterConfig, 'minPasswordLength' | 'inviteRequired'>):
  { field: RegisterField; key: TranslationKey } | null {
  if (!f.displayName.trim()) return { field: 'displayName', key: 'register_err_name' };
  if (!validLocalPart(f.localPart)) return { field: 'localPart', key: 'register_err_local_part' };
  if (f.password.length < cfg.minPasswordLength) return { field: 'password', key: 'register_err_password_short' };
  if (f.password !== f.passwordConfirm) return { field: 'passwordConfirm', key: 'register_err_mismatch' };
  if (cfg.inviteRequired && !f.inviteCode.trim()) return { field: 'inviteCode', key: 'register_err_invite' };
  return null;
}

/** Server error code → field + text. */
export function registerErrorOf(status: number, code: string | undefined): { field: RegisterField; key: TranslationKey } {
  switch (code) {
    case 'ADDRESS_UNAVAILABLE': return { field: 'localPart', key: 'register_err_unavailable' };
    case 'INVALID_LOCAL_PART': return { field: 'localPart', key: 'register_err_local_part' };
    case 'INVALID_NAME': return { field: 'displayName', key: 'register_err_name' };
    case 'PASSWORD_POLICY': return { field: 'password', key: 'register_err_password_short' };
    case 'INVITE_INVALID': return { field: 'inviteCode', key: 'register_err_invite' };
    case 'DOMAIN_NOT_ALLOWED': return { field: 'form', key: 'register_err_domain' };
    case 'INVALID_FORM': return { field: 'form', key: 'register_err_form' };
    case 'RATE_LIMITED': return { field: 'form', key: 'register_err_rate' };
    default:
      if (status === 429) return { field: 'form', key: 'register_err_rate' };
      if (status === 503) return { field: 'form', key: 'register_err_maintenance' };
      return { field: 'form', key: 'register_err_generic' };
  }
}

/** The body of POST /auth/register (`website` = the honeypot, always empty for people). */
export function registerBody(f: RegisterForm, cfg: Pick<RegisterConfig, 'formToken' | 'inviteRequired'>, honeypot: string): Record<string, string> {
  return {
    domainId: f.domainId,
    displayName: f.displayName.trim(),
    localPart: f.localPart.trim().toLowerCase(),
    password: f.password,
    formToken: cfg.formToken,
    website: honeypot,
    ...(cfg.inviteRequired ? { inviteCode: f.inviteCode.trim() } : {}),
  };
}
