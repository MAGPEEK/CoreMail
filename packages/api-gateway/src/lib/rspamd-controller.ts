/**
 * v8.1: authentication for rspamd controller calls made by the api-gateway
 * (Bayes learning from "mark as junk", BCP action thresholds / stats): the
 * `Password` header from RSPAMD_CONTROLLER_PASSWORD when set, so the
 * controller does not have to trust the app's IP. Never logged; CR/LF refused.
 * Same contract as security-filter `rspamdControllerHeaders()`.
 */
export function rspamdControllerHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const pw = env['RSPAMD_CONTROLLER_PASSWORD'] ?? '';
  if (!pw || /[\r\n\0]/.test(pw)) return {};
  return { Password: pw };
}
