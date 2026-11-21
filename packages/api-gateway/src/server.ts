import { initRuntimeLogLevel } from '@coremail/core';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { existsSync, readFileSync } from 'node:fs';
import { parseChangelog } from './lib/changelog.js';
import { join, resolve } from 'node:path';
import { createServer as createHttpServer, type ClientRequest, type IncomingMessage } from 'node:http';
import { httpHardening, httpServerOptions, hardenHttpServer, guardedRequestHandler } from './lib/http-hardening.js';
import {
  connectDatabase, prisma, migrateMailboxCounters,
  getObjectStore, getStorageHealth, peekStorageHealth, startObjectStorageCleaner, type CleanerRedis,
  startDeletedItemsPurger, type PurgeRedis, startMailboxAccessAuditPurger, type AccessPurgeRedis,
  startReferencesBackfill, type BackfillRedis, startContactBackfill, type ContactBackfillRedis,
  migratePrivateKeysAtRestLocked, type PrivateKeyMigrationRedis,
  startWebmailPolicySubscriber,
} from '@coremail/storage';
import {
  getRedisClient, createLogger, startAuthInvalidationSubscriber,
  installAsyncErrorHandling, installProcessGuards, errorMiddleware, parseTrustProxy, verifyAccessToken,
} from '@coremail/core';

// ── Security Middleware (OWASP) ───────────────────────────────────────────────
import {
  requestId,
  helmetMiddleware,
  suspiciousInputGuard,
  isLoopback,
  authRateLimit,
  authRouteRateLimit,
  setupRateLimit,
  adminMutationRateLimit,
  ssoRateLimit,
  passkeyRateLimit,
} from './middleware/security.js';

import { mailRouter } from './routes/mail.js';
import { followUpRouter } from './routes/follow-up-flags.js';
import { recoverableRouter, sharedRecoverableRouter, delegatedRecoverableRouter } from './routes/recoverable.js';
import { draftsRouter } from './routes/drafts.js';
import { mailTemplatesRouter } from './routes/mail-templates.js';
import { sharedMailboxContentRouter, delegatedMailboxContentRouter } from './routes/foreign-mailbox.js';
import { ownFolderPermissionsRouter } from './routes/folder-permissions.js';
import { calendarRouter } from './routes/calendar.js';
import { contactsRouter } from './routes/contacts.js';
import { tasksRouter } from './routes/tasks.js';
import { notesRouter } from './routes/notes.js';
import { userRouter } from './routes/user.js';
import { userSettingsRouter } from './routes/user-settings.js';
import { mfaEnforcementRouter } from './routes/mfa-enforcement.js';
import { userPolicyRouter } from './routes/user-policy.js';
import { ownPhotoRouter, usersPhotoRouter } from './routes/profile-photo.js';
import { userBackgroundRouter } from './routes/user-background.js';
import { readReceiptRouter } from './routes/read-receipts.js';
import { appleProfileRouter } from './routes/apple-profile.js';
import { categoriesRouter } from './routes/categories.js';
// Public Folders completely removed in v3.18.31
// eDiscovery & Legal Hold completely removed in v3.18.5
// Journaling feature completely removed in v3.13.6
import { getAcmeChallenge } from './routes/admin/certificates.js';
import { mountAdminRoutes } from './routes/admin/index.js';
import { adminMeRouter } from './routes/admin/me.js';
import { startTlsProxy, setTlsUpgradeHandler, httpsRedirectState } from './tls-proxy.js';
import { startCertRenewalScheduler, repairStaleAcmeStates, scheduleStaleRepairAfterLockTtl } from './lib/cert-renewal.js';
import { reconcileProtocolCertStateLocked } from './lib/protocol-cert-assign.js';
// auto-letsencrypt removed — admin requests LE manually via BCP → SSL/TLS
// adminExternalContactsRouter completely removed in v3.18.33
import { pushRouter } from './routes/push.js';
import { smimeRouter } from './routes/smime.js';
import { setupRouter } from './routes/setup.js';
import { setupFollowUpRouter } from './routes/setup-followup.js';
import { authRouter } from './routes/auth.js';
import { ssoRouter } from './routes/sso.js';
import { startLdapSyncScheduler } from '@coremail/auth-ldap';
import { retentionTagsRouter } from './routes/retention-tags.js';
import { requireAuth, requireSseAuth } from './middleware/auth.js';
import { eventTicketHandler } from './lib/event-tickets.js';
import { createApiRateLimit } from './lib/api-rate-limit.js';
import { apiRateLimitConfig, startApiRateLimitRefresh } from './lib/api-rate-limit-state.js';
import { applyUpstreamHeaders, type TrustFn } from './lib/proxy-headers.js';
import { createHttpsRedirect, hstsOnHttps } from './lib/https-redirect.js';
import { sseHandler } from './sse.js';
import { startSseHub } from './lib/sse-hub.js';
import { sseLiveConnections } from './lib/live-sse.js';
import { auditMiddleware } from './lib/audit.js';
import { syncServerUrlsFromHostname } from './lib/server-urls.js';
import { initSetupToken } from './lib/setup-token.js';
import { livenessHandler } from './lib/liveness.js';
import { brandingApiRouter, brandingAssetsRouter, brandingAppIconsRouter, brandingFaviconsRouter, webManifestHandler } from './routes/branding.js';
import { brandedIndexHtml, startBrandingSubscriber } from './lib/branding/state.js';
import { createMcpRouter } from './lib/mcp/handler.js';
import { startMcpSettingsSubscriber } from './lib/mcp/settings.js';
import { mcpLiveConnections } from './lib/mcp/sessions.js';
import { hashMcpToken, looksLikeMcpToken, startPasskeyPolicySubscriber } from '@coremail/storage/auth';
import { migrateLegacyWebAuthnCredentials } from '@coremail/storage/auth/webauthn';
import { wellKnownWebauthn } from './lib/passkeys-well-known.js';
import { startAttackProtection, connectGuard } from '@coremail/storage';
import { createIpBlocklistGuard, upgradeBlocked } from './lib/ip-blocklist-guard.js';
import { dockerGatewayCandidates, ipVerifiedMark, trustProxyKind, trustProxyWarnings } from './lib/client-ip-trust.js';
import { startAttackProtectionWorker } from './lib/attack-protection-worker.js';

const log = createLogger('api-gateway');
installProcessGuards(log);
const app = express();
const PORT = parseInt(process.env['API_PORT'] ?? '3000', 10);

// ── BigInt serialization (Prisma returns BigInt for quota fields) ─────────────
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
  return Number(this);
};

// ── Trust Proxy ───────────────────────────────────────────────────────────────
// v6: configurable via TRUST_PROXY (default: false). Port 3000 and the
// integrated TLS proxy serve clients DIRECTLY — trusting X-Forwarded-For there
// lets any client spoof its IP (rate-limit bypass, forged audit IPs). Set
// TRUST_PROXY only when a reverse proxy that overwrites X-Forwarded-For sits in
// front of port 3000: a hop count ("1") or the proxy's address/CIDR
// ("172.18.0.0/16", "loopback"). Requests through the integrated TLS proxy
// never honour forwarded headers (stripped in tls-proxy.ts).
app.set('trust proxy', parseTrustProxy(process.env['TRUST_PROXY']));
// 10.5 review: only an address from the socket or from an EXPLICIT proxy allow-list
// is escalated by the attack protection (lib/client-ip-trust.ts); a hop count / `true`
// or a TRUST_PROXY that covers the Docker bridge gateway is warned about at start.
const TRUST_KIND = trustProxyKind(process.env['TRUST_PROXY']);
for (const w of trustProxyWarnings(process.env['TRUST_PROXY'], app.get('trust proxy fn') as TrustFn, dockerGatewayCandidates())) {
  log.warn(w);
}

// ── Crash safety ──────────────────────────────────────────────────────────────
// v6: async handler rejections → error middleware (not process death).
installAsyncErrorHandling(express);

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY MIDDLEWARE STACK
// Order is critical — do not change without reading the comments!
// ═══════════════════════════════════════════════════════════════════════════════

// 0. 10.5 review: client-sent X-CoreMail-Ip-Verified dropped; set when req.ip is
//    verified (socket peer / explicit TRUST_PROXY list) — read by the web login lockout.
app.use(ipVerifiedMark(TRUST_KIND));

// 1. Request-ID — before everything else so that logs can be correlated
app.use(requestId);

// 1b. 10.5: permanent IP block list (BCP → Angriffsschutz) — every HTTP surface
//     (webmail, BCP, API, ActiveSync, DAV, JMAP, MAPI, Autodiscover, MCP) answers 403.
app.use(createIpBlocklistGuard());

// 2. Helmet — set security headers on every response
//    Must come early so that error responses carry the right headers too.
app.use(helmetMiddleware);
// 8.0.x: HSTS only on HTTPS responses (helmet's own HSTS is off)
app.use(hstsOnHttps);

// 2b. HTTP → HTTPS redirect (8.0.x) once the integrated HTTPS proxy serves a
//     certificate active for HTTPS. Exempt: ACME HTTP-01, /healthz, /livez,
//     loopback peers. HTTP_REDIRECT_HTTPS=false disables it (lib/https-redirect.ts).
let redirectHostCache: { host: string | null; expires: number } | null = null;
app.use(createHttpsRedirect({
  state: httpsRedirectState,
  publicHostname: async () => {
    if (redirectHostCache && redirectHostCache.expires > Date.now()) return redirectHostCache.host;
    const s = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { publicHostname: true } });
    redirectHostCache = { host: s?.publicHostname ?? null, expires: Date.now() + 60_000 };
    return redirectHostCache.host;
  },
}));

// 3. Suspicious-input guard — before the body parser consumes the stream
//    Blocks CRLF injection, null bytes, path traversal, oversized headers.
app.use(suspiciousInputGuard);

// 4. Global API rate limit (9.4) — signed-in requests per user, anonymous ones per IP;
//    static assets, the live-event stream and loopback peers are exempt. Configurable in
//    BCP → Settings → Security / API_RATE_LIMIT_* (lib/api-rate-limit.ts).
app.use(createApiRateLimit({
  config: apiRateLimitConfig,
  // 10.3: an admin MCP token (cm_mcp_…) is its own bucket (per token, the per-user
  // limit) — its validity is checked at /mcp, where guesses hit the shared IP lockout.
  verifyUser: (token) => (looksLikeMcpToken(token) ? `mcp:${hashMcpToken(token).slice(0, 32)}` : verifyAccessToken(token)?.sub ?? null),
  isLoopback,
  onLimited: ({ kind, path }) => log.warn({ kind, path }, 'API rate limit exceeded'),
}));

// v5.6.0: OIDC Discovery + JWKS removed (OAuth2 completely out of the stack).

// ── ACME HTTP-01 Challenge ────────────────────────────────────────────────────
// Must come before the proxies (no auth, no body parser needed).
app.get('/.well-known/acme-challenge/:token', async (req, res) => {
  const token = req.params['token'] ?? '';
  // Token may only contain alphanumerics + hyphen/underscore (ACME spec)
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(token)) {
    res.status(400).send('Invalid token');
    return;
  }
  const keyAuth = await getAcmeChallenge(token);
  if (!keyAuth) { res.status(404).send('Not found'); return; }
  res.type('text/plain').send(keyAuth);
});

// ── 10.6: WebAuthn Related Origin Requests (Level 3 §5.11) ────────────────────
// Lists the further origins that may use this RP ID (BCP → Authentifizierung →
// Passkeys). 404 while passkeys are off everywhere or no related origin is set.
app.get('/.well-known/webauthn', async (_req, res) => {
  try {
    const body = await wellKnownWebauthn();
    if (!body) { res.status(404).json({ error: 'Not found' }); return; }
    res.set('Cache-Control', 'public, max-age=300').json(body);
  } catch (err) {
    log.warn({ err }, '/.well-known/webauthn failed');
    res.status(503).json({ error: 'Temporarily unavailable' });
  }
});

// ── Internal proxies — register BEFORE express.json()! ───────────────────────
// express.json() consumes the body stream. Proxy routes must therefore come
// first so they can forward the body directly.
const EAS_URL = process.env['EAS_SERVICE_URL']  ?? 'http://localhost:3005';
const DAV_URL = process.env['CALDAV_SERVICE_URL'] ?? 'http://localhost:8082';
const BACKUP_URL = process.env['BACKUP_SERVICE_URL'] ?? 'http://localhost:3004';
// v3.18.35: Autodiscover has its OWN service on port 8081.
const AUTODISCOVER_URL = process.env['AUTODISCOVER_SERVICE_URL'] ?? 'http://localhost:8081';
// v5.7.1: JMAP server (RFC 8620/8621 + extensions) on port 3006
const JMAP_URL = process.env['JMAP_SERVICE_URL'] ?? 'http://localhost:3006';

/**
 * v6: real client IP for internal services. Internal services (jmap, caldav,
 * activesync, autodiscover, auth-service) take the right-most X-Forwarded-For
 * hop from a loopback/private peer — the gateway therefore always OVERWRITES
 * the header (never appends), so a client-supplied value cannot spoof the IP
 * used for lockouts and logs.
 * 8.0.x: the same applies to every other forwarding / internal identity header
 * (Forwarded, X-Forwarded-Host/-Proto/-Port, X-Real-IP, X-Internal-*, …):
 * client values are removed and Proto/Host are set from trusted values
 * (lib/proxy-headers.ts).
 */
function setUpstreamForwardedFor(proxyReq: ClientRequest, req: IncomingMessage): void {
  applyUpstreamHeaders(proxyReq, req, app.get('trust proxy fn') as TrustFn, TRUST_KIND);
}

function internalProxy(targetBase: string): express.RequestHandler {
  const proxy = createProxyMiddleware({
    target: targetBase,
    changeOrigin: true,
    on: {
      proxyReq: (proxyReq, req) => {
        // Express strips the mount prefix from req.url — restore originalUrl
        proxyReq.path = (req as express.Request).originalUrl;
        setUpstreamForwardedFor(proxyReq, req);
      },
      error: (err, _req, res) => {
        log.warn({ err, target: targetBase }, 'Proxy error');
        if (!('headersSent' in res && res.headersSent)) {
          (res as express.Response).status(502).json({ error: 'Service temporarily unavailable' });
        }
      },
    },
  });
  return proxy as express.RequestHandler;
}

// v7.0.0: EWS removed (EWS service package gone). Answer 404
// for every method instead of letting GET fall through to the SPA index.html.
// Express paths are case-insensitive, so /EWS also covers /ews.
const GONE_PREFIXES = ['/EWS', '/OAB'];
app.use(GONE_PREFIXES, (_req, res) => { res.status(404).json({ error: 'Not found' }); });
// 9.4: MAPI over HTTP (desktop mail clients) — mapi-server, off per account by default
// (protocol switch `mapi`). Binary bodies: proxied before express.json().
const MAPI_URL = process.env['MAPI_SERVICE_URL'] ?? 'http://localhost:3007';
app.use('/mapi', internalProxy(MAPI_URL));
// v5.7.1: JMAP — toggle in BCP → Server → „JMAP" (jmap-server returns 404 when off).
// WebSocket upgrades (/jmap/ws, RFC 8887) are forwarded to jmapProxy.upgrade in
// start() on the HTTP server and in the TLS proxy.
const jmapProxy = createProxyMiddleware({
  target: JMAP_URL,
  changeOrigin: true,
  ws: true,
  on: {
    proxyReq: (proxyReq, req) => {
      proxyReq.path = (req as express.Request).originalUrl;
      setUpstreamForwardedFor(proxyReq, req);
    },
    // WebSocket upgrades (/jmap/ws) are raw IncomingMessages — same overwrite
    proxyReqWs: (proxyReq, req) => { setUpstreamForwardedFor(proxyReq, req); },
    error: (err, _req, res) => {
      log.warn({ err, target: JMAP_URL }, 'JMAP proxy error');
      if ('writeHead' in res && !('headersSent' in res && res.headersSent)) {
        (res as express.Response).status(502).json({ error: 'Service temporarily unavailable' });
      }
    },
  },
});
export const jmapUpgrade = jmapProxy.upgrade;
app.use('/jmap',             jmapProxy as express.RequestHandler);
app.use('/.well-known/jmap', jmapProxy as express.RequestHandler);
app.use('/Autodiscover', internalProxy(AUTODISCOVER_URL));
app.use('/autodiscover', internalProxy(AUTODISCOVER_URL));
// v8.1: Thunderbird / Mozilla autoconfig (autodiscover service): on the mail domain
// (/.well-known/autoconfig/…) and on autoconfig.<domain> (/mail/config-v1.1.xml).
// Anonymous; the service answers per domain only and rate-limits per client IP.
app.use('/.well-known/autoconfig', internalProxy(AUTODISCOVER_URL));
app.use('/mail/config-v1.1.xml',   internalProxy(AUTODISCOVER_URL));
// v8.1: Apple configuration profile (.mobileconfig) for the signed-in user (requireAuth
// inside; GET only, so it can sit before express.json()).
app.use('/api/v1/user/apple-profile', appleProfileRouter);
app.use('/Microsoft-Server-ActiveSync', internalProxy(EAS_URL));
app.use('/dav',          internalProxy(DAV_URL));
// v7.1.0: CalDAV/CardDAV service discovery (RFC 6764 §5) — the caldav-server redirects
// these to the /dav/ context path (previously a JSON 404 from the gateway).
app.use(['/.well-known/caldav', '/.well-known/carddav'], internalProxy(DAV_URL));

// Auth-service routes (MFA, app passwords, sessions) — BEFORE express.json()!
// Login/Refresh/Logout are implemented directly in authRouter (no proxy needed).
const AUTH_SERVICE_URL = process.env['AUTH_SERVICE_URL'] ?? 'http://localhost:3003';
// v7.0.0: the auth-service gets the real client IP (per-IP MFA failure limit,
// session IP). The header is overwritten, never appended, so clients cannot spoof it.
const authServiceProxy = createProxyMiddleware({
  target: AUTH_SERVICE_URL,
  changeOrigin: true,
  on: {
    proxyReq: (proxyReq, req) => {
      proxyReq.path = (req as express.Request).originalUrl;
      setUpstreamForwardedFor(proxyReq, req);
    },
    error: (err, _req, res) => {
      log.warn({ err, target: AUTH_SERVICE_URL }, 'Proxy error');
      if (!('headersSent' in res && res.headersSent)) {
        (res as express.Response).status(502).json({ error: 'Service temporarily unavailable' });
      }
    },
  },
}) as express.RequestHandler;
// v7.0.0: /auth/mfa/* (verify, WebAuthn auth start, MFA changes) behind the strict
// auth limiter; read-only GETs (status) are exempt so the settings page cannot lock users out.
const mfaRateLimit: express.RequestHandler = (req, res, next) =>
  req.method === 'GET' ? next() : authRateLimit(req, res, next);
app.use('/auth/mfa',           mfaRateLimit, authServiceProxy);
app.use('/auth/app-passwords', authServiceProxy);
app.use('/auth/sessions',      authServiceProxy);
// 10.6: passkeys — public sign-in / recovery (own per-IP limiter) and the
// signed-in user's passkey management (changes behind the auth limiter).
app.use('/auth/passkey',       passkeyRateLimit, authServiceProxy);
app.use('/auth/passkeys',      mfaRateLimit, authServiceProxy);

// ── Admin MCP interface (10.3, docs/mcp.md) — before express.json(): own body
// limit. Off (BCP → Infrastruktur → KI-Schnittstelle) → 404 like an unknown path.
app.use('/mcp', createMcpRouter());
// v5.6.0: /oauth2/* proxy removed (OAuth2 server gone).
// v5.4.0: ADFS emulation removed (was for Modern Auth of LTSC 2024 desktop clients).

// ── Body parser ───────────────────────────────────────────────────────────────
// JSON — 10 MB limit (for mail content with inline images)
app.use(express.json({ limit: '10mb' }));
// URL-encoded (forms) — 1 MB limit
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ── SSO (OIDC) — v6.1: own limiter (one login = 3 requests), before /auth ────
app.use('/auth/sso', ssoRateLimit, ssoRouter);

// ── Auth — strict limiter on login/reset; refresh/logout own limiter (v8.1) ───
app.use('/auth', authRouteRateLimit, authRouter);

// ── Health ────────────────────────────────────────────────────────────────────
// No rate limit on /healthz (called by Docker every 30s)
const PKG_PATH = resolve(process.cwd(), 'packages/api-gateway/package.json');
const APP_VERSION: string = (() => {
  try {
    const raw = readFileSync(PKG_PATH, 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
// v7.1: reports the object storage driver + startup-check status; 503 while the
// check is blocking (objects referenced by the DB missing / storage unusable).
app.get('/healthz', (_req, res) => {
  let storage: { driver: string; status: string };
  let ok = true;
  try {
    const last = peekStorageHealth();
    void getStorageHealth().catch(() => undefined); // refresh in the background when stale
    storage = last ? { driver: last.driver, status: last.status } : { driver: getObjectStore().driver, status: 'pending' };
    ok = !last?.blocking;
  } catch (err) {
    storage = { driver: 'invalid', status: `config error: ${(err as Error).message}` };
    ok = false;
  }
  res.status(ok ? 200 : 503).json({ ok, service: 'api-gateway', version: APP_VERSION, storage });
});
// 8.0.0: liveness without the storage status (Kubernetes liveness/startup probes) —
// /healthz above is the readiness signal.
app.get('/livez', livenessHandler);

// ── Public maintenance-mode status (no auth needed) ───────────────────────────
// Queried by the MWA LoginPage to display the maintenance banner.
app.get('/api/v1/maintenance', async (_req, res) => {
  try {
    const cfg = await prisma.serverSettings.findUnique({
      where:  { id: 'singleton' },
      select: { maintenanceMode: true, maintenanceMessage: true },
    });
    res.json({
      maintenanceMode:    cfg?.maintenanceMode    ?? false,
      maintenanceMessage: cfg?.maintenanceMessage ?? '',
    });
  } catch {
    res.json({ maintenanceMode: false, maintenanceMessage: '' });
  }
});

// ── Branding (9.3) — public: the login page needs it before auth ─────────────
// GET /api/v1/branding (public JSON) and GET /branding/assets/<sha256>.<ext>
// (immutable, nosniff, sandbox CSP). Admin side: routes/admin/branding.ts.
app.use('/api/v1/branding', brandingApiRouter);
app.use('/branding/assets', brandingAssetsRouter);
app.use('/branding/app-icons', brandingAppIconsRouter);
// favicons derived from the light logo when no own favicon is set (lib/branding/favicon.ts)
app.use('/branding/favicons', brandingFaviconsRouter);
// 9.4: web app manifest of the webmail (installable PWA), from the branding
app.get('/manifest.webmanifest', webManifestHandler);

// ── Changelog API ─────────────────────────────────────────────────────────────
const CHANGELOG_PATH = process.env['CHANGELOG_PATH']
  ?? resolve(process.cwd(), 'CHANGELOG.md');

app.get('/api/v1/changelog', (_req, res) => {
  try {
    const raw = readFileSync(CHANGELOG_PATH, 'utf-8');
    res.json({ versions: parseChangelog(raw), raw });
  } catch {
    res.status(503).json({ error: 'Changelog not available' });
  }
});

// ── SSE ───────────────────────────────────────────────────────────────────────
// 8.0.x: the access token is accepted in the query ONLY here (EventSource) —
// preferably as a single-use ticket: POST /api/v1/events/ticket → ?ticket=…
// (?token= stays for one release, deprecated). Every other route: header only.
app.post('/api/v1/events/ticket', requireAuth, eventTicketHandler);
app.get('/api/v1/events', requireSseAuth, sseHandler);

// ── Feature Routes ────────────────────────────────────────────────────────────
// 10.4.2: secrets download + finish marker (admin session, own rate limit) —
// before the setup router so they never count against /verify-token + /complete.
app.use('/api/v1/setup', setupFollowUpRouter);
app.use('/api/v1/setup', setupRateLimit, setupRouter);

app.use('/api/v1/mail/recoverable', recoverableRouter); // v8.1 Recover deleted items
// 9.1: recover deleted items of shared / delegated mailboxes (FULL_ACCESS)
app.use('/api/v1/user/shared-mailboxes/:id/recoverable', sharedRecoverableRouter);
app.use('/api/v1/mail/delegated-mailboxes/:id/recoverable', delegatedRecoverableRouter);
// 9.3: folders + messages of shared / delegated mailboxes (webmail, same shapes as /mail).
// The pre-9.3 /api/v1/user/shared-mailboxes/:id/{folders,messages} routes keep their old
// contract in routes/user.ts (compat) — the new router lives under /api/v1/mail.
app.use('/api/v1/mail/shared-mailboxes/:id', sharedMailboxContentRouter);
app.use('/api/v1/mail/delegated-mailboxes/:id', delegatedMailboxContentRouter);
app.use('/api/v1/mail/drafts',    draftsRouter);
app.use('/api/v1/mail/templates', mailTemplatesRouter); // 10.1: personal mail templates
app.use('/api/v1/mail/follow-up', followUpRouter); // 9.4: follow-up flags
app.use('/api/v1/mail',           readReceiptRouter); // 9.4: POST /messages/:id/receipt
app.use('/api/v1/mail',           ownFolderPermissionsRouter); // w3: GET|PUT /folders/:folderId/permissions
app.use('/api/v1/mail',           mailRouter);
app.use('/api/v1/calendar',       calendarRouter);
app.use('/api/v1/contacts',       contactsRouter);
app.use('/api/v1/tasks',          tasksRouter);
app.use('/api/v1/notes',          notesRouter);
app.use('/api/v1/user/photo',     ownPhotoRouter);     // 9.5: own profile photo (PUT/DELETE)
app.use('/api/v1/user/background', userBackgroundRouter); // 10.1: own webmail background (GET/PUT/DELETE, own only)
app.use('/api/v1/users',          usersPhotoRouter);   // 9.5: photos of the organisation (lookup, GET /:id/photo)
app.use('/api/v1/user/mfa-enforcement', mfaEnforcementRouter); // 10.5: MFA enforcement state (allowed while enrolment is required)
app.use('/api/v1/user',           userSettingsRouter); // 9.4: preferences, sessions, signatures
app.use('/api/v1/user',           userPolicyRouter);   // 9.4: webmail features + trusted image senders
app.use('/api/v1/user',           userRouter);
app.use('/api/v1/categories',     categoriesRouter);
app.use('/api/v1/smime',          smimeRouter);
app.use('/api/v1/retention-tags', retentionTagsRouter);
app.use('/api/v1/push',           pushRouter);

// ── Admin Routes ──────────────────────────────────────────────────────────────
// Audit middleware for all mutating admin calls (fire-and-forget)
app.use('/api/v1/admin', auditMiddleware);
// Additional rate limit on mutating admin operations (POST/PUT/PATCH/DELETE)
app.use('/api/v1/admin', adminMutationRateLimit);

// v6: router table + per-router RBAC guards live in routes/admin/index.ts
mountAdminRoutes(app);
app.use('/api/v1/admin/me', adminMeRouter); // 8.x: GET /me/permissions for the BCP

// ── Static frontend files (MWA under root + BCP under /bcp) ──────────────────
const WWW_DIR = process.env['WWW_DIR'] ?? '/app/www';
const owaDir  = join(WWW_DIR, 'owa');
const bcpDir  = join(WWW_DIR, 'bcp');

// Legacy: redirect old /owa/* URLs to the root path (backwards compat for
// saved bookmarks from earlier versions)
app.get('/owa', (_req, res) => res.redirect(301, '/'));
app.get('/owa/*', (req, res) => {
  const stripped = req.originalUrl.replace(/^\/owa\/?/, '/');
  res.redirect(301, stripped);
});

/**
 * 9.3: index.html of the webmail / BCP with the branding injected (colour var,
 * <title>, favicon, #cm-branding JSON); cached per branding version
 * (lib/branding/state.ts). Never cached by the browser.
 */
async function sendBrandedIndex(res: express.Response, file: string): Promise<void> {
  const html = await brandedIndexHtml(file);
  if (html === null) { res.status(404).json({ error: 'Not found' }); return; }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('html').send(html);
}

// BCP keeps the /bcp prefix (admin panel has its own Vite base)
if (existsSync(bcpDir)) {
  const bcpIndex = join(bcpDir, 'index.html');
  // Before express.static so the raw index.html is never served unbranded.
  app.get(['/bcp', '/bcp/index.html'], (_req, res) => sendBrandedIndex(res, bcpIndex));
  app.use('/bcp', express.static(bcpDir, {
    index: false,
    maxAge: '1y',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));
  app.get('/bcp/*', (_req, res) => sendBrandedIndex(res, bcpIndex));
  log.info({ dir: bcpDir }, 'Serving BCP static files');
}

// MWA frontend under root — must come AFTER all API routes so that
// /auth/* /api/* /jmap/* etc. take precedence. Catch-all `app.get('*')` sends
// all unknown routes back to index.html (SPA routing).
if (existsSync(owaDir)) {
  const owaIndex = join(owaDir, 'index.html');
  app.get('/index.html', (_req, res) => sendBrandedIndex(res, owaIndex));
  app.use(express.static(owaDir, {
    maxAge: '1y',
    index: false, // we serve index.html manually so the catch-all applies
    setHeaders(res, filePath) {
      // 9.4: the service worker (sw.js + its importScripts) must update with every release
      if (filePath.endsWith('.html') || /[\\/]sw(?:-logic)?\.js$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));
  // SPA catch-all: everything not matched so far that is NOT a known
  // API/proxy route is an MWA route → return index.html.
  const API_PREFIXES = [
    '/api/', '/auth/', '/.well-known/', '/jmap', '/Autodiscover', '/autodiscover',
    '/Microsoft-Server-ActiveSync', '/dav', '/bcp', '/branding/', '/mapi', '/mcp',
  ];
  app.get('*', (req, res, next) => {
    if (API_PREFIXES.some((p) => req.path === p || req.path.startsWith(p))) {
      return next();
    }
    return sendBrandedIndex(res, owaIndex);
  });
  log.info({ dir: owaDir }, 'Serving webmail static files (root)');
} else {
  // No MWA bundle mounted — root redirects to /bcp or plain info
  app.get('/', (_req, res) => res.redirect(302, '/bcp/'));
}

// ── 404 + error handler ───────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// v6: shared error middleware — Prisma P2002→409, P2025→404, Zod→400, else
// a generic 500. Never sends stack/err.message (OWASP A05).
app.use(errorMiddleware(log));

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  await connectDatabase();
  // v6: one-time setup token (logged while the setup wizard is pending) +
  // backfill of the persistent setup flag for existing installations.
  await initSetupToken(log).catch((err) => log.error({ err }, 'Setup token initialisation failed — setup wizard stays locked'));
  void initRuntimeLogLevel('api-gateway', { aliases: ['api'] }); // BCP per-service log level
  startApiRateLimitRefresh(); // 9.4: BCP-configurable API rate limit (60 s refresh)
  startBrandingSubscriber(); // 9.3: branding changes of other instances → drop cached index.html
  startWebmailPolicySubscriber(); // 9.4: webmail policy changes of other instances → drop the policy cache
  void startSseHub(); // one Redis subscriber → SSE fan-out + Web Push (lib/sse-hub.ts)
  // v7.1.0: session revocations done by the auth-service / LDAP sync reach
  // requireAuth's in-process revocation check immediately.
  // v7.1.0: … and end the user's SSE streams (/api/v1/events) like JMAP Bearer push.
  sseLiveConnections.attachInvalidation();
  // 10.3: admin MCP sessions end with the owner's "revoke all" / deletion / token revocation
  mcpLiveConnections.attachInvalidation();
  startMcpSettingsSubscriber(); // switch / allowlist changes of other gateway instances
  startAuthInvalidationSubscriber();
  // 10.5: block list / exceptions cache + reload subscriber; notice flusher + purge
  startAttackProtection();
  startAttackProtectionWorker();
  // Message store migration: raise Mailbox.highestModSeq / uidNext above legacy
  // Date.now()-sized modSeqs and max(uid)+1 UIDs (idempotent; the first
  // allocation per mailbox repeats this check lazily in every service).
  void migrateMailboxCounters(prisma)
    .then((n) => { if (n > 0) log.info({ mailboxes: n }, 'Mailbox UID/modSeq counters migrated'); })
    .catch((err) => log.warn({ err }, 'Mailbox counter migration failed — lazy per-mailbox check still applies'));
  // v5.6.0: initJwtKeys() removed (RS256 keys were for OAuth2 — completely gone)
  getRedisClient();
  // 10.6: passkey policy changes of other instances; one-time backfill of the
  // deprecated UserMfa.webAuthnCredentials JSON (idempotent, Redis lock)
  startPasskeyPolicySubscriber();
  void migrateLegacyWebAuthnCredentials()
    .catch((err) => log.error({ err }, 'Legacy security key migration failed — retried at the next start'));
  // v7.1 object storage: startup check (logged; /healthz reports it — the
  // gateway itself stays up so the admin API / migration remain reachable) and
  // the periodic expiry cleaner where no S3 lifecycle rules apply (filesystem
  // driver, or providers that refuse lifecycle configuration).
  void getStorageHealth(0, true).then((r) => {
    const ctx = { driver: r.driver, location: r.location, status: r.status, sampled: r.sampled, missing: r.missing };
    if (r.blocking) log.error({ ...ctx, error: r.error }, `Object storage check FAILED — mail services wait. ${r.error ?? ''} ${r.hint ?? ''}`.trim());
    else log.info(ctx, 'Object storage ready');
    if (r.driver === 'filesystem' || r.lifecycle === false) {
      startObjectStorageCleaner(getObjectStore(), getRedisClient() as unknown as CleanerRedis);
      log.info({ driver: r.driver }, 'Object storage expiry cleaner scheduled (outbound-queue 7 d, quarantine 90 d, jmap-upload 7 d)');
    }
  }).catch((err) => log.error({ err }, 'Object storage check failed'));
  log.info({ port: PORT }, 'API Gateway listening');
  // 10.5: header/request/keep-alive timeouts + per-IP and global connection caps
  // against slowloris, slow POST and idle-connection floods (lib/http-hardening.ts).
  // On port 3000 a TRUST_PROXY-trusted peer (the reverse proxy all clients share)
  // is not subject to the per-IP cap; the global cap still applies.
  const hardening = httpHardening();
  const trustFn = app.get('trust proxy fn') as TrustFn;
  const httpServer = createHttpServer(httpServerOptions(hardening.config), guardedRequestHandler(hardening.guard, app));
  hardenHttpServer(httpServer, {
    kind: 'http',
    guard: hardening.guard,
    config: hardening.config,
    isTrustedProxyPeer: (ip) => trustFn(ip, 0),
    stallWatcher: hardening.stallWatcher, // 10.5 review: slow readers
  });
  httpServer.listen(PORT);
  // v5.7.1: JMAP over WebSocket (RFC 8887) — pass upgrade requests through to the jmap-server
  httpServer.on('upgrade', (req, socket, head) => {
    if (hardening.guard.isRefused(req.socket)) { socket.destroy(); return; }
    // 10.5: block list — 10.5 review: the client IP with the same trust function as requests
    if (upgradeBlocked(req, connectGuard, trustFn)) { socket.destroy(); return; }
    if (req.url?.startsWith('/jmap/ws') && jmapUpgrade) jmapUpgrade(req, socket as never, head);
    else socket.destroy();
  });

  // Integrated HTTPS reverse proxy — starts automatically once a certificate
  // has been set in BCP → SSL/TLS → "Als HTTPS aktivieren".
  // Hot-reload on certificate activation via Redis (no restart needed).
  setTlsUpgradeHandler((req, socket, head) => {
    // 10.5: block list (the TLS proxy strips forwarding headers: the socket peer is the client)
    if (upgradeBlocked(req, connectGuard, trustFn)) socket.destroy();
    else if (req.url?.startsWith('/jmap/ws') && jmapUpgrade) jmapUpgrade(req, socket as never, head);
    else socket.destroy();
  });
  void startTlsProxy(app).catch(err =>
    log.warn({ err }, 'TLS proxy startup failed — HTTPS not available'),
  );

  // ── Startup consistency check (9.3): the certificate holding SMTP/IMAP/POP3
  // in the certificates table is applied when server_settings.tlsCert /
  // isActiveProtocol disagree (repairs installs where the BCP showed the mail
  // services on a Let's Encrypt cert while the ports served mail.localhost).
  void syncProtocolCertState().catch(err =>
    log.warn({ err }, 'Protocol cert state sync failed — check certificates manually'),
  );

  // Certificate private keys at rest: values stored as plain PEM before
  // encryption existed are encrypted once (Redis-locked, idempotent; readers
  // accept both forms meanwhile).
  void encryptStoredPrivateKeys().catch(err =>
    log.error({ err }, 'Encrypting stored certificate private keys failed — retried at the next start'),
  );

  // v3.18.35+36: URL synchronization. When the admin changed publicHostname
  // (e.g. from mail.local to mail.<real-domain>), the derived URLs were not
  // migrated along. Autodiscover then returns stale addresses →
  // clients cannot connect. This migration fixes all URL fields at container
  // start (in addition to the synchronous updates on domain-create /
  // make-primary / settings-PUT).
  void syncServerUrlsFromHostname().catch(err =>
    log.warn({ err }, 'Server-URL sync failed — check Autodiscover'),
  );

  // ── Clean up stale PENDING/RENEWING certificates ──────────────────────────
  // After a container restart certs can be stuck in PENDING or RENEWING (the
  // ACME run died with the process). 9.2.x: every run holds a per-certificate
  // Redis lock, so any in-progress cert WITHOUT a lock holder is reset to
  // ERROR ("interrupted", retry possible) — the scheduler repeats this hourly.
  void repairStaleAcmeStates(new Date(), 0)
    .then((n) => { if (n > 0) log.warn({ count: n }, 'Stale PENDING/RENEWING certificates reset to ERROR on startup'); })
    .catch((err) => log.warn({ err }, 'Failed to cleanup stale pending certificates (non-fatal)'));
  // A dead run's lock without heartbeat may still be too young at startup —
  // repeat once after the lock TTL (no cert stays RENEWING for an hour).
  scheduleStaleRepairAfterLockTtl();

  // No auto-LE issuance — admin requests Let's Encrypt manually via BCP → SSL/TLS.
  // v6: certificate lifecycle — hourly status recomputation (ACTIVE/EXPIRING/
  // EXPIRED) + automatic renewal of Let's Encrypt certs with autoRenew=true
  // (Redis-locked: only one instance renews, never twice per cert).
  startCertRenewalScheduler();

  // v6.1: scheduled LDAP directory sync (per-domain syncIntervalMinutes,
  // default daily; Redis-locked so only one instance syncs a domain).
  startLdapSyncScheduler();

  // v8.1: Recover deleted items — hourly purge of expunge tombstones older than
  // DELETED_ITEM_RETENTION_DAYS (default 30; 0 = never). Redis-locked.
  startDeletedItemsPurger(getRedisClient() as unknown as PurgeRedis);

  // 9.4: mailbox access audit retention (ServerSettings.mailboxAccessAuditRetentionDays,
  // 0 = keep) — hourly purge of mailbox.foreign.* audit entries. Redis-locked.
  startMailboxAccessAuditPurger(getRedisClient() as unknown as AccessPurgeRedis);

  // 9.1: background backfill of Message References for older mail (IMAP THREAD /
  // threading); REFERENCES_BACKFILL=on (default) | off. Redis-locked.
  startReferencesBackfill(getRedisClient() as unknown as BackfillRedis);

  // 9.5: one-time backfill of the structured contact columns of contacts stored
  // before 9.5 (updatedAt / changeKey kept: no client-visible change). Redis-locked,
  // resumable, stops for good once a pass is complete.
  startContactBackfill(getRedisClient() as unknown as ContactBackfillRedis);
}

/**
 * Encrypts certificate and ACME account private keys still stored as plain PEM
 * (storage private-key-migration.ts; Redis-locked, idempotent). Logs counts only,
 * never key material.
 */
async function encryptStoredPrivateKeys(): Promise<void> {
  const r = await migratePrivateKeysAtRestLocked(getRedisClient() as unknown as PrivateKeyMigrationRedis);
  if (!r) return; // another instance holds the lock
  if (r.unreadable > 0) {
    log.error({ ...r }, 'Certificate private keys that cannot be decrypted with the configured key — re-upload or re-issue those certificates (docs/certificates.md)');
  } else if (r.encrypted > 0) {
    log.info({ ...r }, 'Stored certificate private keys encrypted at rest');
  }
}

/**
 * 9.3: startup reconciliation of the protocol TLS state (SMTP/IMAP/POP3) —
 * idempotent, logged (lib/protocol-cert-assign.ts). The certificate holding
 * the mail services in the BCP is the one the servers serve; a stale
 * ServerSettings.tlsCert / isActiveProtocol is repaired, an orphaned or
 * missing protocol cert falls back to the self-signed default for the public
 * host name, and a self-signed default for mail.localhost is regenerated for
 * the real host name. Replaces the pre-9.3 orphan check.
 */
async function syncProtocolCertState(): Promise<void> {
  try {
    // Redis-locked (cert:protocol:reconcile:lock): with several api-gateway
    // instances only one repairs — no duplicate self-signed rows; the others
    // skip silently (null).
    const r = await reconcileProtocolCertStateLocked();
    if (!r) return;
    if (r.action === 'consistent') log.debug({ certId: r.certId }, 'Protocol TLS cert state: consistent');
    else log.info({ action: r.action, certId: r.certId, notes: r.notes }, 'Protocol TLS cert state reconciled at startup');
  } catch (err) {
    log.error({ err }, 'Protocol TLS reconciliation failed');
  }
}

// v3.18.36: inline implementation of syncAutodiscoverUrls() extracted to lib/server-urls.ts
// (now syncServerUrlsFromHostname). Shared by domain-create / make-primary
// and settings-PUT.

start().catch((err) => { log.error({ err }, 'Startup failed'); process.exit(1); });
