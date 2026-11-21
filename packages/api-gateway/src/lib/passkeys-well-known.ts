/**
 * 10.6: /.well-known/webauthn — WebAuthn Level 3 §5.11 Related Origin Requests.
 * A browser on an origin whose host is not covered by the RP ID fetches this
 * document from https://<rpId>/.well-known/webauthn and lets that origin use
 * the RP ID when it is listed. CoreMail lists the primary origin and
 * ServerSettings.passkeyRelatedOrigins (BCP → Authentifizierung → Passkeys).
 * Null (→ 404) while passkeys are off everywhere or no related origin is set.
 */
import { loadPasskeyServerPolicy, passkeysEnabledAnywhere } from '@coremail/storage/auth';
import { getRpConfig } from '@coremail/storage/auth/webauthn';

export async function wellKnownWebauthn(): Promise<{ origins: string[] } | null> {
  const policy = await loadPasskeyServerPolicy();
  if (policy.relatedOrigins.length === 0 || !(await passkeysEnabledAnywhere())) return null;
  const rp = await getRpConfig();
  return { origins: [...new Set([rp.primaryOrigin, ...rp.relatedOrigins])] };
}
