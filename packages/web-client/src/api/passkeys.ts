/**
 * 10.6: passkey API calls of the webmail (docs/passkeys.md).
 *  - Public (login page, recovery link): /auth/passkey/* — sent as browser client
 *    (`X-CoreMail-Client: web`), so the session's refresh token comes back as the
 *    HttpOnly cookie cm_rt and the flow is bound to the cookie cm_pk.
 *  - Signed in: /auth/passkeys/* through apiFetch (Bearer + refresh).
 */
import { apiFetch } from './client.js';
import { ApiError, apiErrorFromBody } from '../lib/errors.js';
import type { PasskeyInfo, PasskeyList } from '../lib/passkeys.js';
import { signalAllAcceptedCredentials, signalCurrentUserDetails } from '../lib/webauthn.js';

const WEB = { 'Content-Type': 'application/json', 'X-CoreMail-Client': 'web' };

async function publicPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: 'POST', credentials: 'same-origin', headers: WEB, body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    // maintenance answers { error: 'maintenance', message }
    if (data['error'] === 'maintenance') throw new ApiError(String(data['message'] ?? 'maintenance'), 'maintenance', res.status);
    throw apiErrorFromBody(data, res.status);
  }
  return data as T;
}

export interface CeremonyOptions { flowId: string; publicKey: Record<string, unknown> }

/** Is the passkey sign-in offered at all (passkeys + passwordless on somewhere)? */
export async function passkeySignInAvailable(): Promise<boolean> {
  try {
    const res = await fetch('/auth/passkey/status', { credentials: 'same-origin' });
    if (!res.ok) return false;
    return ((await res.json()) as { enabled?: boolean }).enabled === true;
  } catch {
    return false;
  }
}

export function passkeyLoginOptions(signal?: AbortSignal): Promise<CeremonyOptions> {
  return publicPost<CeremonyOptions>('/auth/passkey/login/options', {}, signal);
}

export async function passkeyLoginVerify(flowId: string, response: unknown): Promise<{ accessToken: string; refreshToken: string }> {
  const data = await publicPost<{ accessToken: string; refreshToken?: string }>('/auth/passkey/login/verify', { flowId, response });
  return { accessToken: data.accessToken, refreshToken: data.refreshToken ?? '' };
}

export function recoveryOptions(token: string): Promise<CeremonyOptions> {
  return publicPost<CeremonyOptions>('/auth/passkey/recovery/options', { token });
}

export function recoveryVerify(token: string, flowId: string, response: unknown, name: string): Promise<{ ok: boolean }> {
  return publicPost<{ ok: boolean }>('/auth/passkey/recovery/verify', { token, flowId, response, name });
}

// ── Signed in ─────────────────────────────────────────────────────────────────

async function authed<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isGet = !init.method || init.method === 'GET';
  const res = await apiFetch(path, init, isGet ? null : 'application/json');
  if (!res.ok) throw apiErrorFromBody(await res.json().catch(() => ({ error: res.statusText })), res.status);
  return res.json() as Promise<T>;
}

/** Re-authentication body: the password, or a passkey assertion. */
export type Reauth = { currentPassword: string } | { webauthnFlowId: string; webauthnResponse: unknown };

export const listPasskeys = () => authed<PasskeyList>('/auth/passkeys');
export const registrationOptions = (reauth: Reauth) =>
  authed<CeremonyOptions>('/auth/passkeys/registration/options', { method: 'POST', body: JSON.stringify(reauth) });
export const registrationVerify = (flowId: string, response: unknown, name: string) =>
  authed<{ credential: PasskeyInfo }>('/auth/passkeys/registration/verify', { method: 'POST', body: JSON.stringify({ flowId, response, name }) });
export const renamePasskey = (id: string, name: string) =>
  authed<{ credential: PasskeyInfo }>(`/auth/passkeys/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
export const removePasskey = (id: string, reauth: Reauth) =>
  authed<{ ok: boolean }>(`/auth/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify(reauth) });
export const reauthOptions = () => authed<CeremonyOptions>('/auth/passkeys/reauth/options', { method: 'POST', body: '{}' });

/**
 * Signal API after sign-in / a deletion (§5.1.10): the complete list of the
 * account's passkeys and its current name. Fire-and-forget.
 */
export function signalPasskeyState(): void {
  void authed<{ rpId: string; userId: string | null; allAcceptedCredentialIds: string[]; name: string; displayName: string }>('/auth/passkeys/signal')
    .then((d) => {
      if (!d.userId) return;
      signalAllAcceptedCredentials(d.rpId, d.userId, d.allAcceptedCredentialIds);
      signalCurrentUserDetails(d.rpId, d.userId, d.name, d.displayName);
    })
    .catch(() => undefined);
}
