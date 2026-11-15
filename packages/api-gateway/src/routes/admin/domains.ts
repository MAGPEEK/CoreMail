/**
 * Admin API: domain management
 *
 * GET    /api/v1/admin/domains                    — all domains (filtered, paginated)
 * GET    /api/v1/admin/domains/:id                — single domain
 * POST   /api/v1/admin/domains                    — create new domain (DKIM auto-generated)
 * PUT    /api/v1/admin/domains/:id                — edit domain (name, active, dkimSelector)
 * PATCH  /api/v1/admin/domains/:id/toggle         — toggle active
 * POST   /api/v1/admin/domains/:id/make-primary   — set primary domain
 * DELETE /api/v1/admin/domains/:id                — delete domain
 * GET    /api/v1/admin/domains/:id/dkim-record    — DNS TXT record for DKIM
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { promises as dnsPromises } from 'node:dns';
import { prisma } from '@coremail/storage';
import { requireArea } from '../../middleware/auth.js';
import { createLogger } from '@coremail/core';
import { syncFromPrimaryDomain } from '../../lib/server-urls.js';
import { dkimDnsRecord, generateDkimPrivateKey, needsDkimKey } from '../../lib/dkim.js';

const log = createLogger('admin:domains');
export const adminDomainsRouter: RouterType = Router();
adminDomainsRouter.use(requireArea('domains'));

const SELECT = {
  id: true, name: true, active: true, primary: true,
  dkimSelector: true, createdAt: true,
  _count: { select: { users: true } },
} as const;

// ── GET / ─────────────────────────────────────────────────────────────────────
adminDomainsRouter.get('/', async (req: Request, res: Response) => {
  const search = String(req.query['search'] ?? '').trim();
  const page   = Math.max(1, parseInt(String(req.query['page']  ?? '1'),  10));
  const limit  = Math.min(200, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10)));
  const skip   = (page - 1) * limit;

  const where = search ? { name: { contains: search, mode: 'insensitive' as const } } : {};

  const [domains, total] = await Promise.all([
    prisma.domain.findMany({ where, select: SELECT, orderBy: [{ primary: 'desc' }, { name: 'asc' }], skip, take: limit }),
    prisma.domain.count({ where }),
  ]);
  res.json({ domains, total, page, limit });
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
adminDomainsRouter.get('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const domain = await prisma.domain.findUnique({ where: { id }, select: SELECT });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }
  res.json(domain);
});

// ── POST / ────────────────────────────────────────────────────────────────────
adminDomainsRouter.post('/', async (req: Request, res: Response) => {
  const schema = z.object({
    name:         z.string().min(3).max(253),
    dkimSelector: z.string().default('coremail'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  const existing = await prisma.domain.findUnique({ where: { name: parsed.data.name } });
  if (existing) { res.status(409).json({ error: 'Domain already exists' }); return; }

  // Generate DKIM key pair automatically
  const privateKey = generateDkimPrivateKey();

  // The first domain automatically becomes primary
  const isPrimary = (await prisma.domain.count()) === 0;

  const domain = await prisma.domain.create({
    data: {
      name:          parsed.data.name,
      dkimSelector:  parsed.data.dkimSelector,
      dkimPrivateKey: privateKey,
      primary:       isPrimary,
    },
    select: SELECT,
  });
  log.info({ name: parsed.data.name, primary: isPrimary }, 'Domain created');

  // v3.18.36: if this is the FIRST domain (= automatically primary), derive
  // publicHostname + all derived URLs (OWA/EAS/Autodiscover base)
  // automatically. Guards against the old bug: the schema default was
  // `mail.local:8080`, which made Outlook Autodiscover unusable for 1000+
  // users because the URLs were not visible anywhere.
  if (isPrimary) {
    await syncFromPrimaryDomain(parsed.data.name).catch((err: unknown) =>
      log.warn({ err, domain: parsed.data.name }, 'Auto-derive of server URLs failed'),
    );
  }

  res.status(201).json(domain);
});

// ── PUT /:id ──────────────────────────────────────────────────────────────────
adminDomainsRouter.put('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const schema = z.object({
    name:         z.string().min(3).max(253).optional(),
    active:       z.boolean().optional(),
    dkimSelector: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const domain = await prisma.domain.findUnique({ where: { id } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }

  // v6: duplicate rename → 409 (was an unhandled P2002 crash)
  if (parsed.data.name !== undefined && parsed.data.name !== domain.name) {
    const clash = await prisma.domain.findUnique({ where: { name: parsed.data.name }, select: { id: true } });
    if (clash) { res.status(409).json({ error: 'Domain already exists' }); return; }
  }

  const updated = await prisma.domain.update({
    where: { id },
    data: {
      ...(parsed.data.name         !== undefined ? { name: parsed.data.name }               : {}),
      ...(parsed.data.active       !== undefined ? { active: parsed.data.active }           : {}),
      ...(parsed.data.dkimSelector !== undefined ? { dkimSelector: parsed.data.dkimSelector } : {}),
    },
    select: SELECT,
  });
  log.info({ id }, 'Domain updated');
  res.json(updated);
});

// ── PATCH /:id/toggle ─────────────────────────────────────────────────────────
adminDomainsRouter.patch('/:id/toggle', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const domain = await prisma.domain.findUnique({ where: { id } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }
  const updated = await prisma.domain.update({
    where: { id },
    data:  { active: !domain.active },
    select: SELECT,
  });
  log.info({ id, active: updated.active }, 'Domain toggled');
  res.json(updated);
});

// ── POST /:id/make-primary ────────────────────────────────────────────────────
adminDomainsRouter.post('/:id/make-primary', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const domain = await prisma.domain.findUnique({ where: { id } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }

  // Mark all other domains as non-primary, this one as primary
  await prisma.$transaction([
    prisma.domain.updateMany({ where: { primary: true  }, data: { primary: false } }),
    prisma.domain.update({ where: { id }, data: { primary: true } }),
  ]);
  log.info({ id, name: domain.name }, 'Domain set as primary');

  // v3.18.36: if publicHostname is still the default, adapt it to the new
  // primary domain. If the admin has already set their own hostname, it is
  // kept — but we sync the URLs (in case only publicHostname was changed
  // without deriving the URLs).
  await syncFromPrimaryDomain(domain.name).catch((err: unknown) =>
    log.warn({ err, domain: domain.name }, 'Auto-derive of server URLs failed'),
  );

  const domains = await prisma.domain.findMany({
    select: SELECT,
    orderBy: [{ primary: 'desc' }, { name: 'asc' }],
  });
  res.json(domains);
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
adminDomainsRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const domain = await prisma.domain.findUnique({ where: { id } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }
  if (domain.primary) { res.status(409).json({ error: 'Primary domain cannot be deleted' }); return; }
  // v6: every FK with onDelete Restrict is checked up front (shared/resource
  // mailboxes used to crash the service with an unhandled Prisma P2003).
  const [userCount, sharedCount, resourceCount, ldapCount, oidcCount] = await Promise.all([
    prisma.user.count({ where: { domainId: id } }),
    prisma.sharedMailbox.count({ where: { domainId: id } }),
    prisma.resourceMailbox.count({ where: { domainId: id } }),
    prisma.ldapConfig.count({ where: { domainId: id } }),
    prisma.oidcProvider.count({ where: { domainId: id } }),
  ]);
  if (userCount > 0) { res.status(409).json({ error: 'Domain has active mailboxes' }); return; }
  if (sharedCount > 0) { res.status(409).json({ error: 'Domain has shared mailboxes' }); return; }
  if (resourceCount > 0) { res.status(409).json({ error: 'Domain has resource mailboxes' }); return; }
  if (ldapCount > 0 || oidcCount > 0) {
    res.status(409).json({ error: 'Domain has an LDAP or SSO configuration — remove it first' }); return;
  }
  await prisma.domain.delete({ where: { id } });
  log.info({ id, name: domain.name }, 'Domain deleted');
  res.json({ ok: true });
});

// ── Helper: ensure DKIM key (auto-generate if empty) ──────────────────────────
async function ensureDkimKey(id: string): Promise<typeof import('@coremail/storage').prisma.domain extends never ? never : Awaited<ReturnType<typeof prisma.domain.findUnique>> & { dkimPrivateKey: string }> {
  let domain = await prisma.domain.findUnique({ where: { id } });
  if (!domain) return null as never;

  if (needsDkimKey(domain.dkimPrivateKey)) {
    // No key present (domains created before v5.9.x) — generate and store an RSA-2048 pair
    domain = await prisma.domain.update({
      where: { id },
      data:  { dkimPrivateKey: generateDkimPrivateKey() },
    });
    log.info({ id, name: domain.name }, 'DKIM private key auto-generated (was empty)');
  }

  return domain as typeof domain & { dkimPrivateKey: string };
}

// ── GET /:id/dkim-record ──────────────────────────────────────────────────────
adminDomainsRouter.get('/:id/dkim-record', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const domain = await ensureDkimKey(id);
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }

  try {
    const { createPublicKey } = await import('crypto');
    const pubKey    = createPublicKey(domain.dkimPrivateKey);
    const pubKeyDer = pubKey.export({ type: 'pkcs1', format: 'der' });
    const pubKeyB64 = (pubKeyDer as Buffer).toString('base64');

    res.json({
      selector: domain.dkimSelector,
      dnsName:  `${domain.dkimSelector}._domainkey.${domain.name}`,
      dnsValue: `v=DKIM1; k=rsa; p=${pubKeyB64}`,
    });
  } catch (err) {
    log.error({ err, id }, 'DKIM public key derivation failed');
    res.status(500).json({ error: 'DKIM key invalid — please regenerate', code: 'DKIM_KEY_INVALID' });
  }
});

// ── POST /:id/regenerate-dkim ─────────────────────────────────────────────────
adminDomainsRouter.post('/:id/regenerate-dkim', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const domain = await prisma.domain.findUnique({ where: { id } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }

  const privateKey = generateDkimPrivateKey();
  await prisma.domain.update({ where: { id }, data: { dkimPrivateKey: privateKey } });

  log.info({ id, name: domain.name }, 'DKIM key pair regenerated');
  res.json(dkimDnsRecord(privateKey, domain.dkimSelector, domain.name));
});

// ── DNS resolver (injectable for tests) ──────────────────────────────────────
export interface DnsResolverLike {
  resolve4(name: string): Promise<string[]>;
  resolveMx(name: string): Promise<{ priority: number; exchange: string }[]>;
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
  resolveSrv(name: string): Promise<{ priority: number; weight: number; port: number; name: string }[]>;
  reverse(ip: string): Promise<string[]>;
}
let dnsResolver: DnsResolverLike = dnsPromises;
/** Test seam: replace the resolver used by the dns-check (null restores node:dns). */
export function setDnsResolverForTests(r: DnsResolverLike | null): void {
  dnsResolver = r ?? dnsPromises;
}

// ── Client auto-setup records (v8.1) ─────────────────────────────────────────
// RFC 6186 / RFC 8314 SRV records for mail clients, RFC 6764 SRV + TXT for CalDAV/
// CardDAV, Outlook's _autodiscover._tcp SRV and the Thunderbird autoconfig host.
// All of them are RECOMMENDED: missing → shown yellow in the BCP, never red, and not
// counted with the required records (VISIBLE_DNS_KEYS in the BCP).
export interface ClientSetupRecord {
  type: 'SRV' | 'TXT' | 'CNAME';
  /** Name relative to the domain (as DNS providers expect it). */
  name: string;
  expected: string;
  ok: boolean;
  found: string | null;
  warning?: string;
  recommended: true;
}

const norm = (h: string): string => h.trim().toLowerCase().replace(/\.$/, '');

export async function checkClientSetupRecords(
  dns: Pick<DnsResolverLike, 'resolveSrv' | 'resolveTxt' | 'resolveCname' | 'resolve4'>,
  domainName: string, hostname: string, httpsPort = 443,
): Promise<Record<string, ClientSetupRecord>> {
  const target = norm(hostname);

  async function srv(service: string, port: number, priority = 0, weight = 1): Promise<ClientSetupRecord> {
    const expected = `${priority} ${weight} ${port} ${target}.`;
    const base = { type: 'SRV' as const, name: `${service}._tcp`, expected, recommended: true as const };
    let recs: { priority: number; weight: number; port: number; name: string }[];
    try {
      recs = await dns.resolveSrv(`${service}._tcp.${domainName}`);
    } catch {
      return { ...base, ok: false, found: null };
    }
    if (!recs.length) return { ...base, ok: false, found: null };
    const found = recs.map((r) => `${r.priority} ${r.weight} ${r.port} ${norm(r.name) || '.'}.`).join(', ');
    // "." target = service explicitly not offered (RFC 2782)
    const ok = recs.some((r) => r.port === port && norm(r.name) === target);
    return ok
      ? { ...base, ok, found }
      : { ...base, ok, found, warning: `SRV record exists but does not point to ${target}:${port}` };
  }

  async function davPath(service: string): Promise<ClientSetupRecord> {
    const base = { type: 'TXT' as const, name: `${service}._tcp`, expected: 'path=/dav/', recommended: true as const };
    try {
      const flat = (await dns.resolveTxt(`${service}._tcp.${domainName}`)).map((c) => c.join(''));
      const path = flat.find((s) => s.startsWith('path='));
      if (!path) return { ...base, ok: false, found: null };
      const ok = /^path=\/dav\/?$/.test(path);
      return ok ? { ...base, ok, found: path } : { ...base, ok, found: path, warning: 'TXT path does not point to /dav/' };
    } catch {
      return { ...base, ok: false, found: null };
    }
  }

  async function autoconfigHost(): Promise<ClientSetupRecord> {
    const base = { type: 'CNAME' as const, name: 'autoconfig', expected: target, recommended: true as const };
    try {
      const cnames = await dns.resolveCname(`autoconfig.${domainName}`);
      const c = cnames[0] ? norm(cnames[0]) : null;
      if (!c) return { ...base, ok: false, found: null };
      return c === target ? { ...base, ok: true, found: c } : { ...base, ok: false, found: c, warning: `CNAME points to ${c}, expected ${target}` };
    } catch {
      // an A record pointing at the server is fine as well
      try {
        const [as, server] = await Promise.all([
          dns.resolve4(`autoconfig.${domainName}`),
          dns.resolve4(target).catch(() => [] as string[]),
        ]);
        if (!as.length) return { ...base, ok: false, found: null };
        const ok = server.length === 0 || as.some((ip) => server.includes(ip));
        return ok
          ? { ...base, ok: true, found: as.join(', ') }
          : { ...base, ok: false, found: as.join(', '), warning: `A record does not match ${target} (${server.join(', ')})` };
      } catch {
        return { ...base, ok: false, found: null };
      }
    }
  }

  const [submissions, submission, imaps, imap, pop3s, autodiscoverSrv, autoconfig, caldavs, caldavsPath, carddavs, carddavsPath] =
    await Promise.all([
      srv('_submissions', 465),
      srv('_submission', 587),
      srv('_imaps', 993),
      srv('_imap', 143),
      srv('_pop3s', 995),
      srv('_autodiscover', httpsPort, 0, 0),
      autoconfigHost(),
      srv('_caldavs', httpsPort),
      davPath('_caldavs'),
      srv('_carddavs', httpsPort),
      davPath('_carddavs'),
    ]);
  return { submissions, submission, imaps, imap, pop3s, autodiscoverSrv, autoconfig, caldavs, caldavsPath, carddavs, carddavsPath };
}

// ── GET /:id/dns-check ────────────────────────────────────────────────────────
// Checks all relevant DNS records via the server's local DNS resolver.
adminDomainsRouter.get('/:id/dns-check', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';

  const [rawDomain, settings] = await Promise.all([
    ensureDkimKey(id),
    prisma.serverSettings.findUnique({ where: { id: 'singleton' } }),
  ]);
  if (!rawDomain) { res.status(404).json({ error: 'Domain not found' }); return; }
  const domain = rawDomain;

  const { createPublicKey } = await import('crypto');
  const dns = dnsResolver;

  const hostname   = settings?.publicHostname ?? 'mail.local';
  const domainName = domain.name;
  const dkimName   = `${domain.dkimSelector}._domainkey.${domainName}`;

  // Safely derive the expected DKIM value
  let dkimExpected = '';
  try {
    const pubKey    = createPublicKey(domain.dkimPrivateKey);
    const pubKeyDer = pubKey.export({ type: 'pkcs1', format: 'der' });
    const pubKeyB64 = (pubKeyDer as Buffer).toString('base64');
    dkimExpected = `v=DKIM1; k=rsa; p=${pubKeyB64}`;
  } catch { dkimExpected = ''; }

  interface DnsEntry { ok: boolean; found: string | null; warning?: string }

  async function check(fn: () => Promise<string | null>): Promise<DnsEntry> {
    try {
      const found = await fn();
      return { ok: found !== null, found };
    } catch {
      return { ok: false, found: null };
    }
  }

  // ── Resolve server IP (for SPF record + PTR check) ───────────────────────────
  let serverIp = '';
  try {
    const ips = await dns.resolve4(hostname);
    serverIp = ips[0] ?? '';
  } catch { /* A record not set yet — serverIp stays empty */ }

  // ── MX ──────────────────────────────────────────────────────────────────────
  const mx = await check(async () => {
    const recs = await dns.resolveMx(domainName);
    if (!recs.length) return null;
    return recs.sort((a, b) => a.priority - b.priority).map(r => `${r.priority} ${r.exchange}`).join(', ');
  });

  // ── SPF — with multiple-record detection (RFC 7208 §3.2 violation) ─────────
  const spfRaw = await check(async () => {
    const recs = await dns.resolveTxt(domainName);
    const flat = recs.map(c => c.join(''));
    const spfs = flat.filter(s => s.startsWith('v=spf1'));
    if (spfs.length === 0) return null;
    if (spfs.length === 1) return spfs[0]!;
    return `__MULTI__${spfs.join('\n')}`;
  });
  const spfIsMulti = spfRaw.ok && (spfRaw.found ?? '').startsWith('__MULTI__');
  const spf: DnsEntry = spfIsMulti
    ? { ok: false, found: (spfRaw.found ?? '').replace('__MULTI__', ''),
        warning: 'RFC 7208 §3.2 Verletzung: Mehrere SPF-TXT-Records (→ permerror bei allen Empfängern). Nur einen einzigen SPF-Record behalten!' }
    : spfRaw;

  // ── DKIM ────────────────────────────────────────────────────────────────────
  const dkim = await check(async () => {
    const recs = await dns.resolveTxt(dkimName);
    const flat = recs.map(c => c.join(''));
    return flat.find(s => s.startsWith('v=DKIM1')) ?? null;
  });

  // ── DMARC ───────────────────────────────────────────────────────────────────
  const dmarc = await check(async () => {
    const recs = await dns.resolveTxt(`_dmarc.${domainName}`);
    const flat = recs.map(c => c.join(''));
    return flat.find(s => s.startsWith('v=DMARC1')) ?? null;
  });

  // ── Autodiscover ─────────────────────────────────────────────────────────────
  const autodiscover = await check(async () => {
    try {
      const cnames = await dns.resolveCname(`autodiscover.${domainName}`);
      return cnames[0]?.replace(/\.$/, '') ?? null;
    } catch {
      try {
        const as = await dns.resolve4(`autodiscover.${domainName}`);
        return as[0] ?? null;
      } catch { return null; }
    }
  });

  // ── PTR / FCrDNS ─────────────────────────────────────────────────────────────
  // Uses the already resolved serverIp — forward-confirmed reverse DNS.
  const ptr = await check(async () => {
    if (!serverIp) return null;
    const ptrs    = await dns.reverse(serverIp);
    const cleaned = ptrs.map(p => p.replace(/\.$/, ''));
    const matched = cleaned.find(p => p === hostname || hostname.endsWith(`.${p}`));
    if (!matched) throw new Error(`PTR ${cleaned.join(', ')} ≠ ${hostname}`);
    return `${serverIp} → ${cleaned.join(', ')}`;
  });
  if (!ptr.ok) ptr.warning = 'PTR-Record fehlt oder stimmt nicht überein. Im Hosting-Control-Panel des Servers (Contabo, Hetzner, …) setzen.';

  // ── Expected values ──────────────────────────────────────────────────────────
  // SPF: real server IP if already known, otherwise hostname-based
  const spfExpected   = serverIp
    ? `v=spf1 ip4:${serverIp} ~all`
    : `v=spf1 a:${hostname} mx ~all`;
  const dmarcExpected = `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domainName}; adkim=r; aspf=r`;

  // DKIM: exact key comparison (whitespace-normalized, ignores DNS chunking)
  const dkimKeyOk = dkimExpected !== '' && dkim.found !== null &&
    dkim.found.replace(/\s/g, '') === dkimExpected.replace(/\s/g, '');

  // v5.2.5: relative DNS names as the provider expects them
  // (`_dmarc` instead of `_dmarc.stefanwuestner.de`, `@` for root, `mail` instead
  // of `mail.stefanwuestner.de`). Prevents a double suffix when the user
  // accidentally copies the FQDN from the UI into the provider field.
  const relativeName = (fqdn: string): string => {
    if (fqdn === domainName) return '@';
    const suffix = `.${domainName}`;
    return fqdn.endsWith(suffix) ? fqdn.slice(0, -suffix.length) : fqdn;
  };

  // Hostname relative as well (e.g. "mail.stefanwuestner.de" → "mail")
  const aName = relativeName(hostname);
  const dkimNameRel = relativeName(dkimName);

  // v8.1: client auto-setup records (recommended, not required). HTTPS SRV targets use
  // the public HTTPS port (443 unless an HTTPS port is configured).
  const httpsPort = settings?.useHttps && settings.httpPort && settings.httpPort !== 80 ? settings.httpPort : 443;
  const clientSetup = await checkClientSetupRecords(dns, domainName, hostname, httpsPort);

  res.json({
    domain:   domainName,
    hostname,
    serverIp,
    // Names the HTTPS certificate should cover (SANs) so autodiscover/autoconfig
    // lookups over HTTPS do not fail with a hostname mismatch.
    certificateHostnames: [hostname, `autodiscover.${domainName}`, `autoconfig.${domainName}`]
      .filter((h, i, a) => a.indexOf(h) === i),
    clientSetup,
    records: {
      a:            { type: 'A',     name: aName,                              expected: serverIp,           ok: !!serverIp,  found: serverIp || null },
      mx:           { type: 'MX',    name: '@',                                expected: `10 ${hostname}`,   ...mx },
      spf:          { type: 'TXT',   name: '@',                                expected: spfExpected,        ...spf },
      dkim:         { type: 'TXT',   name: dkimNameRel,                        expected: dkimExpected,       ...dkim, ok: dkimKeyOk },
      dmarc:        { type: 'TXT',   name: '_dmarc',                           expected: dmarcExpected,      ...dmarc },
      autodiscover: { type: 'CNAME', name: 'autodiscover',                     expected: hostname,           ...autodiscover },
      ptr:          { type: 'PTR',   name: hostname,                           expected: hostname,           ...ptr },
    },
  });
});
