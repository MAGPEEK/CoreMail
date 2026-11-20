/**
 * GET /api/v1/admin/security/capabilities (9.3) — is rspamd / ClamAV deployed
 * in this installation? Proxies the security filter's /capabilities. Mounted by
 * security.ts (inherits requireArea('hygiene'): every role that can read the
 * Protection page).
 *
 *   { rspamd: { state, reason, detail?, checkedAt }, clamav: { … } }
 *
 *   state   absent | unavailable | available
 *   reason  disabled-by-config | host-not-found | dns-error | connect-failed |
 *           timeout | bad-response | ok | not-checked
 *   detail  error code only (ECONNREFUSED, HTTP_503, …)
 *
 * The BCP hides the settings of an `absent` scanner (env switch, or `auto`) and warns for an
 * `unavailable` one. Settings writes for an absent scanner are still accepted
 * (PUT /admin/security/settings, /admin/security/clamav) so the configuration
 * is in place when the container is added later. The reply is rebuilt from
 * whitelisted fields — never host names, URLs or credentials.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';

export const adminSecurityCapabilitiesRouter: RouterType = Router();

export const SCANNER_STATES = ['absent', 'unavailable', 'available'] as const;
export const SCANNER_REASONS = [
  'disabled-by-config', 'host-not-found', 'dns-error', 'connect-failed', 'timeout', 'bad-response', 'ok', 'not-checked',
] as const;

export interface ScannerCapability {
  state: typeof SCANNER_STATES[number];
  reason: typeof SCANNER_REASONS[number];
  detail?: string;
  checkedAt: string | null;
}
export interface ScannerCapabilities { rspamd: ScannerCapability; clamav: ScannerCapability }

const UNKNOWN: ScannerCapability = { state: 'unavailable', reason: 'not-checked', checkedAt: null };

/** Pure: whitelist the security filter's reply (anything unexpected → not checked). */
export function sanitizeScannerCapability(v: unknown): ScannerCapability {
  if (!v || typeof v !== 'object') return UNKNOWN;
  const o = v as Record<string, unknown>;
  const state = SCANNER_STATES.find((s) => s === o['state']);
  const reason = SCANNER_REASONS.find((r) => r === o['reason']);
  if (!state || !reason) return UNKNOWN;
  const detail = typeof o['detail'] === 'string' && /^[A-Z0-9_]{2,40}$/.test(o['detail']) ? o['detail'] : undefined;
  const checkedAt = typeof o['checkedAt'] === 'string' && Number.isFinite(Date.parse(o['checkedAt']))
    ? new Date(o['checkedAt']).toISOString() : null;
  return { state, reason, ...(detail ? { detail } : {}), checkedAt };
}

export function sanitizeCapabilities(v: unknown): ScannerCapabilities {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { rspamd: sanitizeScannerCapability(o['rspamd']), clamav: sanitizeScannerCapability(o['clamav']) };
}

const SECURITY_FILTER_URL = () => process.env['SECURITY_FILTER_URL'] ?? 'http://localhost:3002';

adminSecurityCapabilitiesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    // the filter re-checks (DNS + ping, 3 s timeouts each) when its state is older than 30 s
    const r = await fetch(`${SECURITY_FILTER_URL()}/capabilities`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) { res.status(502).json({ error: `security-filter HTTP ${r.status}` }); return; }
    res.json(sanitizeCapabilities(await r.json()));
  } catch {
    // the BCP then shows every section (unknown state = nothing hidden)
    res.status(503).json({ error: 'security-filter unavailable' });
  }
});
