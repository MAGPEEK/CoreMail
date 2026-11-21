/**
 * @coremail/storage/auth/webauthn (10.6) — the WebAuthn ceremonies (passkeys,
 * security keys), the Relying Party configuration and the legacy-key backfill.
 * Its own subpath so that services which only need the factor rules (the mail
 * servers, @coremail/storage/auth) never load the WebAuthn library.
 *
 * Importing this module registers the passkey verifier of verifyReauth()
 * (re-authentication with `webauthnFlowId` + `webauthnResponse`).
 */
import { registerReauthWebAuthnVerifier } from '../reauth.js';
import { verifyPasskeyReauth } from './ceremonies.js';

export * from './rp.js';
export * from './challenges.js';
export * from './ceremonies.js';
export * from './migration.js';

registerReauthWebAuthnVerifier((userId, flowId, response) => verifyPasskeyReauth(userId, flowId, response));
