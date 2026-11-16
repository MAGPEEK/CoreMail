/**
 * Listener binding for the TCP mail protocols (SMTP, IMAP, POP3).
 *
 * `ServiceListener.address` comes from the database (BCP). It used to be free
 * text the servers ignored (they always bound 0.0.0.0), so existing rows may
 * hold a host name or an IP the container does not have. A bad bind address
 * must never take the process down (EADDRNOTAVAIL without an 'error' listener
 * → uncaught exception → supervisord crash loop):
 *
 *  - resolveBindAddress(): only IPv4/IPv6 literals are used, anything else is
 *    logged and replaced by the default 0.0.0.0;
 *  - listenWithRecovery(): every bind error is caught. A configured address
 *    that cannot be bound falls back to 0.0.0.0; EADDRINUSE (e.g. the
 *    close-and-relisten path while the old socket is still being released) is
 *    retried with backoff, then the port is given up with an error log.
 */
import net from 'node:net';

/** Default bind address (all IPv4 interfaces) — what the servers always used. */
export const DEFAULT_BIND_ADDRESS = '0.0.0.0';

export interface ListenLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * The address to bind: an IPv4/IPv6 literal (`[::1]` brackets are accepted),
 * otherwise DEFAULT_BIND_ADDRESS. `onInvalid` is called for a non-empty value
 * that is not an IP literal (e.g. a host name).
 */
export function resolveBindAddress(
  address: string | null | undefined,
  onInvalid?: (address: string) => void,
): string {
  let v = (address ?? '').trim();
  if (!v) return DEFAULT_BIND_ADDRESS;
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  if (net.isIP(v) !== 0) return v;
  onInvalid?.(address!.trim());
  return DEFAULT_BIND_ADDRESS;
}

export interface ListenWithRecoveryOptions {
  port: number;
  /** Configured address (raw DB value) — validated through resolveBindAddress(). */
  address: string | null | undefined;
  /** Log context, e.g. 'SMTP'. */
  label: string;
  log: ListenLogger;
  /** Called once the server listens (on whichever address finally worked). */
  onListening?: (boundAddress: string) => void;
  /** Called when the port could not be bound at all (after the retries). */
  onGiveUp?: (err: NodeJS.ErrnoException) => void;
  /** Returns false once the listener was replaced/removed — stops pending retries. */
  isCurrent?: () => boolean;
  /** EADDRINUSE retries (default 5). */
  retries?: number;
  /** First retry delay in ms, doubled per attempt (default 500). */
  retryDelayMs?: number;
  /** Address used when the configured one cannot be used (default 0.0.0.0; tests use loopback). */
  fallbackAddress?: string;
}

/**
 * server.listen() with an 'error' listener: a bind failure is logged and
 * recovered (fallback address / retry) instead of crashing the process.
 * Errors after the server listens are logged only.
 */
export function listenWithRecovery(server: net.Server, opts: ListenWithRecoveryOptions): void {
  const { port, label, log } = opts;
  const fallback = opts.fallbackAddress ?? DEFAULT_BIND_ADDRESS;
  const maxRetries = opts.retries ?? 5;
  const baseDelay = opts.retryDelayMs ?? 500;
  let address = resolveBindAddress(opts.address, (raw) =>
    log.warn({ port, address: raw, using: fallback },
      `${label}: listener address is not an IP address — binding ${fallback} instead`));
  if (address === DEFAULT_BIND_ADDRESS) address = fallback;
  let attempt = 0;
  let listening = false;
  let gaveUp = false;

  const giveUp = (err: NodeJS.ErrnoException): void => {
    gaveUp = true;
    log.error({ err, port, address, code: err.code },
      `${label} listener could not be started — port stays closed until the next listener reload`);
    opts.onGiveUp?.(err);
  };

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (listening || gaveUp) {
      log.error({ err, port }, `${label} listener error`);
      return;
    }
    if (opts.isCurrent && !opts.isCurrent()) return;
    if (err.code === 'EADDRINUSE' && attempt < maxRetries) {
      const delay = baseDelay * 2 ** attempt;
      attempt++;
      log.warn({ port, address, attempt, delayMs: delay },
        `${label}: port in use — retrying the bind`);
      setTimeout(() => {
        if (opts.isCurrent && !opts.isCurrent()) return;
        server.listen(port, address);
      }, delay).unref?.();
      return;
    }
    if (err.code !== 'EADDRINUSE' && address !== fallback) {
      // EADDRNOTAVAIL / EINVAL / EAFNOSUPPORT …: the configured address does not
      // exist in this container — serve on the fallback instead of not at all.
      log.error({ err, port, address, code: err.code, using: fallback },
        `${label}: cannot bind the configured listener address — falling back to ${fallback}`);
      address = fallback;
      attempt = 0;
      server.listen(port, address);
      return;
    }
    giveUp(err);
  });

  server.on('listening', () => {
    listening = true;
    opts.onListening?.(address);
  });

  server.listen(port, address);
}
