// 10.6: software WebAuthn authenticator for the e2e `passkeys` step (API level).
// node:crypto keys (ES256 / Ed25519 / RS256) + a minimal CBOR encoder; every
// authData flag (UP, UV, BE, BS), the counter, origin and RP ID hash are under
// the test's control. Dependency-free copy of
// packages/storage/src/auth/webauthn/soft-authenticator.ts.
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';

function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}

export function cborEncode(v) {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'boolean') return Buffer.from([v ? 0xf5 : 0xf4]);
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cborEncode)]);
  const parts = [head(5, v.size)];
  for (const [k, val] of v) parts.push(cborEncode(k), cborEncode(val));
  return Buffer.concat(parts);
}

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => createHash('sha256').update(b).digest();

export class SoftAuthenticator {
  /** opts: { rpId, origin, alg = -7, backupEligible, backupState, counterStep = 1 } */
  constructor(opts) {
    this.opts = opts;
    this.alg = opts.alg ?? -7;
    const pair = this.alg === -7 ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : this.alg === -8 ? generateKeyPairSync('ed25519') : generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    this.credentialId = b64u(randomBytes(32));
    this.userHandle = null;
    this.counter = 0;
  }

  coseKey() {
    const jwk = this.publicKey.export({ format: 'jwk' });
    const m = new Map();
    if (this.alg === -7) { m.set(1, 2); m.set(3, -7); m.set(-1, 1); m.set(-2, Buffer.from(jwk.x, 'base64url')); m.set(-3, Buffer.from(jwk.y, 'base64url')); }
    else if (this.alg === -8) { m.set(1, 1); m.set(3, -8); m.set(-1, 6); m.set(-2, Buffer.from(jwk.x, 'base64url')); }
    else { m.set(1, 3); m.set(3, -257); m.set(-1, Buffer.from(jwk.n, 'base64url')); m.set(-2, Buffer.from(jwk.e, 'base64url')); }
    return cborEncode(m);
  }

  sign(data) { return this.alg === -8 ? cryptoSign(null, data, this.privateKey) : cryptoSign('sha256', data, this.privateKey); }

  flags(o, attested) {
    let f = 0;
    if (o.up ?? true) f |= 0x01;
    if (o.uv ?? true) f |= 0x04;
    if (o.be ?? this.opts.backupEligible ?? false) f |= 0x08;
    if (o.bs ?? this.opts.backupState ?? false) f |= 0x10;
    if (attested) f |= 0x40;
    return f;
  }

  clientData(type, challenge, o) {
    const cd = { type, challenge, origin: o.origin ?? this.opts.origin };
    if (o.crossOrigin !== undefined) cd.crossOrigin = o.crossOrigin;
    return Buffer.from(JSON.stringify(cd), 'utf8');
  }

  /** navigator.credentials.create() for the server's options JSON. */
  register(options, o = {}) {
    this.userHandle = options.user?.id ?? null;
    const rpId = o.rpId ?? options.rp?.id ?? this.opts.rpId;
    const credId = Buffer.from(this.credentialId, 'base64url');
    const counter = Buffer.alloc(4); counter.writeUInt32BE(this.counter);
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credId.length);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([this.flags(o, true)]), counter, Buffer.alloc(16), idLen, credId, this.coseKey()]);
    const clientDataJSON = this.clientData('webauthn.create', options.challenge, o);
    const att = new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]);
    return {
      id: this.credentialId, rawId: this.credentialId, type: 'public-key',
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(cborEncode(att)), transports: ['internal', 'hybrid'] },
      clientExtensionResults: { credProps: { rk: true } },
      authenticatorAttachment: 'platform',
    };
  }

  /** navigator.credentials.get() for the server's options JSON. */
  assert(options, o = {}) {
    const rpId = o.rpId ?? options.rpId ?? this.opts.rpId;
    this.counter = o.counter ?? this.counter + (this.opts.counterStep ?? 1);
    const counter = Buffer.alloc(4); counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([this.flags(o, false)]), counter]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, o);
    const sig = this.sign(Buffer.concat([authData, sha256(clientDataJSON)]));
    const handle = o.userHandle === undefined ? this.userHandle : o.userHandle;
    return {
      id: this.credentialId, rawId: this.credentialId, type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(sig),
        ...(handle ? { userHandle: handle } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** The pre-10.6 UserMfa.webAuthnCredentials entry of this key (legacy migration). */
  legacyJson(name = 'Old key') {
    return { id: this.credentialId, publicKey: this.coseKey().toString('base64'), counter: this.counter, name, createdAt: new Date().toISOString() };
  }
}
