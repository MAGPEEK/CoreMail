/**
 * Process-level guards (v6 hardening).
 *
 *  unhandledRejection → logged, process keeps running (a stray rejected
 *                       promise must not take the whole service down)
 *  uncaughtException  → logged as fatal, then exit(1) — the process state is
 *                       undefined after a synchronous throw escaped the stack;
 *                       supervisord / Kubernetes restarts the service.
 */

export interface GuardLogger {
  error(obj: object, msg?: string): void;
  fatal?(obj: object, msg?: string): void;
}

export interface ProcessGuardOptions {
  /** Exit hook (tests). Default: process.exit. */
  exit?: (code: number) => void;
}

const INSTALLED = Symbol.for('coremail.processGuardsInstalled');

export function installProcessGuards(log: GuardLogger, opts: ProcessGuardOptions = {}): void {
  const g = globalThis as Record<symbol, unknown>;
  if (g[INSTALLED]) return;
  g[INSTALLED] = true;
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'Unhandled promise rejection (service keeps running)');
  });

  process.on('uncaughtException', (err, origin) => {
    const fatal = log.fatal ?? log.error;
    try { fatal.call(log, { err, origin }, 'Uncaught exception — exiting for supervisor restart'); } catch { /* ignore */ }
    exit(1);
  });
}
