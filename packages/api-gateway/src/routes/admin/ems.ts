/**
 * Exchange Management Shell (EMS) REST Bridge — Phase 8
 *
 * Implements Exchange Management Shell cmdlets as REST endpoints.
 * The PowerShell stub (/PowerShell/) routes supported cmdlets to this bridge.
 *
 * All endpoints mirror EMS cmdlet semantics:
 *   GET    → Get-*       (list / get single)
 *   POST   → New-*       (create)
 *   PUT    → Set-*       (update)
 *   DELETE → Remove-*    (delete)
 *
 * Endpoints under /api/v1/admin/ems/
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { hashPassword } from '@coremail/core';
import { requireAdmin } from '../../middleware/auth.js';

export const adminEmsRouter: RouterType = Router();
adminEmsRouter.use(requireAdmin);

// ──────────────────────────────────────────────────────────────────
// Get-Mailbox / New-Mailbox / Set-Mailbox / Remove-Mailbox
// ──────────────────────────────────────────────────────────────────

// GET /api/v1/admin/ems/mailboxes[?identity=email&filter=...]
adminEmsRouter.get('/mailboxes', async (req: Request, res: Response) => {
  const { identity, resultSize } = req.query as { identity?: string; resultSize?: string };
  const take = Math.min(parseInt(resultSize ?? '100', 10), 1000);

  if (identity) {
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: identity }, { id: identity }] },
      include: { mailbox: { select: { id: true, uidNext: true } }, domain: { select: { name: true } } },
    });
    if (!user) { res.status(404).json({ error: `The operation couldn't be performed because object '${identity}' couldn't be found.` }); return; }
    res.json([formatMailbox(user)]);
    return;
  }

  const users = await prisma.user.findMany({
    include: { mailbox: { select: { id: true, uidNext: true } }, domain: { select: { name: true } } },
    orderBy: { email: 'asc' },
    take,
  });
  res.json(users.map(formatMailbox));
});

function formatMailbox(u: { id: string; email: string; displayName: string; role: string; active: boolean; quotaBytes: bigint; usedBytes: bigint; domain: { name: string } | null; mailbox: { id: string; uidNext: number } | null }) {
  return {
    Identity: u.id,
    Alias: u.email.split('@')[0],
    DisplayName: u.displayName,
    PrimarySmtpAddress: u.email,
    UserPrincipalName: u.email,
    Database: `CoreMailDB-${u.domain?.name ?? 'default'}`,
    MailboxPlan: 'CoreMailPlan',
    RecipientType: 'UserMailbox',
    RecipientTypeDetails: 'UserMailbox',
    IsEnabled: u.active,
    ProhibitSendQuota: formatQuota(u.quotaBytes),
    UsageQuota: formatQuota(u.usedBytes),
    Guid: u.id,
    ExchangeGuid: u.mailbox?.id ?? u.id,
    ServerName: 'CoreMail',
    OrganizationalUnit: u.domain?.name ?? '',
    WhenCreated: new Date().toISOString(),
  };
}

function formatQuota(bytes: bigint): string {
  const gb = Number(bytes) / 1073741824;
  return `${gb.toFixed(2)} GB (${bytes.toString()} bytes)`;
}

// POST /api/v1/admin/ems/mailboxes  → New-Mailbox
adminEmsRouter.post('/mailboxes', async (req: Request, res: Response) => {
  const schema = z.object({
    Name: z.string().min(1),
    DisplayName: z.string().optional(),
    Password: z.string().min(8),
    PrimarySmtpAddress: z.string().email(),
    Database: z.string().optional(),
    OrganizationalUnit: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { Name, DisplayName, Password, PrimarySmtpAddress } = parsed.data;
  const email = PrimarySmtpAddress.toLowerCase();
  const domainName = email.split('@')[1] ?? '';

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) { res.status(409).json({ error: `A user with email '${email}' already exists.` }); return; }

  const domain = await prisma.domain.findFirst({ where: { name: domainName } });
  if (!domain) { res.status(400).json({ error: `Domain '${domainName}' is not an accepted domain.` }); return; }

  const passwordHash = await hashPassword(Password);
  const user = await prisma.user.create({
    data: {
      email,
      displayName: DisplayName ?? Name,
      passwordHash,
      domainId: domain.id,
      mailbox: {
        create: {
          folders: {
            create: [
              { name: 'INBOX', displayName: 'Inbox' },
              { name: 'Drafts', displayName: 'Drafts' },
              { name: 'Sent', displayName: 'Sent Items' },
              { name: 'Trash', displayName: 'Deleted Items' },
              { name: 'Junk', displayName: 'Junk Email' },
              { name: 'Archive', displayName: 'Archive' },
            ],
          },
        },
      },
      calendars: { create: [{ name: 'Calendar', color: '#0078D4' }] },
    },
    include: { mailbox: { select: { id: true, uidNext: true } }, domain: { select: { name: true } } },
  });
  res.status(201).json(formatMailbox(user));
});

// PUT /api/v1/admin/ems/mailboxes/:identity  → Set-Mailbox
adminEmsRouter.put('/mailboxes/:identity', async (req: Request, res: Response) => {
  const { identity } = req.params as { identity: string };
  const schema = z.object({
    DisplayName: z.string().optional(),
    ProhibitSendQuota: z.number().optional(),
    IsEnabled: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const user = await prisma.user.findFirst({ where: { OR: [{ email: identity }, { id: identity }] } });
  if (!user) { res.status(404).json({ error: `Mailbox '${identity}' not found.` }); return; }

  const { DisplayName, ProhibitSendQuota, IsEnabled } = parsed.data;
  await prisma.user.update({
    where: { id: user.id },
    data: {
      ...(DisplayName !== undefined ? { displayName: DisplayName } : {}),
      ...(ProhibitSendQuota !== undefined ? { quotaBytes: BigInt(ProhibitSendQuota) } : {}),
      ...(IsEnabled !== undefined ? { active: IsEnabled } : {}),
    },
  });
  res.json({ Identity: user.id, Result: 'Success' });
});

// DELETE /api/v1/admin/ems/mailboxes/:identity  → Remove-Mailbox
adminEmsRouter.delete('/mailboxes/:identity', async (req: Request, res: Response) => {
  const { identity } = req.params as { identity: string };
  const user = await prisma.user.findFirst({ where: { OR: [{ email: identity }, { id: identity }] } });
  if (!user) { res.status(404).json({ error: `Mailbox '${identity}' not found.` }); return; }
  await prisma.user.delete({ where: { id: user.id } });
  res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────
// Get-DistributionGroup / New- / Set- / Remove-DistributionGroup
// ──────────────────────────────────────────────────────────────────

adminEmsRouter.get('/distribution-groups', async (req: Request, res: Response) => {
  const { identity } = req.query as { identity?: string };
  if (identity) {
    const g = await prisma.distributionGroup.findFirst({
      where: { OR: [{ email: identity }, { id: identity }] },
      include: { _count: { select: { members: true } } },
    });
    if (!g) { res.status(404).json({ error: `Group '${identity}' not found.` }); return; }
    res.json([formatGroup(g)]);
    return;
  }
  const groups = await prisma.distributionGroup.findMany({
    include: { _count: { select: { members: true } } },
    orderBy: { displayName: 'asc' },
  });
  res.json(groups.map(formatGroup));
});

function formatGroup(g: { id: string; email: string; displayName: string; groupType: string; active: boolean; hiddenFromGal: boolean; _count: { members: number } }) {
  return {
    Identity: g.id,
    Alias: g.email.split('@')[0],
    DisplayName: g.displayName,
    PrimarySmtpAddress: g.email,
    GroupType: g.groupType === 'DYNAMIC' ? 'DynamicDistribution' : 'Distribution',
    RecipientType: 'MailUniversalDistributionGroup',
    IsEnabled: g.active,
    HiddenFromAddressListsEnabled: g.hiddenFromGal,
    Members: g._count.members,
    RequireSenderAuthenticationEnabled: false,
    ManagedBy: [],
  };
}

adminEmsRouter.post('/distribution-groups', async (req: Request, res: Response) => {
  const schema = z.object({
    Name: z.string().min(1),
    DisplayName: z.string().optional(),
    PrimarySmtpAddress: z.string().email(),
    Type: z.enum(['Distribution', 'DynamicDistribution']).default('Distribution'),
    OrganizationalUnit: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { Name, DisplayName, PrimarySmtpAddress, Type } = parsed.data;
  const email = PrimarySmtpAddress.toLowerCase();
  const domainName = email.split('@')[1] ?? '';

  const domain = await prisma.domain.findFirst({ where: { name: domainName } });
  if (!domain) { res.status(400).json({ error: `Domain '${domainName}' not found.` }); return; }

  const existing = await prisma.distributionGroup.findUnique({ where: { email } });
  if (existing) { res.status(409).json({ error: `Email '${email}' already in use.` }); return; }

  const group = await prisma.distributionGroup.create({
    data: {
      email,
      displayName: DisplayName ?? Name,
      domainId: domain.id,
      groupType: Type === 'DynamicDistribution' ? 'DYNAMIC' : 'STATIC',
    },
    include: { _count: { select: { members: true } } },
  });
  res.status(201).json(formatGroup(group));
});

adminEmsRouter.put('/distribution-groups/:identity', async (req: Request, res: Response) => {
  const { identity } = req.params as { identity: string };
  const schema = z.object({
    DisplayName: z.string().optional(),
    HiddenFromAddressListsEnabled: z.boolean().optional(),
    RequireSenderAuthenticationEnabled: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const group = await prisma.distributionGroup.findFirst({
    where: { OR: [{ email: identity }, { id: identity }] },
  });
  if (!group) { res.status(404).json({ error: `Group '${identity}' not found.` }); return; }

  const { DisplayName, HiddenFromAddressListsEnabled, RequireSenderAuthenticationEnabled } = parsed.data;
  await prisma.distributionGroup.update({
    where: { id: group.id },
    data: {
      ...(DisplayName !== undefined ? { displayName: DisplayName } : {}),
      ...(HiddenFromAddressListsEnabled !== undefined ? { hiddenFromGal: HiddenFromAddressListsEnabled } : {}),
      ...(RequireSenderAuthenticationEnabled !== undefined ? { requireSenderAuth: RequireSenderAuthenticationEnabled } : {}),
    },
  });
  res.json({ Identity: group.id, Result: 'Success' });
});

adminEmsRouter.delete('/distribution-groups/:identity', async (req: Request, res: Response) => {
  const { identity } = req.params as { identity: string };
  const group = await prisma.distributionGroup.findFirst({
    where: { OR: [{ email: identity }, { id: identity }] },
  });
  if (!group) { res.status(404).json({ error: `Group '${identity}' not found.` }); return; }
  await prisma.distributionGroup.delete({ where: { id: group.id } });
  res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────
// Get/Add/Remove-DistributionGroupMember
// ──────────────────────────────────────────────────────────────────

adminEmsRouter.get('/distribution-groups/:identity/members', async (req: Request, res: Response) => {
  const { identity } = req.params as { identity: string };
  const group = await prisma.distributionGroup.findFirst({
    where: { OR: [{ email: identity }, { id: identity }] },
  });
  if (!group) { res.status(404).json({ error: `Group '${identity}' not found.` }); return; }
  const members = await prisma.distributionGroupMember.findMany({
    where: { groupId: group.id }, orderBy: { memberEmail: 'asc' },
  });
  res.json(members.map((m) => ({ Name: m.memberEmail, PrimarySmtpAddress: m.memberEmail, RecipientType: m.memberType })));
});

adminEmsRouter.post('/distribution-groups/:identity/members', async (req: Request, res: Response) => {
  const { identity } = req.params as { identity: string };
  const schema = z.object({ Member: z.string().email() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const group = await prisma.distributionGroup.findFirst({ where: { OR: [{ email: identity }, { id: identity }] } });
  if (!group) { res.status(404).json({ error: `Group '${identity}' not found.` }); return; }

  try {
    await prisma.distributionGroupMember.create({
      data: { groupId: group.id, memberEmail: parsed.data.Member, addedBy: req.apiUser?.userId ?? null },
    });
    res.status(201).json({ Result: 'Success' });
  } catch { res.status(409).json({ error: 'Member already in group.' }); }
});

adminEmsRouter.delete('/distribution-groups/:identity/members/:member', async (req: Request, res: Response) => {
  const { identity, member } = req.params as { identity: string; member: string };
  const group = await prisma.distributionGroup.findFirst({ where: { OR: [{ email: identity }, { id: identity }] } });
  if (!group) { res.status(404).json({ error: `Group '${identity}' not found.` }); return; }
  await prisma.distributionGroupMember.deleteMany({ where: { groupId: group.id, memberEmail: member } });
  res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────
// Get-AcceptedDomain / New-AcceptedDomain / Remove-AcceptedDomain
// ──────────────────────────────────────────────────────────────────

adminEmsRouter.get('/accepted-domains', async (_req: Request, res: Response) => {
  const domains = await prisma.domain.findMany({ orderBy: { name: 'asc' } });
  res.json(domains.map((d) => ({
    Identity: d.id,
    Name: d.name,
    DomainName: d.name,
    DomainType: 'Authoritative',
    IsEnabled: d.active,
    Default: false,
  })));
});

adminEmsRouter.post('/accepted-domains', async (req: Request, res: Response) => {
  const schema = z.object({
    Name: z.string().min(1),
    DomainName: z.string().min(1),
    DomainType: z.enum(['Authoritative', 'InternalRelay', 'ExternalRelay']).default('Authoritative'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const existing = await prisma.domain.findUnique({ where: { name: parsed.data.DomainName } });
  if (existing) { res.status(409).json({ error: `Domain '${parsed.data.DomainName}' already exists.` }); return; }

  const domain = await prisma.domain.create({
    data: { name: parsed.data.DomainName, dkimPrivateKey: '', dkimSelector: 'coremail' },
  });
  res.status(201).json({ Identity: domain.id, Name: parsed.data.Name, DomainName: domain.name, DomainType: parsed.data.DomainType });
});

// ──────────────────────────────────────────────────────────────────
// Get-TransportRule / New-TransportRule / Set-TransportRule / Remove-TransportRule
// ──────────────────────────────────────────────────────────────────

adminEmsRouter.get('/transport-rules', async (_req: Request, res: Response) => {
  const rules = await prisma.transportRule.findMany({ orderBy: { priority: 'asc' } });
  res.json(rules.map((r) => ({
    Identity: r.id, Name: r.name, Description: r.description,
    Priority: r.priority, State: r.enabled ? 'Enabled' : 'Disabled',
    Conditions: r.conditions, Actions: r.actions,
  })));
});

adminEmsRouter.post('/transport-rules', async (req: Request, res: Response) => {
  const schema = z.object({
    Name: z.string().min(1),
    Description: z.string().default(''),
    Priority: z.number().int().default(0),
    Conditions: z.array(z.record(z.unknown())).default([]),
    Actions: z.array(z.record(z.unknown())).default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const createdBy = req.apiUser?.userId ?? '';
  const rule = await prisma.transportRule.create({
    data: {
      name: parsed.data.Name,
      description: parsed.data.Description,
      priority: parsed.data.Priority,
      conditions: parsed.data.Conditions as unknown as object,
      actions: parsed.data.Actions as unknown as object,
      createdBy,
    },
  });
  res.status(201).json({ Identity: rule.id, Name: rule.name, Priority: rule.priority, State: 'Enabled' });
});

adminEmsRouter.put('/transport-rules/:identity', async (req: Request, res: Response) => {
  const { identity } = req.params as { identity: string };
  const schema = z.object({
    Name: z.string().optional(),
    Priority: z.number().int().optional(),
    State: z.enum(['Enabled', 'Disabled']).optional(),
    Conditions: z.array(z.record(z.unknown())).optional(),
    Actions: z.array(z.record(z.unknown())).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const rule = await prisma.transportRule.findFirst({ where: { OR: [{ name: identity }, { id: identity }] } });
  if (!rule) { res.status(404).json({ error: `Rule '${identity}' not found.` }); return; }

  const { Name, Priority, State, Conditions, Actions } = parsed.data;
  await prisma.transportRule.update({
    where: { id: rule.id },
    data: {
      ...(Name !== undefined ? { name: Name } : {}),
      ...(Priority !== undefined ? { priority: Priority } : {}),
      ...(State !== undefined ? { enabled: State === 'Enabled' } : {}),
      ...(Conditions !== undefined ? { conditions: Conditions as unknown as object } : {}),
      ...(Actions !== undefined ? { actions: Actions as unknown as object } : {}),
    },
  });
  res.json({ Identity: rule.id, Result: 'Success' });
});

adminEmsRouter.delete('/transport-rules/:identity', async (req: Request, res: Response) => {
  const { identity } = req.params as { identity: string };
  const rule = await prisma.transportRule.findFirst({ where: { OR: [{ name: identity }, { id: identity }] } });
  if (!rule) { res.status(404).json({ error: `Rule '${identity}' not found.` }); return; }
  await prisma.transportRule.delete({ where: { id: rule.id } });
  res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────
// Get-MailboxStatistics
// ──────────────────────────────────────────────────────────────────

adminEmsRouter.get('/mailbox-statistics', async (req: Request, res: Response) => {
  const { identity } = req.query as { identity?: string };
  if (!identity) { res.status(400).json({ error: 'Identity parameter required.' }); return; }

  const user = await prisma.user.findFirst({
    where: { OR: [{ email: identity }, { id: identity }] },
    include: { mailbox: { include: { _count: { select: { folders: true } } } } },
  });
  if (!user) { res.status(404).json({ error: `Mailbox '${identity}' not found.` }); return; }

  const messageCount = user.mailbox ? await prisma.message.count({
    where: { folder: { mailboxId: user.mailbox.id }, deletedAt: null },
  }) : 0;

  res.json({
    DisplayName: user.displayName,
    MailboxType: 'User',
    ItemCount: messageCount,
    TotalItemSize: formatQuota(user.usedBytes),
    DatabaseName: `CoreMailDB-${user.email.split('@')[1]}`,
    ServerName: 'CoreMail',
    LastLogonTime: new Date().toISOString(),
    LastLogoffTime: new Date().toISOString(),
  });
});

// ──────────────────────────────────────────────────────────────────
// Get-ResourceMailbox
// ──────────────────────────────────────────────────────────────────

adminEmsRouter.get('/resource-mailboxes', async (req: Request, res: Response) => {
  const { identity } = req.query as { identity?: string };
  if (identity) {
    const r = await prisma.resourceMailbox.findFirst({ where: { OR: [{ email: identity }, { id: identity }] } });
    if (!r) { res.status(404).json({ error: `Resource '${identity}' not found.` }); return; }
    res.json([formatResource(r)]);
    return;
  }
  const resources = await prisma.resourceMailbox.findMany({ orderBy: { displayName: 'asc' } });
  res.json(resources.map(formatResource));
});

function formatResource(r: { id: string; email: string; displayName: string; resourceType: string; capacity: number | null; location: string; active: boolean }) {
  return {
    Identity: r.id,
    Alias: r.email.split('@')[0],
    DisplayName: r.displayName,
    PrimarySmtpAddress: r.email,
    ResourceType: r.resourceType,
    Capacity: r.capacity,
    Location: r.location,
    IsEnabled: r.active,
    RecipientType: 'UserMailbox',
    RecipientTypeDetails: r.resourceType === 'ROOM' ? 'RoomMailbox' : 'EquipmentMailbox',
  };
}

// ──────────────────────────────────────────────────────────────────
// Generic cmdlet dispatcher (for PowerShell Stub routing)
// POST /api/v1/admin/ems/cmdlet
// Body: { Cmdlet: "Get-Mailbox", Parameters: { Identity: "user@domain.de" } }
// ──────────────────────────────────────────────────────────────────

const CMDLET_MAP: Record<string, string> = {
  'Get-Mailbox': 'GET /mailboxes',
  'New-Mailbox': 'POST /mailboxes',
  'Set-Mailbox': 'PUT /mailboxes/{identity}',
  'Remove-Mailbox': 'DELETE /mailboxes/{identity}',
  'Get-DistributionGroup': 'GET /distribution-groups',
  'New-DistributionGroup': 'POST /distribution-groups',
  'Set-DistributionGroup': 'PUT /distribution-groups/{identity}',
  'Remove-DistributionGroup': 'DELETE /distribution-groups/{identity}',
  'Get-DistributionGroupMember': 'GET /distribution-groups/{identity}/members',
  'Add-DistributionGroupMember': 'POST /distribution-groups/{identity}/members',
  'Remove-DistributionGroupMember': 'DELETE /distribution-groups/{identity}/members/{member}',
  'Get-AcceptedDomain': 'GET /accepted-domains',
  'New-AcceptedDomain': 'POST /accepted-domains',
  'Get-TransportRule': 'GET /transport-rules',
  'New-TransportRule': 'POST /transport-rules',
  'Set-TransportRule': 'PUT /transport-rules/{identity}',
  'Remove-TransportRule': 'DELETE /transport-rules/{identity}',
  'Get-MailboxStatistics': 'GET /mailbox-statistics',
  'Get-ResourceMailbox': 'GET /resource-mailboxes',
};

adminEmsRouter.post('/cmdlet', async (req: Request, res: Response) => {
  const schema = z.object({
    Cmdlet: z.string(),
    Parameters: z.record(z.unknown()).default({}),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid cmdlet request' }); return; }

  const route = CMDLET_MAP[parsed.data.Cmdlet];
  if (!route) {
    res.status(501).json({
      error: `The term '${parsed.data.Cmdlet}' is not recognized as a valid EMS cmdlet.`,
      supportedCmdlets: Object.keys(CMDLET_MAP),
    });
    return;
  }

  res.json({
    Cmdlet: parsed.data.Cmdlet,
    Route: route,
    Parameters: parsed.data.Parameters,
    Note: 'Use the mapped REST endpoint for direct access.',
    SupportedCmdlets: Object.keys(CMDLET_MAP),
  });
});
