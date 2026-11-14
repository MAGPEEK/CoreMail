/**
 * Test-only fake OpenID Provider on loopback (node:http, no dependencies):
 * discovery, JWKS with a generated RSA key, PKCE-checking token endpoint and
 * RS256-signed ID tokens. `authorize()` stands in for the user's browser at the
 * IdP and returns the callback query (code + state).
 */
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export interface FakeIdpLogin {
  sub: string;
  claims?: Record<string, unknown>;
  /** Overrides applied to the ID token payload (e.g. { aud: 'x' }, { exp: 1 }, { nonce: 'n' }). */
  tokenOverride?: Record<string, unknown>;
  /** Sign with a key that is not in the JWKS. */
  badSignature?: boolean;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  nonce: string;
  challenge: string;
  login: FakeIdpLogin;
  used: boolean;
}

export class FakeIdp {
  readonly kid = 'test-key-1';
  private readonly key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly otherKey: KeyObject = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  private readonly codes = new Map<string, PendingCode>();
  private server: Server | null = null;
  issuer = '';
  tokenRequests = 0;

  constructor(readonly clientId: string, readonly clientSecret: string) {}

  get discoveryUrl(): string { return `${this.issuer}/.well-known/openid-configuration`; }

  async start(): Promise<void> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /** The user logs in at the IdP: returns the redirect target query (code, state). */
  authorize(authorizationUrl: string, login: FakeIdpLogin): { code: string; state: string; redirectUri: string } {
    const u = new URL(authorizationUrl);
    const q = u.searchParams;
    if (`${u.origin}${u.pathname}` !== `${this.issuer}/authorize`) throw new Error('wrong authorization endpoint');
    if (q.get('client_id') !== this.clientId) throw new Error('unknown client');
    if (q.get('response_type') !== 'code') throw new Error('response_type');
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) throw new Error('PKCE S256 required');
    const code = b64u(randomBytes(24));
    this.codes.set(code, {
      clientId: this.clientId, redirectUri: q.get('redirect_uri') ?? '', nonce: q.get('nonce') ?? '',
      challenge: q.get('code_challenge') ?? '', login, used: false,
    });
    return { code, state: q.get('state') ?? '', redirectUri: q.get('redirect_uri') ?? '' };
  }

  signIdToken(payload: Record<string, unknown>, bad = false): string {
    const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: this.kid }));
    const body = b64u(JSON.stringify(payload));
    const sig = createSign('RSA-SHA256').update(`${header}.${body}`).sign(bad ? this.otherKey : this.key.privateKey);
    return `${header}.${body}.${b64u(sig)}`;
  }

  private json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/.well-known/openid-configuration') {
      return this.json(res, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'email', 'profile'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
    }
    if (req.method === 'GET' && path === '/jwks') {
      const jwk = this.key.publicKey.export({ format: 'jwk' });
      return this.json(res, 200, { keys: [{ ...jwk, kid: this.kid, alg: 'RS256', use: 'sig' }] });
    }
    if (req.method === 'POST' && path === '/token') {
      this.tokenRequests++;
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const form = new URLSearchParams(raw);
      let id = form.get('client_id') ?? '';
      let secret = form.get('client_secret') ?? '';
      const auth = req.headers.authorization;
      if (auth?.startsWith('Basic ')) {
        const [u, p] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
        id = decodeURIComponent(u ?? ''); secret = decodeURIComponent(p ?? '');
      }
      if (id !== this.clientId || secret !== this.clientSecret) return this.json(res, 401, { error: 'invalid_client' });
      const pending = this.codes.get(form.get('code') ?? '');
      if (form.get('grant_type') !== 'authorization_code' || !pending || pending.used) return this.json(res, 400, { error: 'invalid_grant' });
      pending.used = true;
      if (form.get('redirect_uri') !== pending.redirectUri) return this.json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri' });
      const verifier = form.get('code_verifier') ?? '';
      if (createHash('sha256').update(verifier).digest('base64url') !== pending.challenge) {
        return this.json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        iss: this.issuer, aud: this.clientId, sub: pending.login.sub, iat: now, exp: now + 300, nonce: pending.nonce,
        ...pending.login.claims, ...pending.login.tokenOverride,
      };
      return this.json(res, 200, {
        access_token: b64u(randomBytes(16)), token_type: 'Bearer', expires_in: 300,
        id_token: this.signIdToken(payload, pending.login.badSignature),
      });
    }
    this.json(res, 404, { error: 'not_found' });
  }
}
