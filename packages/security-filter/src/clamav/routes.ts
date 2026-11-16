/**
 * ClamAV status + EICAR self-test for the BCP (proxied by the api-gateway,
 * /api/v1/admin/security/clamav/*). Internal endpoints of the security filter.
 *
 *   GET  /clamav/status      clamd reachable?, engine + signature version/date (VERSION),
 *                            queue/threads (STATS, best effort)
 *   POST /clamav/eicar-test  scans the EICAR test message through the same path as
 *                            inbound mail (size limit, timeout, INSTREAM, policy)
 */
import type { Express } from 'express';
import {
  CLAMAV_HOST, CLAMAV_PORT, clamdCommand, parseClamdVersion, parseClamdStats, scanBuffer,
  eicarTestMessage, classifySignature,
  type ClamdVersion, type ClamdStats, type ClamavResult, type SignatureCategory,
} from './index.js';
import { evaluateClamav, scanWithPolicy, clamavCountsAsVirus, type PipelineConfig } from '../pipeline/index.js';

export interface ClamavStatusReport {
  host: string;
  port: number;
  /** ClamAV switched on in the BCP (and not forced off by CLAMAV_ENABLED=false). */
  enabled: boolean;
  online: boolean;
  latencyMs?: number;
  version?: ClamdVersion;
  stats?: ClamdStats;
  /** Age of the signature database in hours (from the VERSION date). */
  signatureAgeHours?: number;
  error?: string;
}

export interface StatusDeps {
  command: (cmd: 'VERSION' | 'STATS') => Promise<string>;
  now: () => number;
}

const defaultStatusDeps: StatusDeps = { command: (c) => clamdCommand(c), now: () => Date.now() };

export async function clamavStatus(config: PipelineConfig, deps: StatusDeps = defaultStatusDeps): Promise<ClamavStatusReport> {
  const base = { host: CLAMAV_HOST, port: CLAMAV_PORT, enabled: config.clamavEnabled !== false };
  const t0 = deps.now();
  let versionRaw: string;
  try {
    versionRaw = await deps.command('VERSION');
  } catch (err) {
    return { ...base, online: false, error: (err as Error).message };
  }
  const latencyMs = deps.now() - t0;
  const version = parseClamdVersion(versionRaw);
  let stats: ClamdStats | undefined;
  try { stats = parseClamdStats(await deps.command('STATS')); } catch { /* STATS may be disabled */ }
  const ageMs = version.signatureDate ? deps.now() - Date.parse(version.signatureDate) : NaN;
  return {
    ...base,
    online: true,
    latencyMs,
    version,
    ...(stats && Object.keys(stats).length > 0 ? { stats } : {}),
    ...(Number.isFinite(ageMs) ? { signatureAgeHours: Math.max(0, Math.round(ageMs / 3_600_000)) } : {}),
  };
}

/** What the inbound pipeline would do with the scanned test message. */
export type EicarOutcome = 'quarantine' | 'reject' | 'defer' | 'deliver-tagged' | 'deliver';

export interface EicarTestReport {
  /** true when clamd found the test signature (the scanner works). */
  detected: boolean;
  status: ClamavResult['status'];
  signature?: string;
  category?: SignatureCategory;
  countsAsVirus?: boolean;
  outcome: EicarOutcome;
  latencyMs: number;
  error?: string;
}

export async function eicarTest(
  config: PipelineConfig,
  scan: (raw: Buffer, opts?: { timeoutMs?: number }) => Promise<ClamavResult> = scanBuffer,
  now: () => number = () => Date.now(),
): Promise<EicarTestReport> {
  const t0 = now();
  const result = await scanWithPolicy(eicarTestMessage(), config, scan);
  const latencyMs = now() - t0;
  const { decision, note } = evaluateClamav(result, config);
  const outcome: EicarOutcome = decision
    ? (decision.action === 'accept' ? 'deliver' : decision.action)
    : note ? 'deliver-tagged' : 'deliver';
  return {
    detected: result.status === 'infected',
    status: result.status,
    ...(result.virusName ? {
      signature: result.virusName,
      category: classifySignature(result.virusName),
      countsAsVirus: clamavCountsAsVirus(result.virusName, config),
    } : {}),
    outcome,
    latencyMs,
    ...(result.error ? { error: result.error } : {}),
  };
}

export function registerClamavRoutes(app: Express, getConfig: () => PipelineConfig): void {
  app.get('/clamav/status', async (_req, res) => {
    res.json(await clamavStatus(getConfig()));
  });
  app.post('/clamav/eicar-test', async (_req, res) => {
    res.json(await eicarTest(getConfig()));
  });
}
