/**
 * BCP → Einstellungen → Sicherheit: API rate limit fields (pure, 9.4).
 * Defaults equal the ServerSettings schema defaults (api-gateway lib/api-rate-limit.ts).
 */

export interface RateLimitForm {
  apiRateLimitEnabled: boolean;
  apiRateLimitWindowMin: number;
  apiRateLimitPerIp: number;
  apiRateLimitPerUser: number;
}

export const API_RATE_LIMIT_FORM_DEFAULTS: RateLimitForm = {
  apiRateLimitEnabled: true,
  apiRateLimitWindowMin: 15,
  apiRateLimitPerIp: 500,
  apiRateLimitPerUser: 3000,
};

/** Pure: the form values from the settings response (missing fields → defaults). */
export function rateLimitForm(cfg: Partial<RateLimitForm>): RateLimitForm {
  const d = API_RATE_LIMIT_FORM_DEFAULTS;
  return {
    apiRateLimitEnabled: cfg.apiRateLimitEnabled ?? d.apiRateLimitEnabled,
    apiRateLimitWindowMin: cfg.apiRateLimitWindowMin ?? d.apiRateLimitWindowMin,
    apiRateLimitPerIp: cfg.apiRateLimitPerIp ?? d.apiRateLimitPerIp,
    apiRateLimitPerUser: cfg.apiRateLimitPerUser ?? d.apiRateLimitPerUser,
  };
}

const FIELD_LABEL: Record<string, string> = {
  apiRateLimitEnabled: 'Ein/Aus (API_RATE_LIMIT_ENABLED)',
  apiRateLimitWindowMin: 'Zeitfenster (API_RATE_LIMIT_WINDOW_MIN)',
  apiRateLimitPerIp: 'je IP-Adresse (API_RATE_LIMIT_PER_IP)',
  apiRateLimitPerUser: 'je Benutzer (API_RATE_LIMIT_PER_USER)',
};

/** Pure: is the field set by an API_RATE_LIMIT_* environment variable (shown read-only)? */
export function rateLimitLocked(overrides: readonly string[] | undefined, field: keyof RateLimitForm): boolean {
  return (overrides ?? []).includes(field);
}

/** Pure: note for the fields an environment variable overrides, or null. */
export function rateLimitEnvNote(overrides: readonly string[] | undefined): string | null {
  const labels = (overrides ?? []).map((f) => FIELD_LABEL[f]).filter((l): l is string => !!l);
  return labels.length
    ? `Per Umgebungsvariable festgelegt — gilt statt des hier gespeicherten Werts: ${labels.join(', ')}.`
    : null;
}
