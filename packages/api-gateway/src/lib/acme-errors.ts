/**
 * ACME error classification (pure, unit-testable).
 *
 * Turns what Let's Encrypt reports (problem document `type` + `detail`, or the
 * plain error text acme-client throws) into a stable error code plus a readable
 * message for the BCP. The original detail from Let's Encrypt is always kept in
 * the message — "connection refused", "CAA", "rate limited" must reach the
 * admin verbatim.
 */

export type AcmeErrorCode =
  | 'connection'          // CA could not connect / timed out on port 80
  | 'unauthorized'        // CA reached a server, but the token was missing / wrong (404, other host)
  | 'dns'                 // NXDOMAIN, SERVFAIL, no A/AAAA record
  | 'caa'                 // CAA records forbid Let's Encrypt
  | 'rate-limited'        // Let's Encrypt rate limit
  | 'rejected-identifier' // name not allowed (no public suffix, blocked name, IP …)
  | 'tls'                 // redirect to HTTPS with a broken TLS setup
  | 'account'             // account / contact e-mail rejected
  | 'local-serving'       // this server does not serve its own challenge token
  | 'network'             // this server cannot reach Let's Encrypt
  | 'server'              // Let's Encrypt internal error / maintenance
  | 'timeout'             // whole process exceeded its time budget
  | 'interrupted'         // process killed (server restart)
  | 'unknown';

export const ACME_ERROR_CODES: readonly AcmeErrorCode[] = [
  'connection', 'unauthorized', 'dns', 'caa', 'rate-limited', 'rejected-identifier', 'tls',
  'account', 'local-serving', 'network', 'server', 'timeout', 'interrupted', 'unknown',
];

/** An ACME failure with a classified code; `detail` is what the CA (or the check) reported. */
export class AcmeProblemError extends Error {
  readonly code: AcmeErrorCode;
  readonly detail: string;
  readonly domain: string | undefined;
  readonly acmeType: string | undefined;
  constructor(code: AcmeErrorCode, detail: string, opts: { domain?: string; acmeType?: string; message?: string } = {}) {
    super(opts.message ?? describeAcmeProblem(code, detail, opts.domain));
    this.name = 'AcmeProblemError';
    this.code = code;
    this.detail = detail;
    this.domain = opts.domain;
    this.acmeType = opts.acmeType;
  }
}

const TYPE_PREFIX = 'urn:ietf:params:acme:error:';

/**
 * Classifies a problem by its ACME error type (preferred) or, when only text is
 * available (acme-client throws `Error(detail)`), by the wording Let's Encrypt
 * uses in its detail messages.
 */
export function classifyAcmeProblem(type: string | null | undefined, detail: string): AcmeErrorCode {
  const t = (type ?? '').startsWith(TYPE_PREFIX) ? (type ?? '').slice(TYPE_PREFIX.length) : (type ?? '');
  switch (t) {
    case 'connection':          return 'connection';
    case 'dns':                 return 'dns';
    case 'caa':                 return 'caa';
    case 'rateLimited':         return 'rate-limited';
    case 'rejectedIdentifier':  return 'rejected-identifier';
    case 'unsupportedIdentifier': return 'rejected-identifier';
    case 'tls':                 return 'tls';
    case 'unauthorized':
    case 'incorrectResponse':   return classifyText(detail) === 'connection' ? 'connection' : 'unauthorized';
    case 'invalidContact':
    case 'unsupportedContact':
    case 'accountDoesNotExist':
    case 'externalAccountRequired':
    case 'userActionRequired':  return 'account';
    case 'serverInternal':      return 'server';
    default:                    return classifyText(detail);
  }
}

function classifyText(detail: string): AcmeErrorCode {
  const d = detail.toLowerCase();
  if (/too many|rate ?limit/.test(d)) return 'rate-limited';
  if (/\bcaa\b/.test(d)) return 'caa';
  if (/nxdomain|servfail|dns problem|no valid (a|aaaa) records|no such host/.test(d)) return 'dns';
  if (/connection refused|timeout during connect|connection reset|no route to host|network is unreachable|firewall|timeout after connect|i\/o timeout|connection timed out/.test(d)) return 'connection';
  if (/invalid response from|404|403|wrong key ?authorization|key ?authorization mismatch|authorization not found/.test(d)) return 'unauthorized';
  if (/tls handshake|certificate|x509|tls error/.test(d) && /https/.test(d)) return 'tls';
  if (/policy forbids|blocklist|blocked|does not end with a valid public suffix|invalid identifier|cannot issue for/.test(d)) return 'rejected-identifier';
  if (/contact|e-?mail address|mailto/.test(d)) return 'account';
  if (/service unavailable|internal server error|bad gateway|maintenance|\b5\d\d\b/.test(d)) return 'server';
  return 'unknown';
}

const SUMMARY: Record<AcmeErrorCode, string> = {
  'connection':          'Let\'s Encrypt could not connect to the server on port 80 (connection refused, timed out or blocked by a firewall). Port 80 must be reachable from the internet and forwarded to CoreMail.',
  'unauthorized':        'Let\'s Encrypt reached a web server, but it did not return the expected validation token. Check that the domain points to this server and that port 80 is forwarded to CoreMail (not to another web server or router page).',
  'dns':                 'Let\'s Encrypt could not resolve the domain. Create an A (and, if used, AAAA) record that points to this server.',
  'caa':                 'A CAA record of the domain does not allow Let\'s Encrypt to issue certificates. Add the CAA record 0 issue "letsencrypt.org" or remove the restriction.',
  'rate-limited':        'Let\'s Encrypt rate limit reached. Wait until the time given below before retrying; use the staging environment for tests.',
  'rejected-identifier': 'Let\'s Encrypt does not issue certificates for this name (it must be a public domain name).',
  'tls':                 'Let\'s Encrypt followed a redirect to HTTPS and the TLS connection failed.',
  'account':             'Let\'s Encrypt rejected the account request (check the contact e-mail address).',
  'local-serving':       'This server does not serve its own validation token under /.well-known/acme-challenge/ — the request was not sent to Let\'s Encrypt.',
  'network':             'This server cannot reach Let\'s Encrypt (outbound HTTPS or DNS of the server is not working).',
  'server':              'Let\'s Encrypt is temporarily unavailable. Try again later.',
  'timeout':             'Certificate issuance did not finish in time.',
  'interrupted':         'Certificate issuance was interrupted (server restart). Start it again.',
  'unknown':             'Certificate issuance failed.',
};

/** Readable one-paragraph message: summary + domain + what the CA reported. */
export function describeAcmeProblem(code: AcmeErrorCode, detail: string, domain?: string): string {
  const where = domain ? ` [${domain}]` : '';
  const reported = detail.trim() ? ` Reported: ${detail.trim()}` : '';
  return `${SUMMARY[code]}${where}${reported}`;
}

/** acme-client turns every network-level failure into this TypeError (no HTTP response). */
export function isAcmeNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { isAxiosError?: boolean; response?: unknown; code?: string };
  if (e.isAxiosError && !e.response) return true;
  return e instanceof TypeError && /reading 'config'/.test(e.message);
}

/**
 * Normalises any error thrown during issuance into `{ code, message }` for
 * Certificate.lastErrorCode / lastError.
 */
export function toAcmeFailure(err: unknown): { code: AcmeErrorCode; message: string } {
  if (err instanceof AcmeProblemError) return { code: err.code, message: err.message };
  const raw = err instanceof Error ? err.message : String(err);
  if (isAcmeNetworkError(err)) {
    return { code: 'network', message: describeAcmeProblem('network', raw) };
  }
  const code = classifyAcmeProblem(null, raw);
  return { code, message: describeAcmeProblem(code, raw) };
}

/** Problem object of an invalid authorization / challenge / order (`error` field). */
export function problemFromAcmeObject(
  obj: { error?: unknown; challenges?: Array<{ status?: string; error?: unknown; type?: string }> } | null | undefined,
): { type: string | undefined; detail: string } | null {
  if (!obj) return null;
  const candidates: unknown[] = [];
  for (const ch of obj.challenges ?? []) if (ch?.error) candidates.push(ch.error);
  if (obj.error) candidates.push(obj.error);
  for (const c of candidates) {
    if (c && typeof c === 'object') {
      const p = c as { type?: unknown; detail?: unknown; subproblems?: Array<{ detail?: unknown }> };
      const sub = Array.isArray(p.subproblems)
        ? p.subproblems.map(s => (typeof s?.detail === 'string' ? s.detail : '')).filter(Boolean).join('; ')
        : '';
      const detail = [typeof p.detail === 'string' ? p.detail : '', sub].filter(Boolean).join(' — ');
      return { type: typeof p.type === 'string' ? p.type : undefined, detail: detail || JSON.stringify(c) };
    }
  }
  return null;
}
