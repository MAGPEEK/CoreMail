/**
 * Hot certificate rotation for running TLS listeners (SMTP/IMAP/POP3).
 *
 * Implicit-TLS listeners (465/993/995) are node:tls servers; a renewed or
 * newly activated certificate is swapped in with `server.setSecureContext()`
 * — existing connections keep their session, new handshakes use the new cert,
 * no port is closed. A listener that was started with `ssl: true` but without
 * any TLS material (plain net.Server fallback) cannot be upgraded in place and
 * is reported for a restart.
 */

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
}

/** Anything with an optional setSecureContext — tls.Server or a test fake. */
export interface TlsCapableServer {
  setSecureContext?: (options: { cert: Buffer; key: Buffer; minVersion?: 'TLSv1.2' | 'TLSv1.3' }) => void;
}

export interface TlsListenerEntry {
  port: number;
  /** Listener configured for implicit TLS. */
  ssl: boolean;
  server: TlsCapableServer | object;
}

export interface TlsApplyResult {
  /** Ports whose TLS server received the new secure context. */
  updated: number[];
  /** ssl listeners running without TLS — must be closed and recreated. */
  restart: number[];
  /** Ports where setSecureContext threw (e.g. key does not match cert). */
  failed: Array<{ port: number; error: unknown }>;
}

export function tlsMaterialEquals(a: TlsMaterial | null | undefined, b: TlsMaterial | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.cert.equals(b.cert) && a.key.equals(b.key);
}

/**
 * Applies `material` to every implicit-TLS listener in `entries`.
 * Plain (non-ssl) listeners are left alone — their STARTTLS path reads the
 * current material per session.
 */
export function applyTlsToListeners(
  entries: Iterable<TlsListenerEntry>,
  material: TlsMaterial,
  minVersion: 'TLSv1.2' | 'TLSv1.3' = 'TLSv1.2',
): TlsApplyResult {
  const result: TlsApplyResult = { updated: [], restart: [], failed: [] };
  for (const e of entries) {
    if (!e.ssl) continue;
    const srv = e.server as TlsCapableServer;
    if (typeof srv.setSecureContext !== 'function') {
      result.restart.push(e.port);
      continue;
    }
    try {
      srv.setSecureContext({ cert: material.cert, key: material.key, minVersion });
      result.updated.push(e.port);
    } catch (error) {
      result.failed.push({ port: e.port, error });
    }
  }
  return result;
}
