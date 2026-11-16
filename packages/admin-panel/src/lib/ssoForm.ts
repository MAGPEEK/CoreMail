/**
 * BCP → SSO (9.1.x review): claim map of the provider form. The form edits
 * only the `email` claim; other stored claims are kept. An emptied field
 * removes the custom email claim (the server then uses the default `email`).
 */
export function ssoClaimMap(stored: Record<string, string> | undefined, emailClaim: string): Record<string, string> {
  const { email: _old, ...rest } = stored ?? {};
  const email = emailClaim.trim();
  return email ? { ...rest, email } : rest;
}
