/**
 * BCP connection test: really connects (TLS as configured), binds with the
 * service account and searches — instead of the pre-v6.1 TCP port check.
 * Optionally looks up one login e-mail (no password involved).
 */
import { buildSyncFilter, buildUserFilter } from './filter.js';
import { attrValues, isSizeLimitError, mailAttr, serviceBind, toLdapSettings, type LdapConfigRow } from './client.js';

export interface LdapTestResult {
  success: boolean;
  message: string;
  steps: { step: string; ok: boolean; detail?: string }[];
  usersFound?: number | string;
  lookup?: { email: string; found: boolean; dn?: string; mailMatches?: boolean; ambiguous?: boolean };
}

export async function testLdapConnection(row: LdapConfigRow, lookupEmail?: string): Promise<LdapTestResult> {
  const s = toLdapSettings(row);
  const steps: LdapTestResult['steps'] = [];
  const transport = s.ssl ? 'LDAPS' : s.startTls ? 'StartTLS' : 'unencrypted';
  let client;
  try {
    client = await serviceBind(s);
    steps.push({ step: 'connect', ok: true, detail: `${s.host}:${s.port} (${transport}, certificate check ${s.tlsVerify ? 'on' : 'OFF'})` });
    steps.push({ step: 'bind', ok: true, detail: s.bindDN });
  } catch (err) {
    const msg = (err as Error).message;
    steps.push({ step: 'connect/bind', ok: false, detail: msg });
    return { success: false, message: `Connection or service-account bind failed: ${msg}`, steps };
  }

  const result: LdapTestResult = { success: true, message: '', steps };
  try {
    try {
      const { searchEntries } = await client.search(s.userDN, {
        scope: 'sub', filter: buildSyncFilter(mailAttr(s), s.groupFilter), attributes: [mailAttr(s)], sizeLimit: 25,
      });
      result.usersFound = searchEntries.length;
    } catch (err) {
      if (!isSizeLimitError(err)) throw err;
      result.usersFound = '25+';
    }
    steps.push({ step: 'search', ok: true, detail: `${result.usersFound} user(s) with ${mailAttr(s)} under ${s.userDN}` });

    if (lookupEmail) {
      const email = lookupEmail.trim().toLowerCase();
      try {
        const { searchEntries } = await client.search(s.userDN, {
          scope: 'sub', filter: buildUserFilter(s.userFilter, email), attributes: [mailAttr(s)], sizeLimit: 2,
        });
        const e = searchEntries[0];
        result.lookup = e
          ? { email, found: true, dn: e.dn, mailMatches: attrValues(e[mailAttr(s)]).some((m) => m.toLowerCase() === email), ambiguous: searchEntries.length > 1 }
          : { email, found: false };
      } catch (err) {
        if (!isSizeLimitError(err)) throw err;
        result.lookup = { email, found: true, ambiguous: true };
      }
    }
    result.message = `Bind and search successful (${transport})`;
  } catch (err) {
    const msg = (err as Error).message;
    steps.push({ step: 'search', ok: false, detail: msg });
    result.success = false;
    result.message = `Search failed: ${msg}`;
  } finally {
    await client.unbind().catch(() => undefined);
  }
  return result;
}
