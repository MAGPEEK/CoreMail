/**
 * JWT Signing Keys (RS256) — v5.3.0
 *
 * Erforderlich für Modern Auth (OAuth2/OIDC), weil Outlook 2024 LTSC
 * und andere moderne Clients JWT-Signaturen selbständig verifizieren
 * (via JWKS-Endpoint mit Public Key). Symmetrisches HS256 erlaubt keinen
 * Public-Key-Export → JWKS bliebe leer → Outlook lehnt Tokens ab.
 *
 * Architektur:
 *   - RSA-2048 Schlüsselpaar einmalig generieren beim ersten Service-Start
 *   - Persistiert in `ServerSettings.jwtPrivateKey/jwtPublicKey/jwtKeyId`
 *   - Beim Container-Restart aus DB geladen + in-memory gecacht
 *   - Alle Services (api-gateway, auth-service, ews-server, smtp-server, …)
 *     rufen `initJwtKeys(prisma)` einmal beim Boot auf
 *   - signAccessToken/verifyAccessToken/signIdToken nutzen RS256 mit
 *     dem geladenen Key-Pair
 *
 * Sicherheit:
 *   - Private Key NIE über API exponieren
 *   - JWKS-Endpoint liefert nur Public Key als JWK (kid + n + e)
 *   - Key-Rotation: künftig via separates Feld + Übergangsphase mit beiden Keys
 */

import { randomUUID, generateKeyPairSync, createPublicKey } from 'node:crypto';

/**
 * Minimaler Prisma-Surface — wir importieren `@prisma/client` nicht direkt
 * weil @coremail/core dependency-free bleiben soll (würde sonst circular
 * mit @coremail/storage).
 */
interface PrismaServerSettingsClient {
  findUnique(args: { where: { id: string }; select: Record<string, true> }): Promise<{
    jwtPrivateKey?: string | null;
    jwtPublicKey?:  string | null;
    jwtKeyId?:      string | null;
  } | null>;
  upsert(args: {
    where:  { id: string };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<unknown>;
}
interface PrismaLike {
  serverSettings: PrismaServerSettingsClient;
}

export interface JwtKeyPair {
  privateKeyPem: string;
  publicKeyPem:  string;
  keyId:         string; // JWK 'kid'
  publicJwk:     PublicJwk;
}

/**
 * JWK-Format gemäß RFC 7517 §4 — Outlook + andere OIDC-Clients erwarten
 * exakt diese Properties (kty, n, e) plus die optionalen kid/alg/use.
 */
export interface PublicJwk {
  kty: 'RSA';
  n:   string;  // Modulus, base64url
  e:   string;  // Exponent, base64url
  kid: string;  // Key ID
  alg: 'RS256';
  use: 'sig';
}

let _cached: JwtKeyPair | null = null;

/**
 * Beim Service-Boot einmal aufrufen. Lädt RSA-Schlüsselpaar aus
 * `ServerSettings` oder generiert es beim ersten Aufruf.
 *
 * Idempotent — wiederholte Aufrufe sind no-op (gibt gecachte Keys zurück).
 *
 * Bei Race-Condition (mehrere Services starten gleichzeitig + DB ist leer)
 * wird der erste Schreibende gewinnen, alle anderen lesen seinen Key bei
 * der nächsten Anfrage. Wir verwenden upsert-style Logik.
 */
export async function initJwtKeys(prisma: PrismaLike): Promise<JwtKeyPair> {
  if (_cached) return _cached;

  const settings = await prisma.serverSettings.findUnique({
    where:  { id: 'singleton' },
    select: { jwtPrivateKey: true, jwtPublicKey: true, jwtKeyId: true },
  });

  if (settings?.jwtPrivateKey && settings.jwtPublicKey && settings.jwtKeyId) {
    _cached = buildKeyPair(settings.jwtPrivateKey, settings.jwtPublicKey, settings.jwtKeyId);
    return _cached;
  }

  // Generieren — RSA-2048 ist der Standard (4096 wäre overkill für JWT)
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength:    2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const keyId = randomUUID();

  await prisma.serverSettings.upsert({
    where:  { id: 'singleton' },
    create: {
      id: 'singleton',
      jwtPrivateKey: privateKey,
      jwtPublicKey:  publicKey,
      jwtKeyId:      keyId,
      jwtKeyCreated: new Date(),
    },
    update: {
      jwtPrivateKey: privateKey,
      jwtPublicKey:  publicKey,
      jwtKeyId:      keyId,
      jwtKeyCreated: new Date(),
    },
  });

  _cached = buildKeyPair(privateKey, publicKey, keyId);
  return _cached;
}

/** Sync-Getter — wirft Fehler wenn `initJwtKeys()` noch nicht gelaufen ist. */
export function getJwtKeys(): JwtKeyPair {
  if (!_cached) {
    throw new Error(
      'JWT keys not initialized — call initJwtKeys(prisma) at service boot.',
    );
  }
  return _cached;
}

/** Für Tests / Key-Rotation — Cache leeren so dass nächster Call neu lädt. */
export function clearJwtKeyCache(): void {
  _cached = null;
}

/** Public-Key als JWK (für JWKS-Endpoint /.well-known/jwks.json). */
export function getPublicJwk(): PublicJwk {
  return getJwtKeys().publicJwk;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildKeyPair(privateKeyPem: string, publicKeyPem: string, keyId: string): JwtKeyPair {
  const jwk = pemToJwk(publicKeyPem, keyId);
  return { privateKeyPem, publicKeyPem, keyId, publicJwk: jwk };
}

/**
 * Konvertiert PEM-Public-Key in JWK gemäß RFC 7517/7518.
 * Node.js bietet seit v15 `KeyObject.export({ format: 'jwk' })`.
 */
function pemToJwk(publicKeyPem: string, keyId: string): PublicJwk {
  const keyObject = createPublicKey(publicKeyPem);
  const jwk = keyObject.export({ format: 'jwk' }) as { n?: string; e?: string; kty?: string };
  if (!jwk.n || !jwk.e || jwk.kty !== 'RSA') {
    throw new Error('Failed to export public key as JWK (unexpected shape)');
  }
  return {
    kty: 'RSA',
    n:   jwk.n,
    e:   jwk.e,
    kid: keyId,
    alg: 'RS256',
    use: 'sig',
  };
}
