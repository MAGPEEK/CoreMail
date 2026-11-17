/**
 * Scanner deployment detection (9.3): is rspamd / ClamAV part of this
 * installation at all?
 *
 * Per scanner one state:
 *  - `absent`      the scanner is not deployed: switched off EXPLICITLY by the
 *                  environment (RSPAMD_ENABLED=false / CLAMAV_ENABLED=false — minimal
 *                  compose, Helm chart without the scanner). Nothing else makes a
 *                  scanner absent. The pipeline skips it silently — no "unscanned"
 *                  header, no 451 deferral from clamavBlockOnFailure — and the BCP
 *                  hides its settings.
 *  - `unavailable` the scanner does not answer: its host name does not exist in DNS
 *                  (reason `host-not-found` — a stopped container drops out of the
 *                  compose network, a misspelt CLAMAV_HOST / RSPAMD_URL), any other
 *                  DNS failure, or no / a wrong ping reply (container starting,
 *                  ClamAV loading signatures, crashed). The configured failure
 *                  policy and the X-CoreMail-Virus-Scan header apply unchanged.
 *  - `available`   the scanner answered its ping.
 *
 * Checked at start and re-checked periodically (SCANNER_CHECK_INTERVAL_SEC,
 * default 300 s), so a scanner that comes back is picked up without a restart.
 * A failing check never switches scanning off: the env switches are read once
 * when the detector is created, and CapabilityMonitor never moves a scanner into
 * `absent` after the first check.
 *
 * The report never contains host names, URLs or credentials: `reason` is a fixed
 * code and `detail` an error code such as ECONNREFUSED.
 */
import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';
import { createLogger } from '@coremail/core';
import type { PipelineConfig } from './pipeline/index.js';
import { isEnvOff } from './settings.js';
import { CLAMAV_HOST, clamdCommand } from './clamav/index.js';
import { getRspamdEndpoints } from './rspamd/index.js';

const log = createLogger('security-filter:capabilities');

export type ScannerName = 'rspamd' | 'clamav';
export type ScannerState = 'absent' | 'unavailable' | 'available';
export type ScannerReason =
  | 'disabled-by-config'   // RSPAMD_ENABLED / CLAMAV_ENABLED = false
  | 'host-not-found'       // host name does not exist in DNS
  | 'dns-error'            // DNS lookup failed for another reason
  | 'connect-failed'       // connection refused / reset / unreachable
  | 'timeout'              // no answer in time
  | 'bad-response'         // answered, but not with the expected ping reply
  | 'ok'
  | 'not-checked';         // before the first check

export interface ScannerCapability {
  state: ScannerState;
  reason: ScannerReason;
  /** Error code only (e.g. ECONNREFUSED, HTTP 503) — never a host or URL. */
  detail?: string;
  /** ISO time of the last check (null before the first one). */
  checkedAt: string | null;
}

export type ScannerCapabilities = Record<ScannerName, ScannerCapability>;

export interface ScannerTarget {
  /** Explicitly switched off by the environment. */
  envDisabled: boolean;
  /** Host name or IP literal of the scanner. */
  host: string;
  /** Resolves when the scanner answers its ping; rejects otherwise. */
  probe: (timeoutMs: number) => Promise<void>;
}

export interface DetectDeps {
  lookup: (host: string) => Promise<unknown>;
  timeoutMs: number;
  now: () => number;
}

/** DNS error codes meaning "this name does not exist". */
const NOT_FOUND_CODES = new Set(['ENOTFOUND', 'ENODATA', 'EAI_NONAME', 'EAI_NODATA', 'NXDOMAIN']);

class ProbeTimeout extends Error { constructor() { super('timeout'); this.name = 'ProbeTimeout'; } }
export class BadResponse extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'BadResponse'; }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ProbeTimeout()), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}

/** Pure: a short error code without host names / URLs (fetch wraps the socket error in `cause`). */
export function errorCode(err: unknown): string | undefined {
  if (err instanceof BadResponse) return err.code;
  const e = err as { code?: unknown; cause?: { code?: unknown }; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code
    : typeof e?.cause?.code === 'string' ? e.cause.code
    : undefined;
  return code && /^[A-Z0-9_]{2,40}$/.test(code) ? code : undefined;
}

function isTimeout(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown; message?: unknown; cause?: { code?: unknown } } | null;
  return err instanceof ProbeTimeout
    || e?.name === 'TimeoutError' || e?.name === 'AbortError'
    || e?.code === 'ETIMEDOUT' || e?.cause?.code === 'ETIMEDOUT' || e?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT'
    || e?.message === 'timeout';
}

/** Determine the deployment state of one scanner (deps injectable for tests). */
export async function detectScanner(target: ScannerTarget, deps: DetectDeps): Promise<ScannerCapability> {
  const checkedAt = new Date(deps.now()).toISOString();
  if (target.envDisabled) return { state: 'absent', reason: 'disabled-by-config', checkedAt };

  const host = target.host.replace(/^\[|\]$/g, '');
  if (isIP(host) === 0) {
    try {
      await withTimeout(deps.lookup(host), deps.timeoutMs);
    } catch (err) {
      const code = errorCode(err);
      // A name that does not exist is NOT "not deployed": a stopped container drops out
      // of the compose DNS, and a typo in CLAMAV_HOST must not switch virus scanning off.
      if (code && NOT_FOUND_CODES.has(code)) return { state: 'unavailable', reason: 'host-not-found', detail: code, checkedAt };
      return {
        state: 'unavailable',
        reason: isTimeout(err) ? 'timeout' : 'dns-error',
        ...(code ? { detail: code } : {}),
        checkedAt,
      };
    }
  }

  try {
    await withTimeout(target.probe(deps.timeoutMs), deps.timeoutMs);
    return { state: 'available', reason: 'ok', checkedAt };
  } catch (err) {
    const code = errorCode(err);
    const reason: ScannerReason = err instanceof BadResponse ? 'bad-response' : isTimeout(err) ? 'timeout' : 'connect-failed';
    return { state: 'unavailable', reason, ...(code ? { detail: code } : {}), checkedAt };
  }
}

/**
 * Pure: the pipeline config with absent scanners switched off. An absent
 * scanner (explicit env switch only) is skipped like a scanner disabled in the
 * BCP — no "unscanned" note, no deferral. `unavailable` (including
 * `host-not-found`) / `available` leave the config untouched.
 */
export function applyScannerCapabilities(cfg: PipelineConfig, caps: ScannerCapabilities): PipelineConfig {
  return {
    ...cfg,
    ...(caps.rspamd.state === 'absent' ? { rspamdEnabled: false } : {}),
    ...(caps.clamav.state === 'absent' ? { clamavEnabled: false } : {}),
  };
}

const NOT_CHECKED: ScannerCapability = { state: 'unavailable', reason: 'not-checked', checkedAt: null };

export type Detector = (name: ScannerName) => Promise<ScannerCapability>;

/** Cached capability state with a periodic re-check. */
export class CapabilityMonitor {
  private caps: ScannerCapabilities = { rspamd: NOT_CHECKED, clamav: NOT_CHECKED };
  private lastCheck = 0;
  private inflight: Promise<ScannerCapabilities> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private first = true;

  constructor(
    private readonly detect: Detector,
    private readonly now: () => number = () => Date.now(),
    private readonly logger: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void } = log,
  ) {}

  get(): ScannerCapabilities { return this.caps; }

  /** Re-check both scanners (concurrent calls share one run). */
  refresh(): Promise<ScannerCapabilities> {
    if (!this.inflight) {
      this.inflight = (async () => {
        const [rspamd, clamav] = await Promise.all([this.detect('rspamd'), this.detect('clamav')]);
        const next: ScannerCapabilities = { rspamd: this.guard('rspamd', rspamd), clamav: this.guard('clamav', clamav) };
        this.logChanges(next);
        this.caps = next;
        this.lastCheck = this.now();
        this.first = false;
        return next;
      })().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  /** The cached state, re-checked first when older than maxAgeMs. */
  async ensureFresh(maxAgeMs: number): Promise<ScannerCapabilities> {
    if (this.lastCheck === 0 || this.now() - this.lastCheck > maxAgeMs) return this.refresh();
    return this.caps;
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * `absent` is decided by the first check only (the env switches). A later check
   * reporting `absent` for a scanner that was not absent is kept as `unavailable` —
   * scanning is never switched off at runtime.
   */
  private guard(name: ScannerName, cur: ScannerCapability): ScannerCapability {
    if (this.first || cur.state !== 'absent' || this.caps[name].state === 'absent') return cur;
    return { ...cur, state: 'unavailable' };
  }

  /** One log line per scanner at start and on every state change — never per message. */
  private logChanges(next: ScannerCapabilities): void {
    for (const name of ['rspamd', 'clamav'] as const) {
      const prev = this.caps[name];
      const cur = next[name];
      if (!this.first && prev.state === cur.state) continue;
      const fields = { scanner: name, state: cur.state, reason: cur.reason, ...(cur.detail ? { detail: cur.detail } : {}) };
      if (cur.state === 'absent') {
        this.logger.info(fields, `${name} is not deployed in this installation — ${name === 'clamav' ? 'virus' : 'spam'} scanning is skipped`);
      } else if (cur.state === 'available') {
        this.logger.info(fields, `${name} is available`);
      } else if (cur.reason === 'host-not-found') {
        const hostVar = name === 'clamav' ? 'CLAMAV_HOST' : 'RSPAMD_URL';
        const envVar = name === 'clamav' ? 'CLAMAV_ENABLED' : 'RSPAMD_ENABLED';
        this.logger.warn(fields, `${name} host name not found — the configured failure policy applies; check ${hostVar} or set ${envVar}=false if the scanner is not deployed`);
      } else {
        this.logger.warn(fields, `${name} is not reachable — the configured failure policy applies`);
      }
    }
  }
}

/** Production detector: env switches, DNS lookup of the configured host, scanner ping. */
export function defaultDetector(env: NodeJS.ProcessEnv = process.env, timeoutMs = 3_000): Detector {
  const deps: DetectDeps = {
    lookup: (host) => dnsPromises.lookup(host),
    timeoutMs,
    now: () => Date.now(),
  };
  // Read once: the env switches are the only way into `absent` and do not change at runtime.
  const clamavOff = isEnvOff(env['CLAMAV_ENABLED']);
  const rspamdOff = isEnvOff(env['RSPAMD_ENABLED']);
  return (name) => {
    if (name === 'clamav') {
      return detectScanner({
        envDisabled: clamavOff,
        host: CLAMAV_HOST,
        probe: async (ms) => {
          const reply = await clamdCommand('PING', ms);
          if (!/PONG/i.test(reply)) throw new BadResponse('UNEXPECTED_REPLY');
        },
      }, deps);
    }
    const ep = getRspamdEndpoints();
    let host = 'rspamd';
    try { host = new URL(ep.scan).hostname; } catch { /* endpoints are validated in rspamd/index.ts */ }
    return detectScanner({
      envDisabled: rspamdOff,
      host,
      // /ping needs no authentication on the normal worker and the controller
      probe: async (ms) => {
        const r = await fetch(`${ep.scan}/ping`, { signal: AbortSignal.timeout(ms) });
        if (!r.ok) throw new BadResponse(`HTTP_${r.status}`);
        await r.body?.cancel().catch(() => undefined);
      },
    }, deps);
  };
}

/** Re-check interval: SCANNER_CHECK_INTERVAL_SEC (default 300, at least 30). */
export function checkIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env['SCANNER_CHECK_INTERVAL_SEC'] ?? '', 10);
  return (Number.isFinite(n) && n >= 30 ? n : 300) * 1000;
}
