/**
 * Admin MCP interface (10.3) — shaping of tool results, pure.
 *
 *  - stripSecrets(): removes every field that could carry a secret (passwords,
 *    hashes, private keys, TOTP / backup codes, tokens) from a result — defence
 *    in depth on top of the admin routes, which never select them;
 *  - capResult(): keeps the JSON text of a result under the size cap (lists are
 *    shortened, with `truncated` + a hint to narrow the filter);
 *  - redactArguments(): tool arguments for the audit log, never a secret.
 */

/** Field names (lower-case) never returned by a tool, at any depth. */
export const SECRET_FIELDS: ReadonlySet<string> = new Set([
  'password', 'passwordhash', 'newpassword', 'currentpassword', 'hash', 'tokenhash',
  'secret', 'clientsecret', 'secretkey', 'accesskey', 'apikey',
  'token', 'accesstoken', 'refreshtoken', 'bearer',
  'privatekey', 'dkimprivatekey', 'keypem', 'tlskey', 'chainpem', 'certpem', 'acmeaccount', 'accountkey',
  'totpsecret', 'backupcodes', 'webauthncredentials', 'mfasecret',
  'bindpassword', 'binddn_password', 'smtppassword', 'relaypassword', 'upstreampassword',
  'p256dhkey', 'authkey', 'vapidprivatekey', 'encryptionkey',
  // 10.6: passkeys — WebAuthn public keys, user handles, recovery tokens
  'publickey', 'webauthnuserid', 'userhandle', 'recoverytoken', 'recoveryurl',
]);

export function isSecretField(key: string): boolean {
  return SECRET_FIELDS.has(key.toLowerCase());
}

/** Pure: a deep copy of `value` without secret fields (Dates → ISO strings, bigint → number). */
export function stripSecrets(value: unknown, depth = 0): unknown {
  if (depth > 32) return null;
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretField(k) || v === undefined) continue;
      out[k] = stripSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** The longest array of a result (top level or a direct property) — what capResult() shortens. */
function largestArray(value: unknown): { get: () => unknown[]; set: (a: unknown[]) => void } | null {
  if (Array.isArray(value)) return null; // handled by the caller (wrapped)
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  let best: string | null = null;
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && (best === null || JSON.stringify(v).length > JSON.stringify(obj[best]).length)) best = k;
  }
  if (best === null) return null;
  const key = best;
  return { get: () => obj[key] as unknown[], set: (a) => { obj[key] = a; } };
}

/**
 * Pure: the JSON text of a result, at most `maxBytes` long. A too large list is
 * shortened (halving) and marked `{ truncated: true, returned, note }`; a
 * result that cannot be shortened becomes `{ truncated: true, error }`.
 */
export function capResult(value: unknown, maxBytes: number): string {
  const text = JSON.stringify(value) ?? 'null';
  if (bytes(text) <= maxBytes) return text;
  const note = 'Result truncated to the size limit — narrow the filter or use paging.';
  const wrapped: Record<string, unknown> = Array.isArray(value) ? { items: [...value] } : { ...(value as Record<string, unknown>) };
  const arr = largestArray(wrapped);
  if (arr) {
    let items = arr.get();
    const total = items.length;
    while (items.length > 0) {
      items = items.slice(0, Math.floor(items.length / 2));
      arr.set(items);
      const candidate = JSON.stringify({ ...wrapped, truncated: true, returned: items.length, of: total, note });
      if (bytes(candidate) <= maxBytes) return candidate;
    }
  }
  return JSON.stringify({ truncated: true, error: 'The result is larger than the size limit.', note });
}

/** Argument names whose value is never written to the audit log. */
const SECRET_ARGUMENTS = /pass(word)?|secret|token|key/i;

/** Pure: tool arguments for the audit log — secrets replaced, long strings cut. */
export function redactArguments(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    if (SECRET_ARGUMENTS.test(k)) { out[k] = '[redacted]'; continue; }
    if (typeof v === 'string') out[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else out[k] = JSON.stringify(v).slice(0, 200);
  }
  return out;
}
