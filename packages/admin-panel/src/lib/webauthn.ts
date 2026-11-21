/**
 * Minimal WebAuthn browser glue for the JSON shapes of @simplewebauthn/server
 * (auth-service). No imports — the base64url helpers are unit-tested with node.
 *
 * Server → browser: options JSON with base64url strings (challenge, user.id,
 * credential ids). Browser → server: RegistrationResponseJSON /
 * AuthenticationResponseJSON (base64url strings).
 *
 * 10.6 (passkeys): the browser's own PublicKeyCredential.parse*OptionsFromJSON
 * is used where it exists (fallback: the converters below); conditional
 * mediation (autofill sign-in) with an AbortSignal; the Signal API
 * (§5.1.10) — feature-detected, fire-and-forget. Keep this file identical in
 * web-client and admin-panel.
 */

export function base64UrlToBuffer(value: string): ArrayBuffer {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function bufferToBase64Url(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function webauthnSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof window.PublicKeyCredential !== 'undefined'
    && !!navigator.credentials;
}

/** Browser-native JSON helpers of WebAuthn Level 3 (not in every TypeScript DOM lib yet). */
interface PkcStatics {
  parseRequestOptionsFromJSON?: (o: unknown) => PublicKeyCredentialRequestOptions;
  parseCreationOptionsFromJSON?: (o: unknown) => PublicKeyCredentialCreationOptions;
  isConditionalMediationAvailable?: () => Promise<boolean>;
  signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void>;
  signalAllAcceptedCredentials?: (o: { rpId: string; userId: string; allAcceptedCredentialIds: string[] }) => Promise<void>;
  signalCurrentUserDetails?: (o: { rpId: string; userId: string; name: string; displayName: string }) => Promise<void>;
}
function pkc(): PkcStatics | null {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined'
    ? (window.PublicKeyCredential as unknown as PkcStatics) : null;
}

/** Conditional mediation (passkeys in the username autofill) available? */
export async function conditionalMediationAvailable(): Promise<boolean> {
  try {
    const f = pkc()?.isConditionalMediationAvailable;
    return typeof f === 'function' ? await f.call(window.PublicKeyCredential) : false;
  } catch {
    return false;
  }
}

interface CredentialDescriptorJSON { id: string; type?: string; transports?: string[] }

function toDescriptor(d: CredentialDescriptorJSON): PublicKeyCredentialDescriptor {
  return {
    id: base64UrlToBuffer(d.id),
    type: 'public-key',
    ...(d.transports ? { transports: d.transports as AuthenticatorTransport[] } : {}),
  };
}

/** Options JSON from the server → navigator.credentials.get() options. */
export function toRequestOptions(json: Record<string, unknown>): PublicKeyCredentialRequestOptions {
  const native = pkc()?.parseRequestOptionsFromJSON;
  if (typeof native === 'function') {
    try { return native.call(window.PublicKeyCredential, json); } catch { /* fall back */ }
  }
  const allow = (json['allowCredentials'] as CredentialDescriptorJSON[] | undefined) ?? [];
  return {
    ...(json as object),
    challenge: base64UrlToBuffer(String(json['challenge'])),
    allowCredentials: allow.map(toDescriptor),
  } as PublicKeyCredentialRequestOptions;
}

/** Options JSON from the server → navigator.credentials.create() options. */
export function toCreationOptions(json: Record<string, unknown>): PublicKeyCredentialCreationOptions {
  const native = pkc()?.parseCreationOptionsFromJSON;
  if (typeof native === 'function') {
    try { return native.call(window.PublicKeyCredential, json); } catch { /* fall back */ }
  }
  const user = json['user'] as { id: string; name: string; displayName: string };
  const exclude = (json['excludeCredentials'] as CredentialDescriptorJSON[] | undefined) ?? [];
  return {
    ...(json as object),
    challenge: base64UrlToBuffer(String(json['challenge'])),
    user: { ...user, id: base64UrlToBuffer(user.id) },
    excludeCredentials: exclude.map(toDescriptor),
  } as PublicKeyCredentialCreationOptions;
}

function common(cred: PublicKeyCredential) {
  return {
    id: cred.id,
    rawId: bufferToBase64Url(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    ...(cred.authenticatorAttachment ? { authenticatorAttachment: cred.authenticatorAttachment } : {}),
  };
}

export interface AuthenticateOptions {
  /** 'conditional' = offer the passkeys in the username autofill (no modal dialog). */
  mediation?: 'conditional' | 'optional';
  signal?: AbortSignal;
}

/** Performs an assertion (sign-in with a passkey / security key). */
export async function webauthnAuthenticate(optionsJson: unknown, opts: AuthenticateOptions = {}): Promise<Record<string, unknown>> {
  const cred = await navigator.credentials.get({
    publicKey: toRequestOptions(optionsJson as Record<string, unknown>),
    ...(opts.mediation ? { mediation: opts.mediation as CredentialMediationRequirement } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  }) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('No credential selected', 'NotAllowedError');
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    ...common(cred),
    response: {
      clientDataJSON: bufferToBase64Url(r.clientDataJSON),
      authenticatorData: bufferToBase64Url(r.authenticatorData),
      signature: bufferToBase64Url(r.signature),
      ...(r.userHandle ? { userHandle: bufferToBase64Url(r.userHandle) } : {}),
    },
  };
}

/** Creates a new credential (passkey / security key registration). */
export async function webauthnRegister(optionsJson: unknown): Promise<Record<string, unknown>> {
  const cred = await navigator.credentials.create({ publicKey: toCreationOptions(optionsJson as Record<string, unknown>) }) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('Registration cancelled', 'NotAllowedError');
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    ...common(cred),
    response: {
      clientDataJSON: bufferToBase64Url(r.clientDataJSON),
      attestationObject: bufferToBase64Url(r.attestationObject),
      ...(typeof r.getTransports === 'function' ? { transports: r.getTransports() } : {}),
    },
  };
}

// ── Signal API (WebAuthn L3 §5.1.10) — feature-detected, never throws ────────

/** The server does not know this credential (sign-in answered PASSKEY_UNKNOWN). */
export function signalUnknownCredential(rpId: string, credentialId: string): void {
  const f = pkc()?.signalUnknownCredential;
  if (typeof f === 'function') void f.call(window.PublicKeyCredential, { rpId, credentialId }).catch(() => undefined);
}

/** The complete list of the user's passkeys (after sign-in and after a deletion). */
export function signalAllAcceptedCredentials(rpId: string, userId: string, allAcceptedCredentialIds: string[]): void {
  const f = pkc()?.signalAllAcceptedCredentials;
  if (typeof f === 'function') void f.call(window.PublicKeyCredential, { rpId, userId, allAcceptedCredentialIds }).catch(() => undefined);
}

/** Name / display name of the account (after sign-in and after a name change). */
export function signalCurrentUserDetails(rpId: string, userId: string, name: string, displayName: string): void {
  const f = pkc()?.signalCurrentUserDetails;
  if (typeof f === 'function') void f.call(window.PublicKeyCredential, { rpId, userId, name, displayName }).catch(() => undefined);
}

/** DOMException → a stable reason for the UI texts. */
export type WebAuthnFailure = 'cancelled' | 'exists' | 'not_allowed_here' | 'aborted' | 'unsupported' | 'failed';

export function webauthnFailure(err: unknown): WebAuthnFailure {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
  switch (name) {
    case 'NotAllowedError': return 'cancelled';
    case 'InvalidStateError': return 'exists';
    case 'SecurityError': return 'not_allowed_here';
    case 'AbortError': return 'aborted';
    case 'NotSupportedError': return 'unsupported';
    default: return 'failed';
  }
}

/** Maps DOMException names from the browser to a readable German message (pre-10.6 callers). */
export function webauthnErrorMessage(err: unknown): string {
  switch (webauthnFailure(err)) {
    case 'cancelled': return 'Vorgang abgebrochen oder Zeit überschritten.';
    case 'exists': return 'Dieser Sicherheitsschlüssel ist bereits registriert.';
    case 'not_allowed_here': return 'WebAuthn ist auf dieser Adresse nicht erlaubt (HTTPS bzw. Domain prüfen).';
    default: return err instanceof Error ? err.message : 'WebAuthn fehlgeschlagen';
  }
}
