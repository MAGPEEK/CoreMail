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
import { syncFromPrimaryDomain } from '../../lib/server-urls.js';

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

  // v3.18.36: Wenn dies die ERSTE Domain ist (= automatisch primary), den
  // publicHostname + alle abgeleiteten URLs (EWS/OWA/EAS/Autodiscover-Base)
  // automatisch ableiten. Schützt vor dem alten Bug: Schema-Default war
  // `mail.local:8080`, was Outlook-Autodiscover für 1000+ User unbrauchbar
  // machte, weil die URLs nirgends sichtbar lagen.
  if (isPrimary) {
    await syncFromPrimaryDomain(parsed.data.name).catch((err: unknown) =>
      log.warn({ err, domain: parsed.data.name }, 'Auto-derive der Server-URLs fehlgeschlagen'),
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

  // v3.18.36: Wenn publicHostname noch Default ist, an die neue primary
  // Domain anpassen. Falls Admin bereits einen eigenen Hostname gesetzt hat,
  // bleibt der erhalten — wir syncen aber die URLs (für den Fall dass nur
  // publicHostname geändert wurde ohne URLs zu derive'n).
  await syncFromPrimaryDomain(domain.name).catch((err: unknown) =>
    log.warn({ err, domain: domain.name }, 'Auto-derive der Server-URLs fehlgeschlagen'),
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

  const { generateKeyPairSync, createPublicKey } = await import('crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  });

  await prisma.domain.update({ where: { id }, data: { dkimPrivateKey: privateKey } });

  const pubKey    = createPublicKey(privateKey);
  const pubKeyDer = pubKey.export({ type: 'pkcs1', format: 'der' });
  const pubKeyB64 = (pubKeyDer as Buffer).toString('base64');

  log.info({ id, name: domain.name }, 'DKIM key pair regenerated');
  res.json({
    selector: domain.dkimSelector,
    dnsName:  `${domain.dkimSelector}._domainkey.${domain.name}`,
    dnsValue: `v=DKIM1; k=rsa; p=${pubKeyB64}`,
  });
});

// ── GET /:id/dns-check ────────────────────────────────────────────────────────
// Prüft alle relevanten DNS-Einträge über den lokalen DNS-Resolver des Servers.
adminDomainsRouter.get('/:id/dns-check', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';

  const [rawDomain, settings] = await Promise.all([
    ensureDkimKey(id),
    prisma.serverSettings.findUnique({ where: { id: 'singleton' } }),
  ]);
  if (!rawDomain) { res.status(404).json({ error: 'Domain not found' }); return; }
  const domain = rawDomain;

  const { createPublicKey } = await import('crypto');
  const { promises: dns }   = await import('dns');

  const hostname   = settings?.publicHostname ?? 'mail.local';
  const domainName = domain.name;
  const dkimName   = `${domain.dkimSelector}._domainkey.${domainName}`;

  // DKIM-Erwartungswert sicher ableiten
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

  // ── Server-IP auflösen (für SPF-Record + PTR-Check) ──────────────────────────
  let serverIp = '';
  try {
    const ips = await dns.resolve4(hostname);
    serverIp = ips[0] ?? '';
  } catch { /* A-Record noch nicht gesetzt — serverIp bleibt leer */ }

  // ── MX ──────────────────────────────────────────────────────────────────────
  const mx = await check(async () => {
    const recs = await dns.resolveMx(domainName);
    if (!recs.length) return null;
    return recs.sort((a, b) => a.priority - b.priority).map(r => `${r.priority} ${r.exchange}`).join(', ');
  });

  // ── SPF — mit Mehrfach-Record-Erkennung (RFC 7208 §3.2 Verletzung) ─────────
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
  // Nutzt die bereits aufgelöste serverIp — Forward-confirmed reverse DNS.
  const ptr = await check(async () => {
    if (!serverIp) return null;
    const ptrs    = await dns.reverse(serverIp);
    const cleaned = ptrs.map(p => p.replace(/\.$/, ''));
    const matched = cleaned.find(p => p === hostname || hostname.endsWith(`.${p}`));
    if (!matched) throw new Error(`PTR ${cleaned.join(', ')} ≠ ${hostname}`);
    return `${serverIp} → ${cleaned.join(', ')}`;
  });
  if (!ptr.ok) ptr.warning = 'PTR-Record fehlt oder stimmt nicht überein. Im Hosting-Control-Panel des Servers (Contabo, Hetzner, …) setzen.';

  // ── Erwartungswerte ──────────────────────────────────────────────────────────
  // SPF: echte Server-IP wenn bereits bekannt, sonst hostname-basiert
  const spfExpected   = serverIp
    ? `v=spf1 ip4:${serverIp} ~all`
    : `v=spf1 a:${hostname} mx ~all`;
  const dmarcExpected = `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domainName}; adkim=r; aspf=r`;

  // DKIM: exakter Schlüsselvergleich (Whitespace-normalisiert, ignoriert DNS-Chunking)
  const dkimKeyOk = dkimExpected !== '' && dkim.found !== null &&
    dkim.found.replace(/\s/g, '') === dkimExpected.replace(/\s/g, '');

  // v5.2.5: Relative DNS-Namen wie sie der Provider erwartet
  // (`_dmarc` statt `_dmarc.stefanwuestner.de`, `@` für Root, `mail` statt
  // `mail.stefanwuestner.de`). Verhindert Doppel-Suffix wenn der User
  // versehentlich den FQDN aus dem UI in das Provider-Feld kopiert.
  const relativeName = (fqdn: string): string => {
    if (fqdn === domainName) return '@';
    const suffix = `.${domainName}`;
    return fqdn.endsWith(suffix) ? fqdn.slice(0, -suffix.length) : fqdn;
  };

  // Hostname auch relativ (z.B. "mail.stefanwuestner.de" → "mail")
  const aName = relativeName(hostname);
  const dkimNameRel = relativeName(dkimName);

  res.json({
    domain:   domainName,
    hostname,
    serverIp,
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
