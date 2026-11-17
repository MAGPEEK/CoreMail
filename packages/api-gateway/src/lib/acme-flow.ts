/**
 * ACME HTTP-01 order flow (v9.2.x fix).
 *
 * Replaces acme-client's `client.auto()`, which made certificate issuance hang
 * on servers that cannot reach their own public address (Docker / NAT without
 * hairpin routing — the typical CoreMail setup):
 *
 *  - auto() first "verifies" the challenge itself by fetching
 *    http://<domain>/.well-known/acme-challenge/<token> FROM the server, with no
 *    HTTP timeout and up to 10 retries (+ 5 axios retries each). Without hairpin
 *    NAT every attempt waits for the TCP connect timeout, so Let's Encrypt was
 *    never even asked to validate and the 5-minute guard aborted with a generic
 *    message. Here the token is checked over loopback (fast, proves the route
 *    and the token store) and the public-address fetch is informational only.
 *  - every network call is bounded (HTTP timeout + abort), polling uses
 *    abortable sleeps, so a cancelled run stops within seconds instead of
 *    keeping the renewal lock for hours;
 *  - failures carry Let's Encrypt's problem detail and a classified code
 *    (lib/acme-errors.ts) instead of disappearing behind the timeout.
 *
 * The ACME client and the challenge serving are injected (unit tests use a
 * fake CA; production uses acme-client, see lib/cert-acme.ts).
 */
import http from 'node:http';
import {
  AcmeProblemError, classifyAcmeProblem, isAcmeNetworkError, problemFromAcmeObject,
} from './acme-errors.js';

// ── Minimal ACME client surface (acme-client 5.x compatible) ─────────────────

export interface AcmeChallengeLike { type: string; url: string; status?: string; token?: string; error?: unknown }
export interface AcmeAuthzLike {
  url?: string;
  status: string;
  identifier: { type: string; value: string };
  challenges: AcmeChallengeLike[];
  error?: unknown;
}
export interface AcmeOrderLike {
  url?: string;
  status: string;
  authorizations?: string[];
  finalize?: string;
  certificate?: string;
  error?: unknown;
}

export interface AcmeClientLike {
  createAccount(data: { termsOfServiceAgreed: boolean; contact?: string[] }): Promise<unknown>;
  createOrder(data: { identifiers: Array<{ type: 'dns'; value: string }> }): Promise<AcmeOrderLike>;
  getOrder(order: AcmeOrderLike): Promise<AcmeOrderLike>;
  getAuthorizations(order: AcmeOrderLike): Promise<AcmeAuthzLike[]>;
  getChallengeKeyAuthorization(challenge: AcmeChallengeLike): Promise<string>;
  completeChallenge(challenge: AcmeChallengeLike): Promise<unknown>;
  deactivateAuthorization(authz: AcmeAuthzLike): Promise<unknown>;
  finalizeOrder(order: AcmeOrderLike, csr: Buffer | string): Promise<AcmeOrderLike>;
  getCertificate(order: AcmeOrderLike): Promise<string>;
}

/** How this server publishes HTTP-01 tokens and checks that it serves them. */
export interface ChallengeServing {
  store(token: string, keyAuthorization: string): Promise<void>;
  remove(token: string): Promise<void>;
  /** Fetch the token from this server over loopback (Host: domain). Fatal when wrong. */
  checkLocal?(domain: string, token: string): Promise<HttpTextResult>;
  /** Fetch http://<domain>/… from this server — informational (hairpin NAT often missing). */
  checkPublic?(domain: string, token: string): Promise<HttpTextResult>;
}

export type AcmeStep =
  | 'account' | 'order' | 'authorizations' | 'challenge' | 'local-check' | 'public-check'
  | 'validate' | 'validated' | 'finalize' | 'download' | 'retry';

export interface AcmeFlowOptions {
  domains: string[];
  /** PEM CSR — required unless validateOnly. */
  csr?: Buffer | string;
  email?: string | undefined;
  signal: AbortSignal;
  /** Stop after the domains are validated and deactivate the authorizations (pre-flight test). */
  validateOnly?: boolean;
  pollIntervalMs?: number;
  validationTimeoutMs?: number;
  finalizeTimeoutMs?: number;
  /** Retries of a step after a network-level failure (no HTTP response). */
  networkRetries?: number;
  /** Upper bound of the informational public-address fetch (default 6 s). */
  publicCheckTimeoutMs?: number;
  onStep?: (step: AcmeStep, info?: Record<string, unknown>) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface AcmeFlowResult {
  /** Full chain PEM (leaf first) — absent for validateOnly. */
  certificate?: string;
  /** Result of the informational public-address fetch per domain ('ok' or a reason). */
  publicCheck: Record<string, string>;
}

// ── Abort helpers ─────────────────────────────────────────────────────────────

export function abortReason(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  return r instanceof Error ? r : new Error('Aborted');
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

/** Resolves/rejects like `p`, but rejects immediately once `signal` aborts. */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/** Rejects with `{ code: 'ETIMEDOUT' }` when `p` does not settle within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error(message), { code: 'ETIMEDOUT' })), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortReason(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ── acme-client HTTP settings ────────────────────────────────────────────────

/** Per-request HTTP timeout for every call to the CA. */
export const ACME_HTTP_TIMEOUT_MS = 30_000;

interface AcmeAxiosLike {
  defaults: { timeout?: number; acmeSettings?: { retryMaxAttempts?: number; retryDefaultDelay?: number } };
}
const configuredAxios = new WeakSet<object>();

/**
 * acme-client's axios instance has no timeout and retries with sleeps it cannot
 * cancel (Retry-After of a rate limit can be hours). Bound every request and
 * disable the hidden retries — the flow retries network errors itself.
 */
export function configureAcmeHttp(acmeModule: { axios: unknown }): void {
  const ax = acmeModule.axios as AcmeAxiosLike | undefined;
  if (!ax || configuredAxios.has(ax)) return;
  ax.defaults.timeout = ACME_HTTP_TIMEOUT_MS;
  ax.defaults.acmeSettings = { ...(ax.defaults.acmeSettings ?? {}), retryMaxAttempts: 0 };
  configuredAxios.add(ax);
}

// ── Plain HTTP GET (challenge self-checks) ───────────────────────────────────

export interface HttpTextResult { status: number; body: string; location?: string }

/** GET with a hard timeout; body capped at 4 KiB; redirects are not followed. */
export function httpGetText(url: string, opts: { host?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<HttpTextResult> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, {
      timeout: opts.timeoutMs ?? 5_000,
      headers: { 'user-agent': 'CoreMail-ACME-selfcheck', ...(opts.host ? { host: opts.host } : {}) },
      ...(opts.signal ? { signal: opts.signal } : {}),
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { if (body.length < 4096) body += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: body.slice(0, 4096),
        ...(typeof res.headers.location === 'string' ? { location: res.headers.location } : {}),
      }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`no answer within ${Math.round((opts.timeoutMs ?? 5_000) / 1000)} s`), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  });
}

/** Short reason for a failed self-check fetch. */
export function describeFetchError(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e?.code === 'ECONNREFUSED') return 'connection refused';
  if (e?.code === 'ETIMEDOUT') return e.message ?? 'timed out';
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN') return `name does not resolve (${e.code})`;
  if (e?.code === 'EHOSTUNREACH' || e?.code === 'ENETUNREACH') return `unreachable (${e.code})`;
  return e?.message ?? String(err);
}

// ── The flow ─────────────────────────────────────────────────────────────────

const CHALLENGE_PATH = '/.well-known/acme-challenge/';

export async function runAcmeFlow(
  client: AcmeClientLike,
  serving: ChallengeServing,
  opts: AcmeFlowOptions,
): Promise<AcmeFlowResult> {
  const { signal } = opts;
  const sleep = opts.sleep ?? abortableSleep;
  const pollMs = opts.pollIntervalMs ?? 2_000;
  const retries = opts.networkRetries ?? 2;
  const step = (s: AcmeStep, info?: Record<string, unknown>) => { opts.onStep?.(s, info); };
  if (!opts.validateOnly && !opts.csr) throw new Error('runAcmeFlow: csr required');

  /** One CA call: abortable, network errors retried, everything else classified. */
  async function call<T>(label: string, fn: () => Promise<T>, domain?: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(signal);
      try {
        return await raceAbort(fn(), signal);
      } catch (err) {
        if (signal.aborted) throw abortReason(signal);
        if (err instanceof AcmeProblemError) throw err;
        if (isAcmeNetworkError(err)) {
          if (attempt < retries) {
            step('retry', { label, attempt: attempt + 1 });
            await sleep(2_000 * (attempt + 1), signal);
            continue;
          }
          throw new AcmeProblemError('network', `no response from the certificate authority during "${label}" (network error or timeout)`,
            domain ? { domain } : {});
        }
        const detail = err instanceof Error ? err.message : String(err);
        throw new AcmeProblemError(classifyAcmeProblem(null, detail), detail, domain ? { domain } : {});
      }
    }
  }

  const publicCheck: Record<string, string> = {};
  const publishedTokens: string[] = [];
  const completed = new Set<string>();
  let authzs: AcmeAuthzLike[] = [];

  try {
    step('account');
    try {
      await call('account', () => client.createAccount({
        termsOfServiceAgreed: true,
        ...(opts.email ? { contact: [`mailto:${opts.email}`] } : {}),
      }));
    } catch (err) {
      // The contact address is optional for the CA: when it is refused
      // (invalid / unsupported contact), register without it instead of failing.
      if (!(opts.email && err instanceof AcmeProblemError && err.code === 'account')) throw err;
      step('account', { withoutContact: true, reason: err.detail });
      await call('account', () => client.createAccount({ termsOfServiceAgreed: true }));
    }

    step('order', { domains: opts.domains });
    const order = await call('order', () => client.createOrder({
      identifiers: opts.domains.map((value) => ({ type: 'dns' as const, value })),
    }));
    authzs = await call('authorizations', () => client.getAuthorizations(order));
    step('authorizations', { count: authzs.length });

    // Publish + self-check every pending authorization before asking the CA.
    const toComplete: Array<{ authz: AcmeAuthzLike; challenge: AcmeChallengeLike; domain: string }> = [];
    for (const authz of authzs) {
      const domain = authz.identifier.value;
      if (authz.status === 'valid') { completed.add(domain); continue; }
      if (authz.status !== 'pending') throw problemOf(authz, domain, `authorization is ${authz.status}`);
      const challenge = authz.challenges.find((c) => c.type === 'http-01');
      if (!challenge || !challenge.token) {
        throw new AcmeProblemError('rejected-identifier',
          `no HTTP validation offered for ${domain} (wildcard names need DNS validation)`, { domain });
      }
      const keyAuthorization = await call('key authorization', () => client.getChallengeKeyAuthorization(challenge), domain);
      await serving.store(challenge.token, keyAuthorization);
      publishedTokens.push(challenge.token);
      step('challenge', { domain });

      if (serving.checkLocal) {
        let res: HttpTextResult;
        try {
          res = await raceAbort(withTimeout(serving.checkLocal(domain, challenge.token), 10_000, 'no answer within 10 s'), signal);
        } catch (err) {
          if (signal.aborted) throw abortReason(signal);
          throw new AcmeProblemError('local-serving', `loopback request failed: ${describeFetchError(err)}`, { domain });
        }
        if (res.status !== 200 || res.body.trim() !== keyAuthorization) {
          throw new AcmeProblemError('local-serving',
            `GET ${CHALLENGE_PATH}<token> answered HTTP ${res.status}${res.location ? ` → ${res.location}` : ''} instead of the token`, { domain });
        }
        step('local-check', { domain });
      }
      if (serving.checkPublic) {
        try {
          // Informational and bounded: a server without hairpin NAT never gets
          // an answer here (this used to stall the whole issuance).
          const res = await raceAbort(withTimeout(serving.checkPublic(domain, challenge.token),
            opts.publicCheckTimeoutMs ?? 6_000, 'no answer from the public address'), signal);
          publicCheck[domain] = res.status === 200 && res.body.trim() === keyAuthorization
            ? 'ok'
            : `HTTP ${res.status}${res.status >= 300 && res.status < 400 ? ' (redirect)' : ''} (different content)`;
        } catch (err) {
          if (signal.aborted) throw abortReason(signal);
          publicCheck[domain] = describeFetchError(err);
        }
        step('public-check', { domain, result: publicCheck[domain] });
      }
      toComplete.push({ authz, challenge, domain });
    }

    for (const t of toComplete) {
      step('validate', { domain: t.domain });
      await call('start validation', () => client.completeChallenge(t.challenge), t.domain);
      completed.add(t.domain);
    }

    if (toComplete.length > 0) {
      await waitForAuthorizations(order);
    }
    step('validated', { domains: opts.domains });
    if (opts.validateOnly) return { publicCheck };

    step('finalize');
    let finalized = await call('finalize', () => client.finalizeOrder(order, opts.csr as Buffer | string));
    finalized = await waitForOrderValid(finalized);
    step('download');
    const certificate = await call('download', () => client.getCertificate(finalized));
    return { certificate, publicCheck };
  } finally {
    for (const token of publishedTokens) await serving.remove(token).catch(() => undefined);
    if (!signal.aborted) {
      // Pending authorizations that were never submitted (self-check failed) are
      // deactivated so a later order does not reuse them; a validation test
      // also drops its valid authorizations so the next test validates again.
      for (const a of authzs) {
        const domain = a.identifier.value;
        const drop = opts.validateOnly ? a.status !== 'invalid' : (a.status === 'pending' && !completed.has(domain));
        if (drop) await raceAbort(client.deactivateAuthorization(a), signal).catch(() => undefined);
      }
    }
  }

  function problemOf(obj: AcmeAuthzLike | AcmeOrderLike, domain: string | undefined, fallback: string): AcmeProblemError {
    const p = problemFromAcmeObject(obj as { error?: unknown; challenges?: AcmeChallengeLike[] });
    const detail = p?.detail ?? fallback;
    return new AcmeProblemError(classifyAcmeProblem(p?.type, detail), detail, {
      ...(domain ? { domain } : {}), ...(p?.type ? { acmeType: p.type } : {}),
    });
  }

  async function waitForAuthorizations(order: AcmeOrderLike): Promise<void> {
    const limit = opts.validationTimeoutMs ?? 120_000;
    const deadline = Date.now() + limit;
    for (;;) {
      const list = await call('validation status', () => client.getAuthorizations(order));
      let pending: string | null = null;
      for (const a of list) {
        if (a.status === 'valid') continue;
        if (a.status === 'pending') { pending = a.identifier.value; continue; }
        throw problemOf(a, a.identifier.value, `authorization is ${a.status}`);
      }
      if (!pending) return;
      if (Date.now() >= deadline) {
        throw new AcmeProblemError('timeout',
          `the certificate authority did not finish validating within ${Math.round(limit / 1000)} s (still pending)`, { domain: pending });
      }
      await sleep(pollMs, signal);
    }
  }

  async function waitForOrderValid(o: AcmeOrderLike): Promise<AcmeOrderLike> {
    const limit = opts.finalizeTimeoutMs ?? 120_000;
    const deadline = Date.now() + limit;
    let cur = o;
    for (;;) {
      if (cur.status === 'valid') return cur;
      if (cur.status === 'invalid') throw problemOf(cur, undefined, 'the order became invalid');
      if (Date.now() >= deadline) {
        throw new AcmeProblemError('timeout',
          `the certificate authority did not issue the certificate within ${Math.round(limit / 1000)} s (order ${cur.status})`);
      }
      await sleep(pollMs, signal);
      const url = cur.url ?? o.url;
      cur = await call('order status', () => client.getOrder({ ...cur, ...(url ? { url } : {}) }));
    }
  }
}
