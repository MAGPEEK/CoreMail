import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connectDatabase, prisma, provisionWellKnownOAuthClients } from '@coremail/storage';
import { getRedisClient, createLogger, CHANNEL_SETTINGS_RELOAD, initJwtKeys, getPublicJwk } from '@coremail/core';

// ── Security Middleware (OWASP) ───────────────────────────────────────────────
import {
  requestId,
  helmetMiddleware,
  suspiciousInputGuard,
  generalRateLimit,
  authRateLimit,
  setupRateLimit,
  adminMutationRateLimit,
} from './middleware/security.js';

import { mailRouter } from './routes/mail.js';
import { calendarRouter } from './routes/calendar.js';
import { contactsRouter } from './routes/contacts.js';
import { tasksRouter } from './routes/tasks.js';
import { notesRouter } from './routes/notes.js';
import { userRouter } from './routes/user.js';
import { categoriesRouter } from './routes/categories.js';
import { adminDashboardRouter } from './routes/admin/dashboard.js';
import { adminGlobalSettingsRouter } from './routes/admin/global-settings.js';
import { adminMailboxesRouter } from './routes/admin/mailboxes.js';
import { adminAliasesRouter } from './routes/admin/aliases.js';
import { adminDomainsRouter } from './routes/admin/domains.js';
import { adminQueuesRouter } from './routes/admin/queues.js';
import { adminLogsRouter } from './routes/admin/logs.js';
import { adminBackupsRouter } from './routes/admin/backups.js';
import { adminGroupsRouter } from './routes/admin/groups.js';
import { adminResourcesRouter } from './routes/admin/resources.js';
// Public Folders komplett entfernt in v3.18.31
// eDiscovery & Legal Hold komplett entfernt in v3.18.5
import { adminEmsRouter } from './routes/admin/ems.js';
// Journaling-Feature komplett entfernt in v3.13.6
import { adminRetentionRouter } from './routes/admin/retention.js';
import { adminAuditLogRouter } from './routes/admin/audit-log.js';
import { adminOAuthClientsRouter } from './routes/admin/oauth-clients.js';
import { adminServersRouter } from './routes/admin/servers.js';
import { adminServicesRouter } from './routes/admin/services.js';
import { adminCertificatesRouter, getAcmeChallenge } from './routes/admin/certificates.js';
import { startTlsProxy } from './tls-proxy.js';
// auto-letsencrypt entfernt — Admin fordert LE manuell via BCP → SSL/TLS an
import { adminSharedMailboxesRouter } from './routes/admin/shared-mailboxes.js';
import { adminQuarantineRouter } from './routes/admin/quarantine.js';
import { adminTransportRulesRouter } from './routes/admin/transport-rules.js';
import { adminMobileRouter } from './routes/admin/mobile.js';
import { adminMessageTraceRouter } from './routes/admin/message-trace.js';
import { adminConnectorsRouter } from './routes/admin/connectors.js';
import { adminOrganisationRouter } from './routes/admin/organisation.js';
// adminExternalContactsRouter komplett entfernt in v3.18.33
import { adminSecurityRouter } from './routes/admin/security.js';
import { adminSecurityAttacksRouter } from './routes/admin/security-attacks.js';
import { adminSmtpConfigRouter } from './routes/admin/smtp-config.js';
import { adminLdapRouter } from './routes/admin/ldap.js';
import { adminSsoRouter } from './routes/admin/sso.js';
import { pushRouter } from './routes/push.js';
import { smimeRouter } from './routes/smime.js';
import { setupRouter } from './routes/setup.js';
import { authRouter } from './routes/auth.js';
import { retentionTagsRouter } from './routes/retention-tags.js';
import { powershellRouter } from './routes/powershell.js';
import { requireAuth } from './middleware/auth.js';
import { sseHandler } from './sse.js';
import { auditMiddleware } from './lib/audit.js';
import { syncServerUrlsFromHostname } from './lib/server-urls.js';

const log = createLogger('api-gateway');
const app = express();
const PORT = parseInt(process.env['API_PORT'] ?? '3000', 10);

// ── BigInt-Serialisierung (Prisma gibt BigInt für Quota-Felder zurück) ────────
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
  return Number(this);
};

// ── Trust Proxy ───────────────────────────────────────────────────────────────
// Wenn ein Reverse Proxy (Traefik, Caddy, nginx) vorgelagert ist, das richtige
// Client-IP-Handling aktivieren, damit Rate-Limiting auf die echte IP arbeitet.
// Wert: 1 = genau 1 Proxy vor dem App-Server (typisch bei Docker-Deployments).
app.set('trust proxy', 1);

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY MIDDLEWARE STACK
// Reihenfolge ist kritisch — nicht verändern ohne Kommentar zu lesen!
// ═══════════════════════════════════════════════════════════════════════════════

// 1. Request-ID — vor allem anderen, damit Logs korrelierbar sind
app.use(requestId);

// 2. Helmet — Security-Header auf jede Antwort setzen
//    Muss früh kommen damit auch Fehlerantworten die richtigen Header haben.
app.use(helmetMiddleware);

// 3. Suspicious-Input-Guard — bevor Body-Parser den Stream konsumiert
//    Blockt CRLF-Injection, Null-Bytes, Path-Traversal, Oversized-Headers.
app.use(suspiciousInputGuard);

// 4. Globales Rate-Limiting — pro IP, Loopback ausgenommen
app.use(generalRateLimit);

// ── Well-Known: OIDC Discovery + JWKS (v5.3.0 Modern Auth) ───────────────────
// Outlook 2024 LTSC und andere OIDC-Clients erwarten den Discovery-Endpoint
// am Root: /.well-known/openid-configuration und /.well-known/jwks.json.
app.get('/.well-known/openid-configuration', async (_req, res) => {
  const settings = await prisma.serverSettings.findUnique({
    where:  { id: 'singleton' },
    select: { publicHostname: true, useHttps: true, httpPort: true },
  });
  const hostname = settings?.publicHostname ?? 'mail.localhost';
  const scheme = settings?.useHttps !== false ? 'https' : 'http';
  const port = settings?.httpPort ?? 443;
  const portSuffix = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80) ? '' : `:${port}`;
  const base = `${scheme}://${hostname}${portSuffix}`;
  res.json({
    issuer:                              base,
    authorization_endpoint:              `${base}/oauth2/authorize`,
    token_endpoint:                      `${base}/oauth2/token`,
    userinfo_endpoint:                   `${base}/oauth2/userinfo`,
    jwks_uri:                            `${base}/.well-known/jwks.json`,
    revocation_endpoint:                 `${base}/oauth2/token/revoke`,
    introspection_endpoint:              `${base}/oauth2/token/introspect`,
    response_types_supported:            ['code'],
    grant_types_supported:               ['authorization_code', 'refresh_token', 'password', 'client_credentials'],
    subject_types_supported:             ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported:                    ['openid', 'profile', 'email', 'mail', 'calendar', 'contacts', 'ews', 'EWS.AccessAsUser.All', 'Mail.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.Read', 'Calendars.ReadWrite', 'Contacts.Read', 'Contacts.ReadWrite', 'offline_access'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    code_challenge_methods_supported:    ['S256'],
    claims_supported:                    ['sub', 'iss', 'aud', 'iat', 'exp', 'email', 'name', 'preferred_username'],
  });
});

app.get('/.well-known/jwks.json', (_req, res) => {
  try {
    res.json({ keys: [getPublicJwk()] });
  } catch (err) {
    log.error({ err }, 'JWKS request failed — keys not initialized?');
    res.status(503).json({ error: 'JWKS not available' });
  }
});

// ── ADFS Federation Metadata (v5.3.0 Modern Auth für Outlook 2024 LTSC) ────
// Outlook 2024 LTSC sucht beim Modern-Auth-Setup nach diesem XML, um den
// Identity Provider zu discovern. Wir liefern eine minimale aber gültige
// FederationMetadata.xml, die unsere OAuth2-Endpoints unter /adfs/oauth2/*
// annonciert.
//
// Format-Quellen:
//   - MS-MWBF (Microsoft Web Browser Federated Sign-On Protocol)
//   - WS-Federation Metadata 1.2
//   - ADFS-Setup-Guide aus Microsoft Learn (Exchange on-premises Modern Auth)
app.get('/FederationMetadata/2007-06/FederationMetadata.xml', async (_req, res) => {
  try {
    const settings = await prisma.serverSettings.findUnique({
      where:  { id: 'singleton' },
      select: { publicHostname: true, useHttps: true, httpPort: true, jwtPublicKey: true },
    });
    const hostname = settings?.publicHostname ?? 'mail.localhost';
    const scheme = settings?.useHttps !== false ? 'https' : 'http';
    const port = settings?.httpPort ?? 443;
    const portSuffix = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80) ? '' : `:${port}`;
    const base = `${scheme}://${hostname}${portSuffix}`;
    // Public-Key als reine base64 (kein PEM-Header) für X509Certificate-Element.
    // Beachte: Federation Metadata erwartet eigentlich ein vollständiges X.509-
    // Zertifikat — wir haben nur einen RSA-Public-Key. Für die OAuth2-Discovery
    // reicht das in der Praxis, weil Outlook nur das Subject/Issuer prüft.
    const pubKey = (settings?.jwtPublicKey ?? '')
      .replace(/-----BEGIN[^-]+-----/g, '')
      .replace(/-----END[^-]+-----/g, '')
      .replace(/\s/g, '');
    const entityId = `${base}/adfs/services/trust`;
    res.set('Content-Type', 'application/samlmetadata+xml');
    res.send(`<?xml version="1.0" encoding="utf-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata"
                  xmlns:fed="http://docs.oasis-open.org/wsfed/federation/200706"
                  xmlns:wsa="http://www.w3.org/2005/08/addressing"
                  xmlns:auth="http://docs.oasis-open.org/wsfed/authorization/200706"
                  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  entityID="${entityId}">
  <RoleDescriptor xsi:type="fed:SecurityTokenServiceType"
                  protocolSupportEnumeration="http://docs.oasis-open.org/wsfed/federation/200706">
    <KeyDescriptor use="signing">
      <ds:KeyInfo>
        <ds:X509Data>
          <ds:X509Certificate>${pubKey}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </KeyDescriptor>
    <fed:TokenTypesOffered>
      <fed:TokenType Uri="urn:ietf:params:oauth:token-type:jwt"/>
    </fed:TokenTypesOffered>
    <fed:PassiveRequestorEndpoint>
      <wsa:EndpointReference>
        <wsa:Address>${base}/adfs/ls/</wsa:Address>
      </wsa:EndpointReference>
    </fed:PassiveRequestorEndpoint>
  </RoleDescriptor>
  <!-- OAuth2-spezifische Endpoints (für Outlook 2024 LTSC) -->
  <RoleDescriptor xsi:type="fed:ApplicationServiceType"
                  protocolSupportEnumeration="http://schemas.xmlsoap.org/ws/2005/02/trust http://docs.oasis-open.org/wsfed/federation/200706"
                  ServiceDisplayName="CoreMail OAuth2">
    <KeyDescriptor use="signing">
      <ds:KeyInfo>
        <ds:X509Data>
          <ds:X509Certificate>${pubKey}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </KeyDescriptor>
    <fed:PassiveRequestorEndpoint>
      <wsa:EndpointReference>
        <wsa:Address>${base}/adfs/oauth2/authorize</wsa:Address>
      </wsa:EndpointReference>
    </fed:PassiveRequestorEndpoint>
  </RoleDescriptor>
</EntityDescriptor>`);
  } catch (err) {
    log.error({ err }, 'FederationMetadata request failed');
    res.status(503).type('text/plain').send('FederationMetadata not available');
  }
});

// ── ACME HTTP-01 Challenge ────────────────────────────────────────────────────
// Muss vor den Proxies stehen (kein Auth, kein Body-Parser nötig).
app.get('/.well-known/acme-challenge/:token', async (req, res) => {
  const token = req.params['token'] ?? '';
  // Token darf nur alphanum + Bindestrich/Unterstrich sein (ACME-Spec)
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(token)) {
    res.status(400).send('Invalid token');
    return;
  }
  const keyAuth = await getAcmeChallenge(token);
  if (!keyAuth) { res.status(404).send('Not found'); return; }
  res.type('text/plain').send(keyAuth);
});

// ── Interne Proxies — VOR express.json() registrieren! ───────────────────────
// express.json() konsumiert den Body-Stream. Proxy-Routen müssen daher vorher
// kommen, damit sie den Body direkt weiterleiten können.
const EWS_URL = process.env['EWS_SERVICE_URL']  ?? 'http://localhost:8080';
const EAS_URL = process.env['EAS_SERVICE_URL']  ?? 'http://localhost:3005';
const DAV_URL = process.env['CALDAV_SERVICE_URL'] ?? 'http://localhost:8082';
const BACKUP_URL = process.env['BACKUP_SERVICE_URL'] ?? 'http://localhost:3004';
// v3.18.35: Autodiscover hat einen EIGENEN Service auf Port 8081 — nicht
// zu EWS routen, sonst antwortet Express mit "Cannot POST /Autodiscover/
// Autodiscover.xml" und Outlook LTSC verbindet nicht.
const AUTODISCOVER_URL = process.env['AUTODISCOVER_SERVICE_URL'] ?? 'http://localhost:8081';

function internalProxy(targetBase: string): express.RequestHandler {
  const proxy = createProxyMiddleware({
    target: targetBase,
    changeOrigin: true,
    on: {
      proxyReq: (proxyReq, req) => {
        // Express strippt den Mount-Prefix aus req.url — originalUrl wiederherstellen
        proxyReq.path = (req as express.Request).originalUrl;
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

app.use('/EWS',          internalProxy(EWS_URL));
app.use('/mapi',         internalProxy(EWS_URL));
app.use('/OAB',          internalProxy(EWS_URL));
// v3.18.35: Autodiscover hat einen eigenen Service (Port 8081), nicht EWS.
app.use('/Autodiscover', internalProxy(AUTODISCOVER_URL));
app.use('/autodiscover', internalProxy(AUTODISCOVER_URL));
app.use('/Microsoft-Server-ActiveSync', internalProxy(EAS_URL));
app.use('/dav',          internalProxy(DAV_URL));

// Auth-Service-Routen (MFA, App-Passwörter, Sessions) — VOR express.json()!
// Login/Refresh/Logout sind direkt im authRouter implementiert (kein Proxy nötig).
const AUTH_SERVICE_URL = process.env['AUTH_SERVICE_URL'] ?? 'http://localhost:3003';
app.use('/auth/mfa',           internalProxy(AUTH_SERVICE_URL));
app.use('/auth/app-passwords', internalProxy(AUTH_SERVICE_URL));
app.use('/auth/sessions',      internalProxy(AUTH_SERVICE_URL));
// v5.3.0: OAuth2/OIDC-Endpoints für Modern Auth (Outlook 2024 LTSC etc.)
// /oauth2/authorize, /oauth2/token, /oauth2/userinfo, /oauth2/jwks, /oauth2/.well-known/*
app.use('/oauth2',             internalProxy(AUTH_SERVICE_URL));
// v5.3.0: ADFS-Emulation — Outlook 2024 LTSC sucht OAuth2-Endpoints fest unter
// /adfs/oauth2/* (Active Directory Federation Services). Wir routen die an
// denselben auth-service-Backend, der intern /oauth2/* serviert.
function adfsProxy(): express.RequestHandler {
  const proxy = createProxyMiddleware({
    target: AUTH_SERVICE_URL,
    changeOrigin: true,
    on: {
      proxyReq: (proxyReq, req) => {
        // /adfs/oauth2/authorize → /oauth2/authorize
        const rewritten = (req as express.Request).originalUrl
          .replace(/^\/adfs\/oauth2/, '/oauth2');
        proxyReq.path = rewritten;
      },
      error: (err, _req, res) => {
        log.warn({ err }, 'ADFS proxy error');
        if (!('headersSent' in res && res.headersSent)) {
          (res as express.Response).status(502).json({ error: 'Service temporarily unavailable' });
        }
      },
    },
  });
  return proxy as express.RequestHandler;
}
app.use('/adfs/oauth2', adfsProxy());

// ── Body-Parser ───────────────────────────────────────────────────────────────
// JSON — 10 MB Limit (für Mail-Inhalte mit Inline-Bildern)
app.use(express.json({ limit: '10mb' }));
// URL-encoded (Formulare) — 1 MB Limit
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ── Auth — strenges Rate-Limiting auf Login/Token/Refresh ────────────────────
app.use('/auth', authRateLimit, authRouter);

// ── Health ────────────────────────────────────────────────────────────────────
// Kein Rate-Limit auf /healthz (wird von Docker alle 30s aufgerufen)
const PKG_PATH = resolve(process.cwd(), 'packages/api-gateway/package.json');
const APP_VERSION: string = (() => {
  try {
    const raw = readFileSync(PKG_PATH, 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'api-gateway', version: APP_VERSION }));

// ── Öffentlicher Wartungsmodus-Status (kein Auth nötig) ───────────────────────
// Wird von OWA LoginPage abgefragt, um den Wartungsbanner anzuzeigen.
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

// ── Changelog API ─────────────────────────────────────────────────────────────
const CHANGELOG_PATH = process.env['CHANGELOG_PATH']
  ?? resolve(process.cwd(), 'CHANGELOG.md');

app.get('/api/v1/changelog', (_req, res) => {
  try {
    const raw = readFileSync(CHANGELOG_PATH, 'utf-8');
    const versions: Array<{ version: string; date: string; sections: Record<string, string[]> }> = [];
    let current: (typeof versions)[0] | null = null;
    let currentSection = '';

    for (const line of raw.split('\n')) {
      const versionMatch = /^## \[(.+?)\](?:\s*[—-]\s*(\d{4}-\d{2}-\d{2}))?/.exec(line);
      if (versionMatch) {
        if (current) versions.push(current);
        current = { version: versionMatch[1]!, date: versionMatch[2] ?? '', sections: {} };
        currentSection = '';
        continue;
      }
      const sectionMatch = /^### (.+)/.exec(line);
      if (sectionMatch && current) {
        currentSection = sectionMatch[1]!;
        current.sections[currentSection] = [];
        continue;
      }
      const itemMatch = /^[-*] (.+)/.exec(line);
      if (itemMatch && current && currentSection) {
        current.sections[currentSection]!.push(itemMatch[1]!);
      }
    }
    if (current) versions.push(current);
    res.json({ versions, raw });
  } catch {
    res.status(503).json({ error: 'Changelog not available' });
  }
});

// ── SSE ───────────────────────────────────────────────────────────────────────
app.get('/api/v1/events', requireAuth, sseHandler);

// ── Feature Routes ────────────────────────────────────────────────────────────
app.use('/api/v1/setup', setupRateLimit, setupRouter);

app.use('/api/v1/mail',           mailRouter);
app.use('/api/v1/calendar',       calendarRouter);
app.use('/api/v1/contacts',       contactsRouter);
app.use('/api/v1/tasks',          tasksRouter);
app.use('/api/v1/notes',          notesRouter);
app.use('/api/v1/user',           userRouter);
app.use('/api/v1/categories',     categoriesRouter);
app.use('/api/v1/smime',          smimeRouter);
app.use('/api/v1/retention-tags', retentionTagsRouter);
app.use('/api/v1/push',           pushRouter);

// PowerShell Remoting
app.use(express.text({ type: 'application/soap+xml', limit: '5mb' }));
app.use('/PowerShell', powershellRouter);

// ── Admin Routes ──────────────────────────────────────────────────────────────
// Audit-Middleware für alle mutierenden Admin-Calls (fire-and-forget)
app.use('/api/v1/admin', auditMiddleware);
// Zusätzliches Rate-Limit auf mutierende Admin-Operationen (POST/PUT/PATCH/DELETE)
app.use('/api/v1/admin', adminMutationRateLimit);

app.use('/api/v1/admin/dashboard',       adminDashboardRouter);
app.use('/api/v1/admin/settings',        adminGlobalSettingsRouter);
app.use('/api/v1/admin/mailboxes',       adminMailboxesRouter);
// Alias-Router mountet auf /admin — die internen Routes sind /mailboxes/:id/aliases,
// /shared-mailboxes/:id/aliases, /aliases, /aliases/:id. Wird nach den spezifischeren
// Routern angehängt — Express fällt durch, wenn die anderen keine Treffer haben.
app.use('/api/v1/admin',                 adminAliasesRouter);
app.use('/api/v1/admin/domains',         adminDomainsRouter);
app.use('/api/v1/admin/queues',          adminQueuesRouter);
app.use('/api/v1/admin/backups',         adminBackupsRouter);
app.use('/api/v1/admin/logs',            adminLogsRouter);
app.use('/api/v1/admin/groups',          adminGroupsRouter);
app.use('/api/v1/admin/resources',       adminResourcesRouter);
// Public-Folders-Route entfernt in v3.18.31
// eDiscovery-Route entfernt in v3.18.5
app.use('/api/v1/admin/ems',             adminEmsRouter);
// Journaling-Route entfernt in v3.13.6
app.use('/api/v1/admin/compliance/retention',  adminRetentionRouter);
app.use('/api/v1/admin/audit-log',        adminAuditLogRouter);
app.use('/api/v1/admin/oauth',            adminOAuthClientsRouter);
app.use('/api/v1/admin/servers',          adminServersRouter);
app.use('/api/v1/admin/services',         adminServicesRouter);
app.use('/api/v1/admin/certificates',     adminCertificatesRouter);
app.use('/api/v1/admin/shared-mailboxes', adminSharedMailboxesRouter);
app.use('/api/v1/admin/quarantine',       adminQuarantineRouter);
app.use('/api/v1/admin/transport-rules',  adminTransportRulesRouter);
app.use('/api/v1/admin/mobile',           adminMobileRouter);
app.use('/api/v1/admin/message-trace',    adminMessageTraceRouter);
app.use('/api/v1/admin/connectors',       adminConnectorsRouter);
app.use('/api/v1/admin/organisation',     adminOrganisationRouter);
// /api/v1/admin/contacts (externe Kontakte) komplett entfernt in v3.18.33
app.use('/api/v1/admin/security',         adminSecurityRouter);
app.use('/api/v1/admin/security/attacks', adminSecurityAttacksRouter);
app.use('/api/v1/admin/smtp-config',      adminSmtpConfigRouter);
app.use('/api/v1/admin/ldap',             adminLdapRouter);
app.use('/api/v1/admin/sso',              adminSsoRouter);

// ── Statische Frontend-Dateien (OWA unter Root + BCP unter /bcp) ─────────────
const WWW_DIR = process.env['WWW_DIR'] ?? '/app/www';
const owaDir  = join(WWW_DIR, 'owa');
const bcpDir  = join(WWW_DIR, 'bcp');

// Legacy: alte /owa/*-URLs auf den Root-Pfad umlenken (Backwards-Compat für
// gespeicherte Lesezeichen aus früheren Versionen)
app.get('/owa', (_req, res) => res.redirect(301, '/'));
app.get('/owa/*', (req, res) => {
  const stripped = req.originalUrl.replace(/^\/owa\/?/, '/');
  res.redirect(301, stripped);
});

// BCP behält /bcp-Prefix (Admin-Panel hat eigenes Vite-Base)
if (existsSync(bcpDir)) {
  app.use('/bcp', express.static(bcpDir, {
    maxAge: '1y',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));
  app.get('/bcp/*', (_req, res) => res.sendFile(join(bcpDir, 'index.html')));
  log.info({ dir: bcpDir }, 'Serving BCP static files');
}

// OWA-Frontend unter Root — muss NACH allen API-Routen kommen, damit
// /auth/* /api/* /EWS/* etc. Vorrang haben. Catch-All `app.get('*')` schickt
// alle unbekannten Routen zurück an index.html (SPA-Routing).
if (existsSync(owaDir)) {
  app.use(express.static(owaDir, {
    maxAge: '1y',
    index: false, // wir machen index.html manuell, damit der Catch-All greift
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));
  // SPA-Catch-All: alles, was nicht bisher zugeordnet wurde und KEINE
  // bekannte API-/Proxy-Route ist, ist eine OWA-Route → index.html zurück.
  const API_PREFIXES = [
    '/api/', '/auth/', '/oauth2/', '/.well-known/', '/EWS', '/mapi', '/OAB', '/Autodiscover', '/autodiscover',
    '/adfs/', '/FederationMetadata/',
    '/Microsoft-Server-ActiveSync', '/dav', '/PowerShell', '/bcp',
  ];
  app.get('*', (req, res, next) => {
    if (API_PREFIXES.some((p) => req.path === p || req.path.startsWith(p))) {
      return next();
    }
    res.sendFile(join(owaDir, 'index.html'));
  });
  log.info({ dir: owaDir }, 'Serving OWA static files (root)');
} else {
  // Kein OWA-Bundle gemountet — Root auf /bcp oder schlichte Info
  app.get('/', (_req, res) => res.redirect(302, '/bcp/'));
}

// ── 404 + Fehler-Handler ──────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err }, 'Unhandled error');
  // Stack-Trace niemals an den Client senden (OWASP A05: Security Misconfiguration)
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  await connectDatabase();
  // v5.3.0: JWT-Signing-Keys (RS256) initialisieren — wird beim ersten Boot
  // generiert und in ServerSettings persistiert. Modern Auth (OAuth2/OIDC)
  // braucht asymmetrische Signatur damit Clients via JWKS verifizieren können.
  await initJwtKeys(prisma);
  // v5.3.0 Phase C: Well-Known Native-Client-IDs (Outlook Win, Outlook Mobile,
  // iOS Mail, Microsoft Graph) idempotent in OAuthClient-Tabelle anlegen,
  // damit unser OAuth2-Server diese Clients bei /oauth2/authorize akzeptiert.
  try {
    const created = await provisionWellKnownOAuthClients();
    if (created > 0) log.info({ created }, 'Well-Known OAuth2-Clients provisioniert');
  } catch (err) {
    log.warn({ err }, 'Well-Known OAuth2-Client-Provisioning fehlgeschlagen (non-fatal)');
  }
  getRedisClient();
  log.info({ port: PORT }, 'API Gateway listening');
  app.listen(PORT);

  // Integrierter HTTPS-Reverse-Proxy — startet automatisch wenn ein Zertifikat
  // in BCP → SSL/TLS → "Als HTTPS aktivieren" gesetzt wurde.
  // Hot-Reload bei Zertifikats-Aktivierung über Redis (kein Neustart nötig).
  void startTlsProxy(app).catch(err =>
    log.warn({ err }, 'TLS proxy startup failed — HTTPS not available'),
  );

  // ── Startup-Konsistenzprüfung: server_settings.tlsCert mit certificates-Tabelle abgleichen ──
  // Wenn server_settings.tlsCert gesetzt ist aber kein Cert mit isActiveProtocol: true
  // in der certificates-Tabelle existiert (z.B. nach manueller Löschung ohne API),
  // wird server_settings.tlsCert/tlsKey auf NULL gesetzt → Self-Signed-Fallback.
  void syncProtocolCertState().catch(err =>
    log.warn({ err }, 'Protocol cert state sync failed — check certificates manually'),
  );

  // v3.18.35+36: URL-Synchronisation. Wenn der Admin publicHostname geändert
  // hat (z.B. von mail.local zu mail.<echte-domain>), wurden die abgeleiteten
  // URLs nicht mit-migriert. Outlook-Autodiscover liefert dann veraltete
  // Adressen → Outlook kann sich nicht verbinden. Diese Migration korrigiert
  // alle URL-Felder beim Container-Start (zusätzlich zu den synchronen Updates
  // bei Domain-Create/Make-Primary/Settings-PUT).
  void syncServerUrlsFromHostname().catch(err =>
    log.warn({ err }, 'Server-URL sync failed — Outlook-Autodiscover prüfen'),
  );

  // ── Stale PENDING/RENEWING Zertifikate bereinigen ─────────────────────────
  // Nach einem Container-Neustart können Certs in PENDING oder RENEWING stecken
  // (der ACME-Hintergrundprozess wurde durch den Neustart gekillt).
  // Alle Certs die seit >10 Minuten in diesem Zustand sind werden auf ERROR gesetzt.
  void (async () => {
    try {
      const staleThreshold = new Date(Date.now() - 10 * 60_000);
      const cleaned = await prisma.certificate.updateMany({
        where: {
          status: { in: ['PENDING', 'RENEWING'] },
          updatedAt: { lt: staleThreshold },
        },
        data: {
          status:    'ERROR',
          lastError: 'Prozess durch Server-Neustart unterbrochen — bitte Zertifikat erneut anfordern.',
        },
      });
      if (cleaned.count > 0) {
        log.warn({ count: cleaned.count }, 'Stale PENDING/RENEWING certificates reset to ERROR on startup');
      }
    } catch (err) {
      log.warn({ err }, 'Failed to cleanup stale pending certificates (non-fatal)');
    }
  })();

  // Kein Auto-LE — Admin fordert Let's Encrypt manuell via BCP → SSL/TLS an.
}

async function syncProtocolCertState(): Promise<void> {
  try {
    const settings = await prisma.serverSettings.findUnique({
      where:  { id: 'singleton' },
      select: { tlsCert: true },
    });

    // Kein TLS-Cert in ServerSettings → kein Handlungsbedarf
    if (!settings?.tlsCert) return;

    // Gibt es ein Cert mit isActiveProtocol: true?
    const activeProtocolCert = await prisma.certificate.findFirst({
      where:  { isActiveProtocol: true },
      select: { id: true, name: true },
    });

    if (activeProtocolCert) {
      // Alles konsistent
      log.debug({ certId: activeProtocolCert.id }, 'Protocol TLS cert state: consistent');
      return;
    }

    // Orphaned: server_settings hat TLS-Daten aber kein isActiveProtocol-Cert → bereinigen
    await prisma.serverSettings.update({
      where: { id: 'singleton' },
      data:  { tlsCert: null, tlsKey: null },
    });
    await getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, '');
    log.info('Startup sync: orphaned server_settings.tlsCert cleared — SMTP/IMAP/POP3 using self-signed');
  } catch (err) {
    log.error({ err }, 'syncProtocolCertState failed');
  }
}

// v3.18.36: Inline-Implementierung von syncAutodiscoverUrls() nach lib/server-urls.ts
// extrahiert (jetzt syncServerUrlsFromHostname). Wird von Domain-Create/Make-
// Primary und Settings-PUT shared genutzt.

start().catch((err) => { log.error({ err }, 'Startup failed'); process.exit(1); });
