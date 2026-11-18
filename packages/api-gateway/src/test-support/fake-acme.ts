/**
 * Test-only fake certificate authority (ACME) + fake challenge serving.
 * The CA "validates" a domain by looking the token up in the served-token map
 * (like Let's Encrypt fetching http://<domain>/.well-known/acme-challenge/<token>),
 * unless an explicit outcome is configured per domain.
 */
import forge from 'node-forge';
import { generateKeyPairSync } from 'node:crypto';
import { randomCertSerialHex } from '@coremail/core/cert-serial';
import type {
  AcmeAuthzLike, AcmeChallengeLike, AcmeClientLike, AcmeOrderLike, ChallengeServing, HttpTextResult,
} from '../lib/acme-flow.js';

export type FakeOutcome = { status: 'valid' } | { status: 'invalid'; type: string; detail: string };

export interface FakeCaOptions {
  outcome?: (domain: string) => FakeOutcome;
  createOrderError?: string;
  /** createAccount fails this many times with acme-client's network TypeError first. */
  accountNetworkFailures?: number;
  /** createAccount refuses a contact address (invalidContact). */
  rejectContact?: boolean;
  /** completeChallenge never settles (CA unresponsive). */
  hangComplete?: boolean;
  served?: Map<string, string>;
}

const { privateKey: KEY_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/** Self-signed certificate for `domains`, valid 90 days (stands in for the issued chain). */
export function makeTestCertPem(domains: string[], days = 90): string {
  const key = forge.pki.privateKeyFromPem(KEY_PEM) as forge.pki.rsa.PrivateKey;
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  cert.serialNumber = randomCertSerialHex();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + days * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: domains[0]! }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'subjectAltName', altNames: domains.map(value => ({ type: 2, value })) }]);
  cert.sign(key, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

export function makeFakeCa(opts: FakeCaOptions = {}) {
  const calls: string[] = [];
  const authz = new Map<string, AcmeAuthzLike>();
  const served = opts.served ?? new Map<string, string>();
  let orderDomains: string[] = [];
  let netFailures = opts.accountNetworkFailures ?? 0;

  const findByChallenge = (ch: AcmeChallengeLike) =>
    [...authz.values()].find(a => a.challenges.some(c => c.url === ch.url));

  const client: AcmeClientLike = {
    async createAccount(data) {
      calls.push('createAccount');
      if (netFailures > 0) { netFailures--; throw new TypeError("Cannot read properties of undefined (reading 'config')"); }
      if (opts.rejectContact && data.contact) throw new Error('Error validating contact(s) :: contact email has forbidden domain "example.com"');
      return {};
    },
    async createOrder({ identifiers }) {
      calls.push('createOrder');
      if (opts.createOrderError) throw new Error(opts.createOrderError);
      orderDomains = identifiers.map(i => i.value);
      const urls: string[] = [];
      for (const d of orderDomains) {
        const url = `https://ca.test/authz/${d}`;
        const token = `tok_${d.replace(/[^a-z0-9]/gi, '')}`;
        authz.set(url, {
          url, status: 'pending', identifier: { type: 'dns', value: d },
          challenges: [
            { type: 'dns-01', url: `https://ca.test/chall/dns/${d}`, token: `${token}_dns`, status: 'pending' },
            { type: 'http-01', url: `https://ca.test/chall/http/${d}`, token, status: 'pending' },
          ],
        });
        urls.push(url);
      }
      return { url: 'https://ca.test/order/1', status: 'pending', authorizations: urls, finalize: 'https://ca.test/finalize/1' };
    },
    async getAuthorizations(order: AcmeOrderLike) {
      calls.push('getAuthorizations');
      return (order.authorizations ?? []).map(u => structuredClone(authz.get(u)!));
    },
    async getChallengeKeyAuthorization(ch) { return `${ch.token}.thumbprint`; },
    async completeChallenge(ch) {
      const a = findByChallenge(ch)!;
      const d = a.identifier.value;
      calls.push(`complete:${d}`);
      if (opts.hangComplete) return new Promise<never>(() => undefined);
      const result: FakeOutcome = opts.outcome
        ? opts.outcome(d)
        : served.get(ch.token ?? '') === `${ch.token}.thumbprint`
          ? { status: 'valid' }
          : { status: 'invalid', type: 'urn:ietf:params:acme:error:unauthorized', detail: `203.0.113.10: Invalid response from http://${d}/.well-known/acme-challenge/${ch.token}: 404` };
      const c = a.challenges.find(x => x.url === ch.url)!;
      if (result.status === 'valid') { a.status = 'valid'; c.status = 'valid'; }
      else { a.status = 'invalid'; c.status = 'invalid'; c.error = { type: result.type, detail: result.detail, status: 400 }; }
      return c;
    },
    async deactivateAuthorization(a) {
      calls.push(`deactivate:${a.identifier.value}`);
      const cur = authz.get(a.url ?? '');
      if (cur) cur.status = 'deactivated';
      return cur ?? a;
    },
    async finalizeOrder(order) { calls.push('finalize'); return { ...order, status: 'processing' }; },
    async getOrder(o) { calls.push('getOrder'); return { ...o, status: 'valid', certificate: 'https://ca.test/cert/1' }; },
    async getCertificate() { calls.push('getCertificate'); return makeTestCertPem(orderDomains); },
  };
  return { client, calls, authz, served };
}

export interface FakeServingOptions {
  /** Loopback answer: 'ok' (serves the token) or an HTTP status. */
  local?: 'ok' | number;
  /** Public-address fetch: 'ok', 'hang' (no hairpin NAT), 'refused' or an HTTP status. */
  public?: 'ok' | 'hang' | 'refused' | number;
  served?: Map<string, string>;
}

export function makeFakeServing(opts: FakeServingOptions = {}) {
  const served = opts.served ?? new Map<string, string>();
  const events: string[] = [];
  const answer = (mode: 'ok' | number, token: string): HttpTextResult =>
    mode === 'ok' ? { status: 200, body: served.get(token) ?? '' } : { status: mode, body: 'Not found' };
  const serving: ChallengeServing = {
    async store(token, keyAuth) { served.set(token, keyAuth); events.push(`store:${token}`); },
    async remove(token) { served.delete(token); events.push(`remove:${token}`); },
    async checkLocal(_d, token) { events.push(`local:${token}`); return answer(opts.local ?? 'ok', token); },
    checkPublic(_d, token) {
      events.push(`public:${token}`);
      const mode = opts.public ?? 'ok';
      if (mode === 'hang') return new Promise<HttpTextResult>(() => undefined);
      if (mode === 'refused') return Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      return Promise.resolve(answer(mode, token));
    },
  };
  return { serving, served, events };
}
