/**
 * CMS SignedData verification (RFC 5652) with Node's `crypto` only.
 *
 * Why not node-forge: `forge.pkcs7` has no `verify()` implementation (every
 * signed mail was stored as valid:false) and cannot parse EC certificates.
 * pkijs would work but adds a dependency tree; the subset needed here — parse
 * SignedData, check the messageDigest attribute, verify the signature over the
 * DER of the signed attributes, build a chain — is small enough to implement
 * on a minimal BER/DER reader that keeps exact byte offsets (signatures are
 * computed over the original encoding, re-encoding would break them).
 *
 * Supported: RSA PKCS#1 v1.5, RSASSA-PSS, ECDSA; SHA-1/224/256/384/512;
 * issuerAndSerialNumber and subjectKeyIdentifier signer ids; definite and
 * indefinite (BER) lengths; constructed OCTET STRING eContent.
 * Trust: chain built from the certificates in the message up to a root in
 * Node's bundled Mozilla CA store (tls.rootCertificates) — S/MIME CAs are
 * not all in that store, so "untrusted" means "not verifiable here", not
 * "forged".
 */
import { createHash, createPublicKey, verify as cryptoVerify, X509Certificate, constants } from 'node:crypto';
import { rootCertificates } from 'node:tls';

// ── minimal BER/DER reader ───────────────────────────────────────────────────

export interface Tlv {
  tag: number;          // first identifier octet (class+constructed+number, low-tag form)
  start: number;        // offset of the identifier octet
  contentStart: number;
  contentEnd: number;   // exclusive (for indefinite length: before the EOC)
  end: number;          // exclusive, incl. EOC
  children?: Tlv[];
}

const MAX_DEPTH = 40;

export function readTlv(buf: Buffer, pos: number, depth = 0): Tlv {
  if (depth > MAX_DEPTH) throw new Error('ASN.1 nesting too deep');
  if (pos + 2 > buf.length) throw new Error('ASN.1 truncated');
  const tag = buf[pos]!;
  if ((tag & 0x1f) === 0x1f) throw new Error('high-tag-number form not supported');
  let p = pos + 1;
  const first = buf[p++]!;
  const constructed = (tag & 0x20) !== 0;
  if (first === 0x80) {
    if (!constructed) throw new Error('indefinite length on primitive');
    const children: Tlv[] = [];
    while (true) {
      if (p + 2 > buf.length) throw new Error('ASN.1 truncated (EOC)');
      if (buf[p] === 0 && buf[p + 1] === 0) {
        return { tag, start: pos, contentStart: pos + 2, contentEnd: p, end: p + 2, children };
      }
      const c = readTlv(buf, p, depth + 1);
      children.push(c);
      p = c.end;
    }
  }
  let len = first;
  if (first & 0x80) {
    const n = first & 0x7f;
    if (n > 4) throw new Error('ASN.1 length too large');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++]!;
  }
  const contentStart = p;
  const contentEnd = p + len;
  if (contentEnd > buf.length) throw new Error('ASN.1 truncated');
  const node: Tlv = { tag, start: pos, contentStart, contentEnd, end: contentEnd };
  if (constructed) {
    const children: Tlv[] = [];
    let q = contentStart;
    while (q < contentEnd) { const c = readTlv(buf, q, depth + 1); children.push(c); q = c.end; }
    node.children = children;
  }
  return node;
}

const raw = (buf: Buffer, t: Tlv) => buf.subarray(t.start, t.end);
const content = (buf: Buffer, t: Tlv) => buf.subarray(t.contentStart, t.contentEnd);
const kids = (t: Tlv): Tlv[] => t.children ?? [];

export function decodeOid(bytes: Buffer): string {
  const out: number[] = [];
  let v = 0;
  for (let i = 0; i < bytes.length; i++) {
    v = v * 128 + (bytes[i]! & 0x7f);
    if (!(bytes[i]! & 0x80)) {
      if (out.length === 0) { const a = v < 80 ? Math.floor(v / 40) : 2; out.push(a, v - a * 40); } else out.push(v);
      v = 0;
    }
  }
  return out.join('.');
}

/** OCTET STRING value, also for constructed (BER) octet strings. */
function octets(buf: Buffer, t: Tlv): Buffer {
  if ((t.tag & 0x20) === 0) return content(buf, t);
  return Buffer.concat(kids(t).map((c) => octets(buf, c)));
}

// ── OIDs ─────────────────────────────────────────────────────────────────────

const OID = {
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  rsaEncryption: '1.2.840.113549.1.1.1',
  rsaPss: '1.2.840.113549.1.1.10',
  subjectKeyIdentifier: '2.5.29.14',
  emailProtection: '1.3.6.1.5.5.7.3.4',
  anyEku: '2.5.29.37.0',
};

const DIGESTS: Record<string, string> = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.4': 'sha224',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};
/** signature algorithms that imply a digest (RSA-with-SHA*, ECDSA-with-SHA*) */
const SIG_DIGEST: Record<string, string> = {
  '1.2.840.113549.1.1.5': 'sha1', '1.2.840.113549.1.1.14': 'sha224', '1.2.840.113549.1.1.11': 'sha256',
  '1.2.840.113549.1.1.12': 'sha384', '1.2.840.113549.1.1.13': 'sha512',
  '1.2.840.10045.4.1': 'sha1', '1.2.840.10045.4.3.1': 'sha224', '1.2.840.10045.4.3.2': 'sha256',
  '1.2.840.10045.4.3.3': 'sha384', '1.2.840.10045.4.3.4': 'sha512',
};

// ── certificates ─────────────────────────────────────────────────────────────

interface CertInfo {
  der: Buffer;
  x509: X509Certificate;
  issuerDer: Buffer;
  serialHex: string;   // canonical: lower-case, no leading zeros
  ski: Buffer | null;
}

function canonSerial(bytes: Buffer): string {
  return bytes.toString('hex').replace(/^(00)+(?=.)/, '').toLowerCase();
}

function parseCert(der: Buffer): CertInfo | null {
  try {
    const cert = readTlv(der, 0);
    const tbs = kids(cert)[0]!;
    const f = kids(tbs);
    const off = f[0] && f[0].tag === 0xa0 ? 1 : 0; // [0] version
    const serial = f[off]!;
    const issuer = f[off + 2]!;
    let ski: Buffer | null = null;
    const extWrap = f.find((x) => x.tag === 0xa3);
    const extSeq = extWrap ? kids(extWrap)[0] : undefined;
    for (const ext of extSeq ? kids(extSeq) : []) {
      const e = kids(ext);
      if (e[0] && decodeOid(content(der, e[0])) === OID.subjectKeyIdentifier) {
        const val = e[e.length - 1]!;
        const inner = readTlv(content(der, val), 0);
        ski = Buffer.from(content(content(der, val), inner));
      }
    }
    return { der, x509: new X509Certificate(der), issuerDer: Buffer.from(raw(der, issuer)), serialHex: canonSerial(content(der, serial)), ski };
  } catch {
    return null;
  }
}

function certEmail(x: X509Certificate): string | undefined {
  const san = x.subjectAltName ?? '';
  const m = /email:([^,\s]+)/i.exec(san);
  if (m) return m[1]!.toLowerCase();
  const s = /emailAddress=([^\n,]+)/i.exec(x.subject) ?? /E=([^\n,]+)/.exec(x.subject);
  return s ? s[1]!.trim().toLowerCase() : undefined;
}

function certCn(x: X509Certificate): string | undefined {
  return /(?:^|\n)CN=([^\n]+)/.exec(x.subject)?.[1]?.trim();
}

let _roots: X509Certificate[] | null = null;
function trustRoots(): X509Certificate[] {
  if (!_roots) {
    _roots = [];
    for (const pem of rootCertificates) { try { _roots.push(new X509Certificate(pem)); } catch { /* skip */ } }
  }
  return _roots;
}

export type TrustState = 'trusted' | 'untrusted';

/** Build a chain from `leaf` via the message certificates to a trust anchor. */
export function evaluateTrust(leaf: X509Certificate, pool: X509Certificate[], at: Date, roots: X509Certificate[] = trustRoots()): { trust: TrustState; reason: string } {
  let cur = leaf;
  const seen = new Set<string>();
  for (let depth = 0; depth < 10; depth++) {
    const root = roots.find((r) => cur.checkIssued(r) && cur.verify(r.publicKey));
    if (root) {
      return inValidity(root, at) ? { trust: 'trusted', reason: `chains to ${certCn(root) ?? root.subject}` } : { trust: 'untrusted', reason: 'root certificate expired' };
    }
    if (roots.some((r) => r.fingerprint256 === cur.fingerprint256)) return { trust: 'trusted', reason: 'certificate is a trust anchor' };
    seen.add(cur.fingerprint256);
    const issuer = pool.find((c) => !seen.has(c.fingerprint256) && cur.checkIssued(c) && cur.verify(c.publicKey));
    if (!issuer) {
      return { trust: 'untrusted', reason: cur.checkIssued(cur) ? 'self-signed certificate not in the trust store' : 'issuer not found / not in the trust store' };
    }
    if (!inValidity(issuer, at)) return { trust: 'untrusted', reason: 'intermediate certificate expired' };
    if (!issuer.ca) return { trust: 'untrusted', reason: 'issuer is not a CA' };
    cur = issuer;
  }
  return { trust: 'untrusted', reason: 'chain too long' };
}

function inValidity(x: X509Certificate, at: Date): boolean {
  return at >= new Date(x.validFrom) && at <= new Date(x.validTo);
}

function parseTime(buf: Buffer, t: Tlv): Date | null {
  const s = content(buf, t).toString('latin1');
  const m = t.tag === 0x17
    ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)
    : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return null;
  let y = Number(m[1]);
  if (t.tag === 0x17) y += y < 50 ? 2000 : 1900;
  return new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
}

// ── SignedData verification ──────────────────────────────────────────────────

export interface CmsVerifyResult {
  /** Signature cryptographically correct over the content (and messageDigest matches). */
  signatureValid: boolean;
  /** Signer certificate valid at signing time (or now when no signingTime). */
  certTimeValid: boolean;
  trust: TrustState;
  trustReason: string;
  emailProtectionEku: boolean;
  signerEmail?: string;
  signerName?: string;
  notBefore?: string;
  notAfter?: string;
  signingTime?: string;
  digestAlgorithm?: string;
  /** encapsulated content (opaque signed-data), when present */
  content?: Buffer;
  error?: string;
}

/**
 * Verify a DER/BER encoded ContentInfo(SignedData). `detached` is the signed
 * content for multipart/signed (exact bytes of the first MIME part).
 */
export function verifyCmsSignedData(der: Buffer, detached: Buffer | null, opts: { now?: Date; roots?: X509Certificate[] } = {}): CmsVerifyResult {
  const fail = (error: string, extra: Partial<CmsVerifyResult> = {}): CmsVerifyResult =>
    ({ signatureValid: false, certTimeValid: false, trust: 'untrusted', trustReason: 'not evaluated', emailProtectionEku: false, ...extra, error });
  let ci: Tlv;
  try { ci = readTlv(der, 0); } catch (e) { return fail(`invalid CMS structure: ${(e as Error).message}`); }
  const [ctOid, wrapped] = kids(ci);
  if (!ctOid || decodeOid(content(der, ctOid)) !== OID.signedData || !wrapped) return fail('not a CMS SignedData');
  const sd = kids(wrapped)[0];
  if (!sd) return fail('empty SignedData');
  const sdKids = kids(sd);
  const encap = sdKids[2];
  let i = 3;
  const certNodes: Tlv[] = [];
  if (sdKids[i]?.tag === 0xa0) { certNodes.push(...kids(sdKids[i]!)); i++; }
  if (sdKids[i]?.tag === 0xa1) i++; // CRLs
  const signerInfos = sdKids[i];
  if (!encap || !signerInfos) return fail('malformed SignedData');

  // encapsulated content
  let eContent: Buffer | null = null;
  const ecWrap = kids(encap)[1];
  if (ecWrap) { const os = kids(ecWrap)[0]; if (os) eContent = octets(der, os); }
  const signedContent = detached ?? eContent;
  if (!signedContent) return fail('no signed content');

  const certs = certNodes.filter((c) => c.tag === 0x30).map((c) => parseCert(Buffer.from(raw(der, c)))).filter((c): c is CertInfo => c !== null);
  const si = kids(signerInfos)[0];
  if (!si) return fail('no SignerInfo');
  const f = kids(si);
  const sid = f[1]!;
  let signer: CertInfo | undefined;
  if (sid.tag === 0x30) {
    const [iss, ser] = kids(sid);
    const issuerDer = iss ? raw(der, iss) : Buffer.alloc(0);
    const serial = ser ? canonSerial(content(der, ser)) : '';
    signer = certs.find((c) => c.serialHex === serial && c.issuerDer.equals(issuerDer));
  } else if (sid.tag === 0x80) {
    const ski = content(der, sid);
    signer = certs.find((c) => c.ski?.equals(ski));
  }
  const digestOid = decodeOid(content(der, kids(f[2]!)[0]!));
  const digestAlg = DIGESTS[digestOid];
  if (!digestAlg) return fail(`unsupported digest algorithm ${digestOid}`);

  let k = 3;
  const signedAttrs = f[k]?.tag === 0xa0 ? f[k++] : undefined;
  const sigAlgNode = f[k++]!;
  const sigNode = f[k]!;
  const sigAlgOid = decodeOid(content(der, kids(sigAlgNode)[0]!));
  const signature = content(der, sigNode);

  const base: Partial<CmsVerifyResult> = { digestAlgorithm: digestAlg, ...(eContent ? { content: eContent } : {}) };
  if (!signer) return fail('signer certificate not included in the message', base);
  const x = signer.x509;
  const email = certEmail(x);
  const name = certCn(x);
  Object.assign(base, {
    ...(email ? { signerEmail: email } : {}),
    ...(name ? { signerName: name } : {}),
    notBefore: new Date(x.validFrom).toISOString(),
    notAfter: new Date(x.validTo).toISOString(),
  });

  const contentDigest = createHash(digestAlg).update(signedContent).digest();
  let dataToVerify: Buffer;
  let signingTime: Date | null = null;
  if (signedAttrs) {
    let md: Buffer | null = null;
    for (const attr of kids(signedAttrs)) {
      const [oidNode, values] = kids(attr);
      if (!oidNode || !values) continue;
      const oid = decodeOid(content(der, oidNode));
      const v = kids(values)[0];
      if (!v) continue;
      if (oid === OID.messageDigest) md = Buffer.from(content(der, v));
      if (oid === OID.signingTime) signingTime = parseTime(der, v);
    }
    if (!md) return fail('signed attributes without messageDigest', base);
    if (!md.equals(contentDigest)) return fail('content does not match the signature (message modified)', base);
    // signature is over the DER SET OF — same bytes with the tag [0] IMPLICIT → SET (0x31)
    dataToVerify = Buffer.from(raw(der, signedAttrs));
    dataToVerify[0] = 0x31;
  } else {
    dataToVerify = signedContent;
  }
  if (signingTime) base.signingTime = signingTime.toISOString();

  let ok = false;
  try {
    const key = createPublicKey(x.publicKey.export({ type: 'spki', format: 'pem' }));
    const hashForSig = SIG_DIGEST[sigAlgOid] ?? digestAlg;
    if (sigAlgOid === OID.rsaPss) {
      ok = cryptoVerify(hashForSig, dataToVerify, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_AUTO }, signature);
    } else if (sigAlgOid === OID.rsaEncryption || SIG_DIGEST[sigAlgOid]) {
      ok = cryptoVerify(hashForSig, dataToVerify, key, signature);
    } else {
      return fail(`unsupported signature algorithm ${sigAlgOid}`, base);
    }
  } catch (e) {
    return fail(`signature check failed: ${(e as Error).message}`, base);
  }
  if (!ok) return fail('invalid signature', base);

  const at = signingTime ?? opts.now ?? new Date();
  const certTimeValid = inValidity(x, at) && (!signingTime || signingTime <= (opts.now ?? new Date()));
  const ekuList = x.keyUsage ?? [];
  const emailProtectionEku = ekuList.length === 0 || ekuList.includes(OID.emailProtection) || ekuList.includes(OID.anyEku);
  const trust = evaluateTrust(x, certs.map((c) => c.x509), at, opts.roots);
  return { ...base, signatureValid: true, certTimeValid, trust: trust.trust, trustReason: trust.reason, emailProtectionEku };
}
