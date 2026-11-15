/**
 * Liveness (8.0.0): `/livez` answers 200 as long as the api-gateway process serves
 * HTTP — independent of the object-storage startup check. `/healthz` stays the
 * readiness signal (503 while the storage check blocks on purpose).
 *
 * Kubernetes liveness/startup probes use `/livez`: a slow or misconfigured store must
 * keep the pod "not ready" (wait and re-check), not restart it in a loop.
 */
import type { Request, Response } from 'express';

export function livenessHandler(_req: Request, res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, service: 'api-gateway' });
}
