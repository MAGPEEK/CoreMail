/**
 * @coremail/storage/auth — single source of truth for web/API login, sessions,
 * MFA verification and password reset (v7.0.0). Used by the api-gateway and the
 * auth-service.
 */
export * from './login-service.js';
export * from './sessions.js';
export * from './mfa-challenge.js';
export * from './mfa-crypto.js';
export * from './totp.js';
export * from './backup-codes.js';
export * from './policy.js';
export * from './reauth.js';
export * from './password-reset.js';
export * from './sspr.js';
export * from './recovery-email.js';
export * from './legacy-ldap.js';
export { authRedis, type AuthRedis } from './redis.js';
export * from './invalidation.js';
export * from './notify.js';
export * from './refresh-cookie.js';
export * from './last-login.js';
export * from './web-access.js';
export * from './mfa-enforcement.js';
export * from './mfa-policy.js';
export * from './trusted-devices.js';
export * from './mcp-tokens.js';
// 10.6: passkeys — factor helper, policy, management, recovery links, audit.
// The WebAuthn ceremonies are the separate subpath @coremail/storage/auth/webauthn.
export * from './factors.js';
export * from './passkey-policy.js';
export * from './passkeys.js';
export * from './passkey-providers.js';
export * from './auth-audit.js';
// 10.6 review: pre-takeover protection (self-registered accounts never linked / taken over)
export * from './account-linking.js';
export { takeOnce } from './redis.js';
