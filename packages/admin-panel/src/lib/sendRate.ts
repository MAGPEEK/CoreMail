/**
 * BCP → SMTP & Routing → Sendelimit (10.5): API view ↔ form state and the PUT
 * body of /admin/smtp-config/send-rate. Bounds equal the api-gateway schema
 * (storage SEND_RATE_BOUNDS). Pure, unit-tested.
 */
export interface SendRateView {
  enabled: boolean;
  messagesPerHour: number;
  recipientsPerHour: number;
  blockOnExceed: boolean;
}

export interface SendRateForm {
  enabled: boolean;
  messagesPerHour: string;
  recipientsPerHour: string;
  blockOnExceed: boolean;
}

export const SEND_RATE_LIMITS = {
  messagesPerHour: [1, 100_000],
  recipientsPerHour: [1, 1_000_000],
} as const;

export function sendRateForm(v: SendRateView): SendRateForm {
  return {
    enabled: v.enabled,
    messagesPerHour: String(v.messagesPerHour),
    recipientsPerHour: String(v.recipientsPerHour),
    blockOnExceed: v.blockOnExceed,
  };
}

const inRange = (s: string, [min, max]: readonly [number, number]): number | null => {
  const v = s.trim();
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
};

/** The PUT body, or the first invalid field. */
export function sendRatePayload(f: SendRateForm):
  { ok: true; value: SendRateView } | { ok: false; field: 'messagesPerHour' | 'recipientsPerHour' } {
  const messagesPerHour = inRange(f.messagesPerHour, SEND_RATE_LIMITS.messagesPerHour);
  if (messagesPerHour === null) return { ok: false, field: 'messagesPerHour' };
  const recipientsPerHour = inRange(f.recipientsPerHour, SEND_RATE_LIMITS.recipientsPerHour);
  if (recipientsPerHour === null) return { ok: false, field: 'recipientsPerHour' };
  return { ok: true, value: { enabled: f.enabled, messagesPerHour, recipientsPerHour, blockOnExceed: f.blockOnExceed } };
}
