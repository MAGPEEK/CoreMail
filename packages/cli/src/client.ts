/**
 * HTTP-Client für die CoreMail Admin-API (`/api/v1/admin/*`) inkl. Login,
 * MFA (TOTP/Backup-Code), Token-Refresh und Credential-Datei.
 *
 * Konfiguration (Priorität absteigend):
 *   --server / COREMAIL_API_URL          Basis-URL (Default http://localhost:3000)
 *   COREMAIL_TOKEN                        fertiges Admin-Access-Token (JWT)
 *   COREMAIL_ADMIN_EMAIL + _PASSWORD      automatischer Login ohne Prompt
 *   ~/.config/coremail/credentials.json   gespeicherte Sitzung (`coremail login`)
 */
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { prompt, promptHidden } from './output.js';

export interface Credentials {
  server: string;
  email?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body: unknown) {
    super(message);
  }
}

export function credentialsPath(): string {
  return process.env['COREMAIL_CLI_CREDENTIALS']
    ?? join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'coremail', 'credentials.json');
}

export function loadCredentials(): Credentials | null {
  const p = credentialsPath();
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as Credentials; } catch { return null; }
}

export function saveCredentials(c: Credentials): void {
  const p = credentialsPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(p, 0o600);
}

export function clearCredentials(): boolean {
  const p = credentialsPath();
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

export class CoreMailClient {
  private token: string | null = null;
  private creds: Credentials | null = null;

  constructor(public readonly server: string) {}

  static resolveServer(flag?: string): string {
    const raw = flag ?? process.env['COREMAIL_API_URL'] ?? loadCredentials()?.server ?? 'http://localhost:3000';
    return raw.replace(/\/+$/, '');
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  async ensureAuth(): Promise<void> {
    if (this.token) return;
    const envToken = process.env['COREMAIL_TOKEN'];
    if (envToken) { this.token = envToken; return; }

    const saved = loadCredentials();
    if (saved && saved.server === this.server) {
      if (saved.expiresAt > Date.now() + 10_000) { this.token = saved.accessToken; this.creds = saved; return; }
      if (saved.refreshToken) {
        try {
          const r = await this.rawJson<{ accessToken: string; refreshToken?: string; expiresIn?: number }>(
            'POST', '/auth/refresh', { refreshToken: saved.refreshToken }, false,
          );
          this.creds = {
            ...saved,
            accessToken: r.accessToken,
            refreshToken: r.refreshToken ?? saved.refreshToken,
            expiresAt: Date.now() + (r.expiresIn ?? 900) * 1000,
          };
          saveCredentials(this.creds);
          this.token = r.accessToken;
          return;
        } catch { /* Refresh fehlgeschlagen → neu anmelden */ }
      }
    }

    const email = process.env['COREMAIL_ADMIN_EMAIL'];
    const password = process.env['COREMAIL_ADMIN_PASSWORD'];
    if (email && password) { await this.login(email, password); return; }

    if (!process.stdin.isTTY) {
      throw new Error('Nicht angemeldet. `coremail login` ausführen oder COREMAIL_TOKEN bzw. COREMAIL_ADMIN_EMAIL/COREMAIL_ADMIN_PASSWORD setzen.');
    }
    process.stderr.write(`Anmeldung an ${this.server}\n`);
    await this.login(await prompt('Admin-E-Mail: '), await promptHidden('Passwort: '));
  }

  async login(email: string, password: string, totp?: string): Promise<Credentials> {
    const first = await this.rawJson<{ accessToken?: string; refreshToken?: string; expiresIn?: number; mfaRequired?: boolean; challengeToken?: string; method?: string }>(
      'POST', '/auth/login', { email, password }, false,
    );
    let tokens: { accessToken?: string; refreshToken?: string; expiresIn?: number } = first;
    if (first.mfaRequired) {
      if (first.method === 'webauthn') throw new Error('Dieses Konto nutzt WebAuthn — die CLI unterstützt nur TOTP/Backup-Codes. Alternativ COREMAIL_TOKEN setzen.');
      const code = totp ?? (process.env['COREMAIL_ADMIN_TOTP'] || (process.stdin.isTTY ? await prompt('MFA-Code (TOTP oder Backup-Code): ') : ''));
      if (!code) throw new Error('MFA erforderlich — Code über --totp oder COREMAIL_ADMIN_TOTP übergeben.');
      const body = /^\d{6}$/.test(code) ? { challengeToken: first.challengeToken, code } : { challengeToken: first.challengeToken, backupCode: code };
      tokens = await this.rawJson('POST', '/auth/mfa/verify', body, false);
    }
    if (!tokens.accessToken) throw new Error('Login fehlgeschlagen: kein Access-Token erhalten');
    this.creds = {
      server: this.server, email,
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      expiresAt: Date.now() + (tokens.expiresIn ?? 900) * 1000,
    };
    saveCredentials(this.creds);
    this.token = tokens.accessToken;
    return this.creds;
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private async rawJson<T>(method: string, path: string, body: unknown, auth: boolean): Promise<T> {
    if (auth) await this.ensureAuth();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.token) headers['Authorization'] = `Bearer ${this.token}`;
    let resp: Response;
    try {
      resp = await fetch(`${this.server}${path}`, {
        method, headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new Error(`Server ${this.server} nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await resp.text();
    let data: unknown = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    if (!resp.ok) {
      const obj = (data && typeof data === 'object' ? data : {}) as { error?: string; code?: string; details?: unknown };
      let msg = obj.error ?? (typeof data === 'string' && data ? data : `HTTP ${resp.status}`);
      if (resp.status === 401) msg = `${msg} — Anmeldung abgelaufen oder ungültig (\`coremail login\`)`;
      if (resp.status === 403 && obj.code === 'MFA_REQUIRED') msg = 'Admin-Zugriff erfordert MFA — im MWA aktivieren oder requireMfaForAdmins deaktivieren';
      if (obj.details) msg += `\n${JSON.stringify(obj.details, null, 2)}`;
      throw new ApiError(resp.status, msg, data);
    }
    return data as T;
  }

  get<T>(path: string): Promise<T> { return this.rawJson<T>('GET', path, undefined, true); }
  post<T>(path: string, body?: unknown): Promise<T> { return this.rawJson<T>('POST', path, body, true); }
  put<T>(path: string, body?: unknown): Promise<T> { return this.rawJson<T>('PUT', path, body, true); }
  patch<T>(path: string, body?: unknown): Promise<T> { return this.rawJson<T>('PATCH', path, body, true); }
  delete<T>(path: string): Promise<T> { return this.rawJson<T>('DELETE', path, undefined, true); }
}

// ── Gemeinsame Auflöser ──────────────────────────────────────────────────────

export interface UserRow {
  id: string; email: string; displayName: string; role: string; active: boolean;
  quotaBytes: string | number; usedBytes: string | number; domainId: string; createdAt: string;
}

export async function listUsers(api: CoreMailClient): Promise<UserRow[]> {
  return api.get<UserRow[]>('/api/v1/admin/mailboxes');
}

export async function resolveUser(api: CoreMailClient, ref: string): Promise<UserRow> {
  const users = await listUsers(api);
  const needle = ref.toLowerCase();
  const u = users.find((x) => x.id === ref || x.email.toLowerCase() === needle);
  if (!u) throw new Error(`Benutzer nicht gefunden: ${ref}`);
  return u;
}

export interface DomainRow { id: string; name: string; active: boolean; primary: boolean }

export async function listDomains(api: CoreMailClient): Promise<DomainRow[]> {
  const r = await api.get<{ domains: DomainRow[] }>('/api/v1/admin/domains?limit=200');
  return r.domains;
}

export async function resolveDomain(api: CoreMailClient, ref: string): Promise<DomainRow> {
  const domains = await listDomains(api);
  const d = domains.find((x) => x.id === ref || x.name.toLowerCase() === ref.toLowerCase());
  if (!d) throw new Error(`Domain nicht gefunden: ${ref} (vorhanden: ${domains.map((x) => x.name).join(', ') || 'keine'})`);
  return d;
}

export interface SharedRow {
  id: string; email: string; displayName: string; domainId: string; active: boolean;
  quotaBytes: string | number; usedBytes: string | number; createdAt: string;
  permissions?: Array<{ userId: string; permission: string; user?: { email: string; displayName: string } }>;
}

export async function listShared(api: CoreMailClient): Promise<SharedRow[]> {
  const r = await api.get<{ items: SharedRow[] }>('/api/v1/admin/shared-mailboxes?limit=500');
  return r.items;
}

export async function resolveShared(api: CoreMailClient, ref: string): Promise<SharedRow> {
  const list = await listShared(api);
  const s = list.find((x) => x.id === ref || x.email.toLowerCase() === ref.toLowerCase());
  if (!s) throw new Error(`Shared Mailbox nicht gefunden: ${ref}`);
  return s;
}
