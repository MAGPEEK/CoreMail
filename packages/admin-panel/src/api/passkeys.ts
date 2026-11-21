/**
 * 10.6: passkey sign-in of the BCP (docs/passkeys.md). Sent as BCP browser
 * client (`X-CoreMail-Client: web` + `X-CoreMail-App: bcp`): the refresh token
 * comes back as the HttpOnly cookie cm_rt_bcp; the flow is bound to cm_pk.
 */
import { ApiError, apiErrorFromBody } from '../lib/errors.js';

const HEADERS = { 'Content-Type': 'application/json', 'X-CoreMail-Client': 'web', 'X-CoreMail-App': 'bcp' };

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: 'POST', credentials: 'same-origin', headers: HEADERS, body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    if (data['error'] === 'maintenance') throw new ApiError(String(data['message'] ?? 'maintenance'), 'maintenance', res.status);
    throw apiErrorFromBody(data, res.status);
  }
  return data as T;
}

export interface CeremonyOptions { flowId: string; publicKey: Record<string, unknown> }

export async function passkeySignInAvailable(): Promise<boolean> {
  try {
    const res = await fetch('/auth/passkey/status', { credentials: 'same-origin' });
    return res.ok && ((await res.json()) as { enabled?: boolean }).enabled === true;
  } catch {
    return false;
  }
}

export const passkeyLoginOptions = (signal?: AbortSignal) => post<CeremonyOptions>('/auth/passkey/login/options', {}, signal);

export async function passkeyLoginVerify(flowId: string, response: unknown): Promise<string> {
  const data = await post<{ accessToken: string }>('/auth/passkey/login/verify', { flowId, response });
  return data.accessToken;
}
