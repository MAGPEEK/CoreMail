/**
 * Admin-API: Domain-Verwaltung
 *
 * GET    /api/v1/admin/domains                    — alle Domains (gefiltert, paginiert)
 * GET    /api/v1/admin/domains/:id                — einzelne Domain
 * POST   /api/v1/admin/domains                    — neue Domain anlegen (DKIM auto-generiert)
 * PUT    /api/v1/admin/domains/:id                — Domain bearbeiten (name, active, dkimSelector)
 * PATCH  /api/v1/admin/domains/:id/toggle         — active umschalten
 * POST   /api/v1/admin/domains/:id/make-primary   — primäre Domain setzen
 * DELETE /api/v1/admin/domains/:id                — Domain löschen
 * GET    /api/v1/admin/domains/:id/dkim-record    — DNS TXT-Eintrag für DKIM
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAdmin } from '../../middleware/auth.js';
import { createLogger } from '@coremail/core';

const log = createLogger('admin:domains');
export const adminDomainsRouter: RouterType = Router();
adminDomainsRouter.use(requireAdmin);

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

  // DKIM-Schlüsselpaar automatisch generieren
  const { generateKeyPairSync } = await import('crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  });

  // Erste Domain wird automatisch primär
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

  // Alle anderen Domains als nicht-primär markieren, diese als primär
  await prisma.$transaction([
    prisma.domain.updateMany({ where: { primary: true  }, data: { primary: false } }),
    prisma.domain.update({ where: { id }, data: { primary: true } }),
  ]);
  log.info({ id, name: domain.name }, 'Domain set as primary');

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
  const userCount = await prisma.user.count({ where: { domainId: id } });
  if (userCount > 0) { res.status(409).json({ error: 'Domain has active mailboxes' }); return; }
  await prisma.domain.delete({ where: { id } });
  log.info({ id, name: domain.name }, 'Domain deleted');
  res.json({ ok: true });
});

// ── Helper: DKIM-Schlüssel sicherstellen (auto-generieren falls leer) ─────────
async function ensureDkimKey(id: string): Promise<typeof import('@coremail/storage').prisma.domain extends never ? never : Awaited<ReturnType<typeof prisma.domain.findUnique>> & { dkimPrivateKey: string }> {
  let domain = await prisma.domain.findUnique({ where: { id } });
  if (!domain) return null as never;

  if (!domain.dkimPrivateKey || domain.dkimPrivateKey.trim() === '') {
    // Kein Schlüssel vorhanden — RSA-2048-Paar generieren und speichern
    const { generateKeyPairSync } = await import('crypto');
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    });
    domain = await prisma.domain.update({
      where: { id },
      data:  { dkimPrivateKey: privateKey },
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
    const pubKeyDer = pubKey.export({ type: 'spki', format: 'der' });
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

  const { generateKeyPairSync, createPublicKey } = await import('crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  });

  await prisma.domain.update({ where: { id }, data: { dkimPrivateKey: privateKey } });

  const pubKey    = createPublicKey(privateKey);
  const pubKeyDer = pubKey.export({ type: 'spki', format: 'der' });
  const pubKeyB64 = (pubKeyDer as Buffer).toString('base64');

  log.info({ id, name: domain.name }, 'DKIM key pair regenerated');
  res.json({
    selector: domain.dkimSelector,
    dnsName:  `${domain.dkimSelector}._domainkey.${domain.name}`,
    dnsValue: `v=DKIM1; k=rsa; p=${pubKeyB64}`,
  });
});

// ── GET /:id/dns-check ────────────────────────────────────────────────────────
// Prüft alle relevanten DNS-Einträge über drei öffentliche Resolver gleichzeitig.
//
// WICHTIG: Wir benutzen NICHT dns.promises (System-DNS) — im Docker-Container
// würde das den internen Resolver (127.0.0.11) nutzen, der gecachte oder
// abweichende Ergebnisse liefert.  Stattdessen werden drei externe Resolver
// direkt befragt: Google 8.8.8.8, Cloudflare 1.1.1.1, Quad9 9.9.9.9.
// Das liefert das selbe Bild wie der DNS-Anbieter des Empfängers sieht.
adminDomainsRouter.get('/:id/dns-check', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';

  const [rawDomain, settings] = await Promise.all([
    ensureDkimKey(id),
    prisma.serverSettings.findUnique({ where: { id: 'singleton' } }),
  ]);
  if (!rawDomain) { res.status(404).json({ error: 'Domain not found' }); return; }
  const domain = rawDomain;

  const { createPublicKey }  = await import('crypto');
  const { promises: dnsP }   = await import('dns');

  const hostname   = settings?.publicHostname ?? 'mail.local';
  const domainName = domain.name;
  const dkimName   = `${domain.dkimSelector}._domainkey.${domainName}`;

  // DKIM-Erwartungswert sicher ableiten
  let dkimExpected = '';
  try {
    const pubKey    = createPublicKey(domain.dkimPrivateKey);
    const pubKeyDer = pubKey.export({ type: 'spki', format: 'der' });
    const pubKeyB64 = (pubKeyDer as Buffer).toString('base64');
    dkimExpected = `v=DKIM1; k=rsa; p=${pubKeyB64}`;
  } catch { dkimExpected = ''; }

  // ── Drei öffentliche Resolver ─────────────────────────────────────────────
  const RESOLVERS = [
    { name: 'Google',     ip: '8.8.8.8' },
    { name: 'Cloudflare', ip: '1.1.1.1' },
    { name: 'Quad9',      ip: '9.9.9.9' },
  ] as const;

  interface ResolverResult {
    resolver:  string;
    ip:        string;
    ok:        boolean;
    found:     string | null;
    latencyMs: number;
    error?:    string;
  }
  interface CheckSummary {
    ok:         boolean;
    found:      string | null;
    resolvers:  ResolverResult[];
    consistent: boolean;
    warning?:   string;
  }

  type ResolverFn = (r: InstanceType<typeof dnsP.Resolver>) => Promise<string | null>;

  /**
   * Fragt alle drei Resolver parallel an und liefert:
   *  - ok:         mind. ein Resolver hat den Eintrag gefunden
   *  - found:      Wert vom ersten erfolgreichen Resolver
   *  - resolvers:  Ergebnis pro Resolver (für die UI)
   *  - consistent: alle Resolver sind einig
   */
  async function checkWithResolvers(fn: ResolverFn): Promise<CheckSummary> {
    const results: ResolverResult[] = await Promise.all(
      RESOLVERS.map(async (r) => {
        const resolver = new dnsP.Resolver({ timeout: 5000, tries: 1 });
        resolver.setServers([r.ip]);
        const t0 = Date.now();
        try {
          const found = await fn(resolver);
          return { resolver: r.name, ip: r.ip, ok: found !== null, found, latencyMs: Date.now() - t0 };
        } catch (err) {
          return { resolver: r.name, ip: r.ip, ok: false, found: null, latencyMs: Date.now() - t0, error: (err as Error).message };
        }
      })
    );

    const ok       = results.some(r => r.ok);
    const found    = results.find(r => r.ok)?.found ?? null;
    const okVals   = results.filter(r => r.ok).map(r => r.found);
    const consistent = okVals.length === 0 || okVals.every(v => v === okVals[0]);

    return { ok, found, resolvers: results, consistent };
  }

  // ── MX ──────────────────────────────────────────────────────────────────────
  const mx = await checkWithResolvers(async (r) => {
    const recs = await r.resolveMx(domainName);
    if (!recs.length) return null;
    return recs.sort((a, b) => a.priority - b.priority).map(rx => `${rx.priority} ${rx.exchange}`).join(', ');
  });

  // ── SPF — mit Mehrfach-Record-Erkennung (RFC 7208 §3.2 Verletzung) ─────────
  const spfRaw = await checkWithResolvers(async (r) => {
    const recs = await r.resolveTxt(domainName);
    const flat = recs.map(c => c.join(''));
    const spfs = flat.filter(s => s.startsWith('v=spf1'));
    if (spfs.length === 0) return null;
    if (spfs.length === 1) return spfs[0]!;
    // Mehrere SPF-Records: RFC-Verletzung → Sondermarkierung
    return `__MULTI__${spfs.join('\n')}`;
  });

  // SPF nachkorrigieren: Mehrfach-Record → ok=false + Warnung
  const spfIsMulti = spfRaw.ok && (spfRaw.found ?? '').startsWith('__MULTI__');
  const spf: CheckSummary = spfIsMulti
    ? {
        ok:        false,
        found:     (spfRaw.found ?? '').replace('__MULTI__', ''),
        warning:   'RFC 7208 §3.2 Verletzung: Mehrere SPF-TXT-Records (→ permerror bei allen Empfängern). Nur einen einzigen SPF-Record behalten!',
        consistent: spfRaw.consistent,
        resolvers: spfRaw.resolvers.map((res) => {
          const isMultiRes = (res.found ?? '').startsWith('__MULTI__');
          const cleanFound = (res.found ?? '').replace('__MULTI__', '');
          return {
            resolver:  res.resolver,
            ip:        res.ip,
            ok:        false,
            found:     cleanFound || null,
            latencyMs: res.latencyMs,
            ...(isMultiRes ? { error: 'Mehrere SPF-Records' } : res.error !== undefined ? { error: res.error } : {}),
          } satisfies ResolverResult;
        }),
      }
    : spfRaw;

  // ── DKIM ────────────────────────────────────────────────────────────────────
  const dkim = await checkWithResolvers(async (r) => {
    const recs = await r.resolveTxt(dkimName);
    const flat = recs.map(c => c.join(''));
    return flat.find(s => s.startsWith('v=DKIM1')) ?? null;
  });

  // ── DMARC ───────────────────────────────────────────────────────────────────
  const dmarc = await checkWithResolvers(async (r) => {
    const recs = await r.resolveTxt(`_dmarc.${domainName}`);
    const flat = recs.map(c => c.join(''));
    return flat.find(s => s.startsWith('v=DMARC1')) ?? null;
  });

  // ── Autodiscover ─────────────────────────────────────────────────────────────
  const autodiscover = await checkWithResolvers(async (r) => {
    try {
      const cnames = await r.resolveCname(`autodiscover.${domainName}`);
      return cnames[0]?.replace(/\.$/, '') ?? null;
    } catch {
      // Manche Domains setzen einen A-Record statt CNAME — auch das ist gültig
      try {
        const as = await r.resolve4(`autodiscover.${domainName}`);
        return as[0] ?? null;
      } catch { return null; }
    }
  });

  // ── PTR / FCrDNS ─────────────────────────────────────────────────────────────
  // Forward-confirmed reverse DNS: hostname → IP(A) → PTR → muss auf hostname zeigen.
  // Das ist ein Muss für Google, Microsoft und die meisten Anti-Spam-Systeme.
  const ptrResults: ResolverResult[] = await Promise.all(
    RESOLVERS.map(async (r) => {
      const resolver = new dnsP.Resolver({ timeout: 5000, tries: 1 });
      resolver.setServers([r.ip]);
      const t0 = Date.now();
      try {
        // 1. A-Record des Hostnamens
        const ips = await resolver.resolve4(hostname);
        const ip  = ips[0];
        if (!ip) return { resolver: r.name, ip: r.ip, ok: false, found: null, latencyMs: Date.now() - t0, error: `Kein A-Record für ${hostname}` };
        // 2. Reverse-Lookup (PTR)
        const ptrs    = await resolver.reverse(ip);
        const cleaned = ptrs.map(p => p.replace(/\.$/, ''));
        const matched = cleaned.find(p => p === hostname || hostname.endsWith(`.${p}`));
        const found   = `${ip} → ${cleaned.join(', ')}`;
        return { resolver: r.name, ip: r.ip, ok: !!matched, found, latencyMs: Date.now() - t0 };
      } catch (err) {
        return { resolver: r.name, ip: r.ip, ok: false, found: null, latencyMs: Date.now() - t0, error: (err as Error).message };
      }
    })
  );

  const ptrOk         = ptrResults.some(r => r.ok);
  const ptrFound      = ptrResults.find(r => r.found)?.found ?? null;
  const ptrOkVals     = ptrResults.filter(r => r.ok).map(r => r.found);
  const ptrConsistent = ptrOkVals.length === 0 || ptrOkVals.every(v => v === ptrOkVals[0]);
  const ptr: CheckSummary = {
    ok: ptrOk, found: ptrFound, resolvers: ptrResults, consistent: ptrConsistent,
    ...(!ptrOk ? { warning: 'PTR-Record fehlt oder stimmt nicht überein. Im Hosting-Control-Panel des Servers setzen.' } : {}),
  };

  // ── Antwort ─────────────────────────────────────────────────────────────────
  const spfExpected   = `v=spf1 ip4:<ServerIP> -all  (oder a:${hostname} mx ~all)`;
  const dmarcExpected = `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domainName}; adkim=r; aspf=r`;

  res.json({
    domain:    domainName,
    hostname,
    checkedAt: new Date().toISOString(),
    resolversUsed: RESOLVERS.map(r => ({ name: r.name, ip: r.ip })),
    records: {
      mx: {
        type: 'MX', name: domainName, expected: `10 ${hostname}`, ...mx,
      },
      spf: {
        type: 'TXT', name: domainName, expected: spfExpected, ...spf,
      },
      dkim: {
        type: 'TXT', name: dkimName, expected: dkimExpected, ...dkim,
      },
      dmarc: {
        type: 'TXT', name: `_dmarc.${domainName}`, expected: dmarcExpected, ...dmarc,
      },
      autodiscover: {
        type: 'CNAME', name: `autodiscover.${domainName}`, expected: hostname, ...autodiscover,
      },
      ptr: {
        type: 'PTR', name: hostname, expected: hostname, ...ptr,
      },
    },
  });
});
