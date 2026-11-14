/**
 * Minimal WebAuthn browser glue for the JSON shapes of @simplewebauthn/server
 * (auth-service). No imports — the base64url helpers are unit-tested with node.
 *
 * Server → browser: options JSON with base64url strings (challenge, user.id,
 * credential ids). Browser → server: RegistrationResponseJSON /
 * AuthenticationResponseJSON (base64url strings).
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

interface CredentialDescriptorJSON { id: string; type?: string; transports?: string[] }

function toDescriptor(d: CredentialDescriptorJSON): PublicKeyCredentialDescriptor {
  return {
    id: base64UrlToBuffer(d.id),
    type: 'public-key',
    ...(d.transports ? { transports: d.transports as AuthenticatorTransport[] } : {}),
  };
}

/** Options JSON from /webauthn/auth/start → navigator.credentials.get() options. */
export function toRequestOptions(json: Record<string, unknown>): PublicKeyCredentialRequestOptions {
  const allow = (json['allowCredentials'] as CredentialDescriptorJSON[] | undefined) ?? [];
  return {
    ...(json as object),
    challenge: base64UrlToBuffer(String(json['challenge'])),
    allowCredentials: allow.map(toDescriptor),
  } as PublicKeyCredentialRequestOptions;
}

/** Options JSON from /webauthn/register/start → navigator.credentials.create() options. */
export function toCreationOptions(json: Record<string, unknown>): PublicKeyCredentialCreationOptions {
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

/** Performs an assertion (sign-in with a security key / passkey). */
export async function webauthnAuthenticate(optionsJson: unknown): Promise<Record<string, unknown>> {
  const cred = await navigator.credentials.get({ publicKey: toRequestOptions(optionsJson as Record<string, unknown>) }) as PublicKeyCredential | null;
  if (!cred) throw new Error('Kein Sicherheitsschlüssel ausgewählt');
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

/** Creates a new credential (security key / passkey registration). */
export async function webauthnRegister(optionsJson: unknown): Promise<Record<string, unknown>> {
  const cred = await navigator.credentials.create({ publicKey: toCreationOptions(optionsJson as Record<string, unknown>) }) as PublicKeyCredential | null;
  if (!cred) throw new Error('Registrierung abgebrochen');
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

/** Maps DOMException names from the browser to a readable German message. */
export function webauthnErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'Vorgang abgebrochen oder Zeit überschritten.';
    if (err.name === 'InvalidStateError') return 'Dieser Sicherheitsschlüssel ist bereits registriert.';
    if (err.name === 'SecurityError') return 'WebAuthn ist auf dieser Adresse nicht erlaubt (HTTPS bzw. Domain prüfen).';
  }
  return err instanceof Error ? err.message : 'WebAuthn fehlgeschlagen';
}
