/**
 * 10.6: a software WebAuthn authenticator for tests (@coremail/storage/auth/webauthn/testing).
 * node:crypto keys (ES256, EdDSA/Ed25519, RS256) and a small CBOR encoder, so
 * tests control every byte: authData flags (UP, UV, BE, BS), the signature
 * counter, rpIdHash, clientDataJSON (origin, type, challenge, crossOrigin,
 * topOrigin), the user handle and the attestation format (none / packed self
 * attestation). Never used outside tests. scripts/e2e/soft-authenticator.mjs is
 * the dependency-free copy of the e2e harness.
 */
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto';

// ── CBOR (RFC 8949) — the subset WebAuthn needs ──────────────────────────────

export type CborValue = number | string | boolean | Uint8Array | CborValue[] | Map<number | string, CborValue>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}

export function cborEncode(v: CborValue): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'boolean') return Buffer.from([v ? 0xf5 : 0xf4]);
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cborEncode)]);
  const parts: Buffer[] = [head(5, v.size)];
  for (const [k, val] of v) parts.push(cborEncode(k), cborEncode(val));
  return Buffer.concat(parts);
}

const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string): Buffer => createHash('sha256').update(b).digest();

export type SoftAlg = -7 | -8 | -257;

export interface SoftAuthenticatorOptions {
  alg?: SoftAlg;
  rpId: string;
  origin: string;
  aaguid?: string;
  /** BE / BS flags of every response (override per call). */
  backupEligible?: boolean;
  backupState?: boolean;
  /** Length of the generated credential id (default 32). */
  credentialIdBytes?: number;
  fmt?: 'none' | 'packed';
  /** Counter increment per assertion (0 = synced passkey behaviour). */
  counterStep?: number;
}

export interface CallOverrides {
  up?: boolean;
  uv?: boolean;
  be?: boolean;
  bs?: boolean;
  counter?: number;
  origin?: string;
  rpId?: string;
  type?: string;
  challenge?: string;
  crossOrigin?: boolean;
  topOrigin?: string;
  userHandle?: string | null;
  credentialId?: string;
  /** Break the signature. */
  badSignature?: boolean;
  /** credProps.rk in the registration result (default true). */
  rk?: boolean;
}

interface Json { [k: string]: unknown }

export class SoftAuthenticator {
  readonly alg: SoftAlg;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  credentialId: string;
  userHandle: string | null = null;
  counter = 0;
  constructor(readonly opts: SoftAuthenticatorOptions) {
    this.alg = opts.alg ?? -7;
    const pair = this.alg === -7 ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : this.alg === -8 ? generateKeyPairSync('ed25519')
        : generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    this.credentialId = b64u(randomBytes(opts.credentialIdBytes ?? 32));
  }

  /** The COSE_Key of the credential public key. */
  coseKey(): Buffer {
    const jwk = this.publicKey.export({ format: 'jwk' }) as Record<string, string>;
    const m = new Map<number, CborValue>();
    if (this.alg === -7) {
      m.set(1, 2); m.set(3, -7); m.set(-1, 1);
      m.set(-2, Buffer.from(jwk['x']!, 'base64url')); m.set(-3, Buffer.from(jwk['y']!, 'base64url'));
    } else if (this.alg === -8) {
      m.set(1, 1); m.set(3, -8); m.set(-1, 6); m.set(-2, Buffer.from(jwk['x']!, 'base64url'));
    } else {
      m.set(1, 3); m.set(3, -257); m.set(-1, Buffer.from(jwk['n']!, 'base64url')); m.set(-2, Buffer.from(jwk['e']!, 'base64url'));
    }
    return cborEncode(m);
  }

  private signData(data: Buffer): Buffer {
    if (this.alg === -8) return cryptoSign(null, data, this.privateKey);
    return cryptoSign('sha256', data, this.privateKey); // ES256: DER signature, RS256: PKCS#1 v1.5
  }

  private flags(o: CallOverrides, attested: boolean): number {
    let f = 0;
    if (o.up ?? true) f |= 0x01;
    if (o.uv ?? true) f |= 0x04;
    if (o.be ?? this.opts.backupEligible ?? false) f |= 0x08;
    if (o.bs ?? this.opts.backupState ?? false) f |= 0x10;
    if (attested) f |= 0x40;
    return f;
  }

  private clientData(type: string, challenge: string, o: CallOverrides): Buffer {
    const cd: Json = { type: o.type ?? type, challenge: o.challenge ?? challenge, origin: o.origin ?? this.opts.origin };
    if (o.crossOrigin !== undefined) cd['crossOrigin'] = o.crossOrigin;
    if (o.topOrigin !== undefined) cd['topOrigin'] = o.topOrigin;
    return Buffer.from(JSON.stringify(cd), 'utf8');
  }

  private aaguidBytes(): Buffer {
    const hex = (this.opts.aaguid ?? '00000000-0000-0000-0000-000000000000').replace(/-/g, '');
    return Buffer.from(hex, 'hex');
  }

  /** navigator.credentials.create() for the options JSON of the server. */
  register(options: Json, o: CallOverrides = {}): Json {
    const user = options['user'] as { id: string } | undefined;
    this.userHandle = user?.id ?? null;
    const rpId = o.rpId ?? ((options['rp'] as { id?: string } | undefined)?.id ?? this.opts.rpId);
    const credId = Buffer.from(o.credentialId ?? this.credentialId, 'base64url');
    const counter = Buffer.alloc(4); counter.writeUInt32BE(o.counter ?? this.counter);
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credId.length);
    const authData = Buffer.concat([
      sha256(rpId), Buffer.from([this.flags(o, true)]), counter, this.aaguidBytes(), idLen, credId, this.coseKey(),
    ]);
    const clientDataJSON = this.clientData('webauthn.create', String(options['challenge']), o);
    const attStmt = new Map<string, CborValue>();
    if (this.opts.fmt === 'packed') {
      let sig = this.signData(Buffer.concat([authData, sha256(clientDataJSON)]));
      if (o.badSignature) sig = Buffer.from(sig.map((x) => x ^ 0xff));
      attStmt.set('alg', this.alg);
      attStmt.set('sig', sig);
    }
    const att = new Map<string, CborValue>([['fmt', this.opts.fmt ?? 'none'], ['attStmt', attStmt], ['authData', authData]]);
    const id = b64u(credId);
    return {
      id, rawId: id, type: 'public-key',
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(cborEncode(att)), transports: ['internal', 'hybrid'] },
      clientExtensionResults: { credProps: { rk: o.rk ?? true } },
      authenticatorAttachment: 'platform',
    };
  }

  /** navigator.credentials.get() for the options JSON of the server. */
  assert(options: Json, o: CallOverrides = {}): Json {
    const rpId = o.rpId ?? (typeof options['rpId'] === 'string' ? options['rpId'] : this.opts.rpId);
    if (o.counter !== undefined) this.counter = o.counter;
    else this.counter += this.opts.counterStep ?? 1;
    const counter = Buffer.alloc(4); counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([this.flags(o, false)]), counter]);
    const clientDataJSON = this.clientData('webauthn.get', String(options['challenge']), o);
    let sig = this.signData(Buffer.concat([authData, sha256(clientDataJSON)]));
    if (o.badSignature) sig = Buffer.from(sig.map((x) => x ^ 0xff));
    const id = o.credentialId ?? this.credentialId;
    const handle = o.userHandle === undefined ? this.userHandle : o.userHandle;
    return {
      id, rawId: id, type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(sig),
        ...(handle ? { userHandle: handle } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** The pre-10.6 JSON entry of UserMfa.webAuthnCredentials for this key (migration tests). */
  legacyJson(name = 'Old key'): Json {
    return { id: this.credentialId, publicKey: this.coseKey().toString('base64'), counter: this.counter, name, createdAt: new Date().toISOString() };
  }
}
