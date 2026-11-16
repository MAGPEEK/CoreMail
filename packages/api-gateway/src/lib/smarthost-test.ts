/**
 * BCP → SMTP → Outgoing → "Test connection" (pure transport options).
 *
 * The test must behave like the real delivery (smtp-server outbound/relay.ts
 * `smarthostTransportOptions`): whenever TLS is wanted or credentials are sent
 * the certificate is verified (SMARTHOST_TLS_INSECURE=true is the opt-out),
 * and STARTTLS is mandatory when credentials are sent. Before, the test used
 * `rejectUnauthorized: false` and passed for smarthosts the worker then
 * refused.
 *
 * An empty password field means "keep the stored password" (the GET masks it),
 * so the test falls back to the stored password when the user name is unchanged.
 */

export interface SmarthostTestInput {
  host: string;
  port: number;
  tls: boolean;
  implicitTls: boolean;
  username?: string | undefined;
  password?: string | undefined;
}

export interface StoredSmarthost {
  smarthostUsername?: string | null;
  smarthostPassword?: string | null;
}

export function smarthostTestOptions(
  input: SmarthostTestInput,
  stored: StoredSmarthost | null,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  const user = input.username?.trim() ?? '';
  const pass = input.password
    ? input.password
    : (user && stored?.smarthostPassword && (stored.smarthostUsername ?? '') === user ? stored.smarthostPassword : '');
  const auth = user ? { user, pass } : undefined;
  const tlsWanted = input.tls || input.implicitTls || !!auth;
  const insecure = env['SMARTHOST_TLS_INSECURE'] === 'true';
  const requireStartTls = (input.tls || !!auth) && !input.implicitTls;
  return {
    host: input.host,
    port: input.port,
    secure: input.implicitTls,
    requireTLS: requireStartTls,
    opportunisticTLS: !requireStartTls && !input.implicitTls,
    ...(auth ? { auth } : {}),
    tls: tlsWanted && !insecure
      ? { rejectUnauthorized: true, servername: input.host, minVersion: 'TLSv1.2' }
      : { rejectUnauthorized: false },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  };
}
