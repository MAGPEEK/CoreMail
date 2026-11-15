/**
 * @coremail/auth-sso — OIDC single sign-on against external IdPs (Entra ID,
 * Keycloak, Authentik, Google, Okta …). OIDC/OAuth2 only — SAML is not supported.
 * HTTP routes: packages/api-gateway/src/routes/sso.ts. Docs: docs/sso-ldap.md.
 */
export {
  listPublicProviders, startSso, completeSsoCallback, exchangeSsoCode, describeDiscovery, invalidateOidcClient,
  getOidcClient, ssoRedirectUri, SSO_COOKIE, SSO_STATE_TTL, SSO_EXCHANGE_TTL, SSO_LINK_PREFIX,
  type SsoTarget, type SsoError, type StartResult, type CallbackResult, type ExchangeResult, type SsoProviderRow,
} from './oidc.js';
