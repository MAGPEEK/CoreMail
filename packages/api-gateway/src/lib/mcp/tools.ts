/**
 * Admin MCP interface (10.3) — the tools (v1). docs/mcp.md lists them.
 *
 * Every tool is a thin adapter over the admin REST API: it validates its
 * arguments (zod; the JSON Schema of `tools/list` is generated from the same
 * schema), resolves names (an address, a domain name) to ids through the same
 * admin routes and calls the route(s) through `ctx.call` — dispatch.ts runs
 * them in-process as the token's admin, so role, management scope, redaction
 * and validation are exactly those of the BCP. A route answering ≥ 400 becomes
 * a tool error with the route's message; out-of-scope objects stay "not found".
 *
 * `available(role, scoped)` hides tools the admin's role can never use (the
 * route would refuse them anyway); read tokens never see `mode: 'write'` tools.
 * No tool deletes mailboxes or domains, reveals passwords or returns keys.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ACCESS_PROTOCOLS } from '@coremail/storage';
import { canAccess, hasAdminAction, USER_ROLES } from '../rbac.js';
import type { DispatchRequest, DispatchResponse } from './dispatch.js';

export interface ToolContext {
  call(req: DispatchRequest): Promise<DispatchResponse>;
  role: string;
  scoped: boolean;
}

export interface ToolTarget { type: string; id?: string; name?: string }

export interface ToolOutput {
  /** The result (JSON) — secrets are stripped and the size is capped by the caller. */
  data: unknown;
  target?: ToolTarget;
  /** Extra audit fields (never a secret). */
  audit?: Record<string, unknown>;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  mode: 'read' | 'write';
  /** Could the admin with `role` (scoped or not) use this tool at all? */
  available(role: string, scoped: boolean): boolean;
  input: z.ZodType<Record<string, unknown>>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

/** A route refused the call (status ≥ 400) or a name could not be resolved. */
export class ToolError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = 'ToolError';
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

const enc = encodeURIComponent;

/** The body of a 2xx answer; a ToolError with the route's message otherwise. */
export function expectOk(r: DispatchResponse): unknown {
  if (r.status >= 200 && r.status < 300) return r.body;
  const b = (r.body && typeof r.body === 'object' ? r.body : {}) as { error?: unknown; code?: unknown; details?: unknown };
  let message = typeof b.error === 'string' ? b.error : `Request refused (HTTP ${r.status})`;
  const first = Array.isArray(b.details) ? (b.details[0] as { message?: unknown; path?: unknown } | undefined) : undefined;
  if (first && typeof first.message === 'string' && !message.includes(first.message)) {
    const path = Array.isArray(first.path) && first.path.length ? ` (${first.path.join('.')})` : '';
    message = `${message}: ${first.message}${path}`;
  }
  throw new ToolError(message, r.status, typeof b.code === 'string' ? b.code : undefined);
}

const asArray = (v: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const lower = (v: unknown): string => str(v).trim().toLowerCase();
const read = (area: Parameters<typeof canAccess>[1]) => (role: string, scoped: boolean) => canAccess(role, area, 'GET', scoped);
const write = (area: Parameters<typeof canAccess>[1]) => (role: string, scoped: boolean) => canAccess(role, area, 'POST', scoped);
const READ_HINTS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE_HINTS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const ref = (what: string) => z.string().trim().min(1).max(320).describe(what);
const page = z.number().int().min(1).max(100_000).optional().describe('Page number, starting at 1');
const isoDate = z.string().trim().max(40).optional();

interface MailboxRef { kind: 'user' | 'shared'; id: string; email: string }

/** A user mailbox by id or address (management scope applies: others are "not found"). */
async function findUser(ctx: ToolContext, refText: string): Promise<MailboxRef | null> {
  const want = refText.trim().toLowerCase();
  if (!want.includes('@')) {
    const r = await ctx.call({ method: 'GET', path: `/mailboxes/${enc(refText.trim())}` });
    if (r.status === 404) return null;
    const u = expectOk(r) as Record<string, unknown>;
    return { kind: 'user', id: str(u['id']), email: str(u['email']) };
  }
  const rows = asArray(expectOk(await ctx.call({ method: 'GET', path: '/mailboxes' })));
  const hit = rows.find((u) => lower(u['email']) === want);
  return hit ? { kind: 'user', id: str(hit['id']), email: str(hit['email']) } : null;
}

async function resolveUser(ctx: ToolContext, refText: string): Promise<MailboxRef> {
  const u = await findUser(ctx, refText);
  if (!u) throw new ToolError(`Mailbox not found: ${refText}`, 404);
  return u;
}

/** A user or (address only) a shared mailbox. */
async function resolveAnyMailbox(ctx: ToolContext, refText: string): Promise<MailboxRef> {
  const u = await findUser(ctx, refText);
  if (u) return u;
  if (refText.includes('@')) {
    const r = expectOk(await ctx.call({ method: 'GET', path: '/shared-mailboxes', query: { search: refText.trim(), limit: 50 } })) as { items?: unknown };
    const hit = asArray(r.items).find((s) => lower(s['email']) === refText.trim().toLowerCase());
    if (hit) return { kind: 'shared', id: str(hit['id']), email: str(hit['email']) };
  }
  throw new ToolError(`Mailbox not found: ${refText}`, 404);
}

/** A domain by name or id (management scope applies). */
async function resolveDomain(ctx: ToolContext, refText: string): Promise<{ id: string; name: string }> {
  const want = refText.trim().toLowerCase().replace(/\.$/, '');
  const r = expectOk(await ctx.call({ method: 'GET', path: '/domains', query: { search: want, limit: 200 } })) as { domains?: unknown };
  const list = asArray(r.domains);
  const hit = list.find((d) => lower(d['name']) === want) ?? list.find((d) => str(d['id']) === refText.trim());
  if (hit) return { id: str(hit['id']), name: str(hit['name']) };
  if (!want.includes('.')) {
    const byId = await ctx.call({ method: 'GET', path: `/domains/${enc(refText.trim())}` });
    if (byId.status < 300) {
      const d = byId.body as Record<string, unknown>;
      return { id: str(d['id']), name: str(d['name']) };
    }
  }
  throw new ToolError(`Domain not found: ${refText}`, 404);
}

const pickMailbox = (u: Record<string, unknown>) => ({
  id: u['id'], email: u['email'], displayName: u['displayName'], role: u['role'], active: u['active'],
  quotaBytes: u['quotaBytes'], usedBytes: u['usedBytes'], lastLoginAt: u['lastLoginAt'] ?? null,
});

const pickAlias = (a: Record<string, unknown>) => {
  const user = a['targetUser'] as Record<string, unknown> | null | undefined;
  const shared = a['targetShared'] as Record<string, unknown> | null | undefined;
  return {
    id: a['id'], address: a['address'], active: a['active'], description: a['description'] || undefined,
    target: user ? user['email'] : shared ? shared['email'] : null,
    targetKind: user ? 'mailbox' : shared ? 'shared-mailbox' : null,
  };
};

const atLeastOne = (keys: string[]) => (o: Record<string, unknown>) => keys.some((k) => o[k] !== undefined);

/** A random initial password (base64url, 32 characters) for create_mailbox. */
export function generatePassword(): string {
  return randomBytes(24).toString('base64url');
}

const ROLE = z.enum(USER_ROLES);
const SWITCH = z.enum(['on', 'off', 'inherit']);
const PROTOCOL = z.enum(ACCESS_PROTOCOLS);
const LEVEL = z.enum(['server', 'domain', 'user']);

// ── read tools ────────────────────────────────────────────────────────────────

const serverStatus: McpTool = {
  name: 'server_status',
  title: 'Server status',
  description: 'CoreMail version and start time; with read access to the servers area also the health of the services '
    + '(database, Redis, object storage driver and state, mail listeners).',
  mode: 'read',
  available: read('dashboard'),
  input: z.object({}).strict(),
  annotations: READ_HINTS,
  async run(_args, ctx) {
    const version = expectOk(await ctx.call({ method: 'GET', path: '/dashboard/version' })) as Record<string, unknown>;
    if (!canAccess(ctx.role, 'servers', 'GET', ctx.scoped)) {
      return { data: { ...version, health: null, note: 'Service health needs read access to the servers area.' } };
    }
    const health = expectOk(await ctx.call({ method: 'GET', path: '/servers/health' }));
    return { data: { ...version, health } };
  },
};

const listDomains: McpTool = {
  name: 'list_domains',
  title: 'List domains',
  description: 'Hosted mail domains (name, active, primary, DKIM selector, number of mailboxes). Optional name search and paging.',
  mode: 'read',
  available: read('domains'),
  input: z.object({
    search: z.string().trim().max(253).optional().describe('Part of the domain name'),
    page,
    limit: z.number().int().min(1).max(200).optional().describe('Domains per page (default 50)'),
  }).strict(),
  annotations: READ_HINTS,
  async run(args, ctx) {
    const data = expectOk(await ctx.call({
      method: 'GET', path: '/domains',
      query: { search: args['search'] as string | undefined, page: args['page'] as number | undefined, limit: args['limit'] as number | undefined },
    }));
    return { data };
  },
};

const domainDnsCheck: McpTool = {
  name: 'domain_dns_check',
  title: 'Check the DNS records of a domain',
  description: 'Checks A, MX, SPF, DKIM, DMARC, autodiscover and PTR records of a domain with the server resolver and '
    + 'returns found vs. expected values plus the recommended client auto-setup records.',
  mode: 'read',
  available: read('domains'),
  input: z.object({ domain: ref('Domain name (e.g. example.com) or domain id') }).strict(),
  annotations: { ...READ_HINTS, openWorldHint: true },
  async run(args, ctx) {
    const d = await resolveDomain(ctx, str(args['domain']));
    const data = expectOk(await ctx.call({ method: 'GET', path: `/domains/${enc(d.id)}/dns-check` }));
    return { data, target: { type: 'domain', id: d.id, name: d.name } };
  },
};

const listMailboxes: McpTool = {
  name: 'list_mailboxes',
  title: 'List mailboxes',
  description: 'User mailboxes with role, active state, quota and usage. Filters: text in address or display name, '
    + 'domain, role, active. Paged (default 50 per page).',
  mode: 'read',
  available: read('recipients'),
  input: z.object({
    search: z.string().trim().max(200).optional().describe('Part of the address or display name'),
    domain: z.string().trim().max(253).optional().describe('Only addresses of this domain'),
    role: ROLE.optional(),
    active: z.boolean().optional(),
    page,
    limit: z.number().int().min(1).max(200).optional().describe('Mailboxes per page (default 50)'),
  }).strict(),
  annotations: READ_HINTS,
  async run(args, ctx) {
    const rows = asArray(expectOk(await ctx.call({ method: 'GET', path: '/mailboxes' })));
    const search = lower(args['search']);
    const domain = lower(args['domain']).replace(/^@/, '');
    const filtered = rows.filter((u) => (!search || lower(u['email']).includes(search) || lower(u['displayName']).includes(search))
      && (!domain || lower(u['email']).endsWith(`@${domain}`))
      && (args['role'] === undefined || u['role'] === args['role'])
      && (args['active'] === undefined || u['active'] === args['active']));
    const limit = (args['limit'] as number | undefined) ?? 50;
    const p = (args['page'] as number | undefined) ?? 1;
    return { data: { total: filtered.length, page: p, limit, items: filtered.slice((p - 1) * limit, p * limit).map(pickMailbox) } };
  },
};

const getMailbox: McpTool = {
  name: 'get_mailbox',
  title: 'Mailbox details',
  description: 'One user mailbox by address or id: role, active state, quota levels and usage, folders with counts, aliases.',
  mode: 'read',
  available: read('recipients'),
  input: z.object({ mailbox: ref('Mailbox address or id') }).strict(),
  annotations: READ_HINTS,
  async run(args, ctx) {
    const u = await resolveUser(ctx, str(args['mailbox']));
    const detail = expectOk(await ctx.call({ method: 'GET', path: `/mailboxes/${enc(u.id)}` })) as Record<string, unknown>;
    const aliases = asArray(expectOk(await ctx.call({ method: 'GET', path: `/mailboxes/${enc(u.id)}/aliases` }))).map(pickAlias);
    const { photo: _photo, ...rest } = detail;
    return { data: { ...rest, aliases }, target: { type: 'mailbox', id: u.id, name: u.email } };
  },
};

const listAliases: McpTool = {
  name: 'list_aliases',
  title: 'List aliases',
  description: 'Alias addresses and the mailbox they deliver to — all, or those of one user / shared mailbox. Optional text search.',
  mode: 'read',
  available: read('recipients'),
  input: z.object({
    mailbox: z.string().trim().min(1).max(320).optional().describe('Only aliases of this mailbox (address or id)'),
    search: z.string().trim().max(320).optional().describe('Part of the alias address'),
  }).strict(),
  annotations: READ_HINTS,
  async run(args, ctx) {
    let rows: Array<Record<string, unknown>>;
    let target: ToolTarget | undefined;
    if (args['mailbox'] !== undefined) {
      const m = await resolveAnyMailbox(ctx, str(args['mailbox']));
      const path = m.kind === 'user' ? `/mailboxes/${enc(m.id)}/aliases` : `/shared-mailboxes/${enc(m.id)}/aliases`;
      rows = asArray(expectOk(await ctx.call({ method: 'GET', path })));
      target = { type: m.kind === 'user' ? 'mailbox' : 'shared-mailbox', id: m.id, name: m.email };
    } else {
      rows = asArray(expectOk(await ctx.call({ method: 'GET', path: '/aliases' })));
    }
    const search = lower(args['search']);
    const items = rows.filter((a) => !search || lower(a['address']).includes(search)).map(pickAlias);
    return { data: { total: items.length, items }, ...(target ? { target } : {}) };
  },
};

const protocolAccess: McpTool = {
  name: 'protocol_access',
  title: 'Protocol access switches',
  description: 'The protocol switches (imap, pop3, smtp, activesync, jmap, dav, webmail, mapi) of the server, a domain or '
    + 'a user mailbox: own settings (on | off | inherit) and the effective result.',
  mode: 'read',
  available: (role, scoped) => canAccess(role, 'servers', 'GET', scoped) || canAccess(role, 'recipients', 'GET', scoped)
    || canAccess(role, 'domains', 'GET', scoped),
  input: z.object({
    level: LEVEL.describe('server | domain | user'),
    target: z.string().trim().min(1).max(320).optional().describe('Domain name (level domain) or mailbox address (level user)'),
  }).strict().refine((o) => o['level'] === 'server' || o['target'] !== undefined, { message: 'target is required for the domain and user level' }),
  annotations: READ_HINTS,
  async run(args, ctx) {
    const level = args['level'];
    if (level === 'server') return { data: expectOk(await ctx.call({ method: 'GET', path: '/protocol-access' })) };
    if (level === 'domain') {
      const d = await resolveDomain(ctx, str(args['target']));
      return { data: expectOk(await ctx.call({ method: 'GET', path: `/protocol-access/domains/${enc(d.id)}` })), target: { type: 'domain', id: d.id, name: d.name } };
    }
    const u = await resolveUser(ctx, str(args['target']));
    return { data: expectOk(await ctx.call({ method: 'GET', path: `/protocol-access/users/${enc(u.id)}` })), target: { type: 'mailbox', id: u.id, name: u.email } };
  },
};

const queueStatus: McpTool = {
  name: 'queue_status',
  title: 'Outbound queue status',
  description: 'Counts of the outbound mail queue (waiting, active, delayed, failed, completed) and the newest failed jobs '
    + '(sender, recipients, attempts, failure reason).',
  mode: 'read',
  available: read('servers'),
  input: z.object({
    failedJobs: z.number().int().min(0).max(50).optional().describe('Newest failed jobs to include (default 10, 0 = none)'),
  }).strict(),
  annotations: READ_HINTS,
  async run(args, ctx) {
    const stats = expectOk(await ctx.call({ method: 'GET', path: '/queues/stats' }));
    const n = (args['failedJobs'] as number | undefined) ?? 10;
    if (n === 0) return { data: { stats } };
    const jobs = expectOk(await ctx.call({ method: 'GET', path: '/queues/jobs', query: { state: 'failed', limit: n } })) as { jobs?: unknown };
    const failed = asArray(Array.isArray(jobs) ? jobs : jobs.jobs).map((j) => ({
      id: j['id'], from: j['from'], to: j['to'], attemptsMade: j['attemptsMade'], createdAt: j['createdAt'],
      finishedAt: j['finishedAt'], failedReason: j['failedReason'],
    }));
    return { data: { stats, failed } };
  },
};

const TRACE_STATUS = z.enum(['ACCEPTED', 'DELIVERED', 'JUNK', 'QUARANTINE', 'REJECTED', 'DEFERRED']);

const messageTraceSearch: McpTool = {
  name: 'message_trace_search',
  title: 'Search the message trace',
  description: 'Mail-flow log entries (newest first) filtered by sender, recipient, subject (substrings), status and time '
    + 'range (ISO 8601). Paged (default 25). Use message_trace_detail with an entry id for the full path.',
  mode: 'read',
  available: read('compliance'),
  input: z.object({
    sender: z.string().trim().max(320).optional(),
    recipient: z.string().trim().max(320).optional(),
    subject: z.string().trim().max(200).optional(),
    status: TRACE_STATUS.optional(),
    from: isoDate.describe('Start of the time range (ISO 8601)'),
    to: isoDate.describe('End of the time range (ISO 8601)'),
    page,
    limit: z.number().int().min(1).max(100).optional().describe('Entries per page (default 25)'),
  }).strict(),
  annotations: READ_HINTS,
  async run(args, ctx) {
    const query: Record<string, string | number | undefined> = {
      sender: args['sender'] as string | undefined, recipient: args['recipient'] as string | undefined,
      subject: args['subject'] as string | undefined, status: args['status'] as string | undefined,
      from: args['from'] as string | undefined, to: args['to'] as string | undefined,
      page: args['page'] as number | undefined, limit: (args['limit'] as number | undefined) ?? 25,
    };
    return { data: expectOk(await ctx.call({ method: 'GET', path: '/message-trace', query })) };
  },
};

const messageTraceDetail: McpTool = {
  name: 'message_trace_detail',
  title: 'Message trace details',
  description: 'One mail-flow entry with its processing stages, related entries of the same message and the delivery path.',
  mode: 'read',
  available: read('compliance'),
  input: z.object({ id: z.string().trim().min(1).max(64).describe('Entry id from message_trace_search') }).strict(),
  annotations: READ_HINTS,
  async run(args, ctx) {
    const id = str(args['id']);
    return { data: expectOk(await ctx.call({ method: 'GET', path: `/message-trace/${enc(id)}` })), target: { type: 'message-trace', id } };
  },
};

const listCertificates: McpTool = {
  name: 'list_certificates',
  title: 'List certificates',
  description: 'TLS certificates: names, domains, services, type, status, validity, renewal and HTTPS / mail-protocol use. Never key material.',
  mode: 'read',
  available: read('servers'),
  input: z.object({}).strict(),
  annotations: READ_HINTS,
  async run(_args, ctx) {
    const rows = asArray(expectOk(await ctx.call({ method: 'GET', path: '/certificates' })));
    return {
      data: rows.map((c) => ({
        id: c['id'], name: c['name'], domains: c['domains'], services: c['services'], type: c['type'], status: c['status'],
        issuedAt: c['issuedAt'], expiresAt: c['expiresAt'], autoRenew: c['autoRenew'], staging: c['acmeStaging'],
        isActiveHttps: c['isActiveHttps'], isActiveProtocol: c['isActiveProtocol'], lastError: c['lastError'] ?? null,
      })),
    };
  },
};

const auditLogSearch: McpTool = {
  name: 'audit_log_search',
  title: 'Search the audit log',
  description: 'Admin audit entries (newest first) filtered by action, actor address, target, free text, success and time range (ISO 8601).',
  mode: 'read',
  available: read('compliance'),
  input: z.object({
    action: z.string().trim().max(200).optional().describe('Action, e.g. mcp.tool.create_mailbox'),
    actorEmail: z.string().trim().max(320).optional(),
    targetType: z.string().trim().max(100).optional(),
    targetId: z.string().trim().max(100).optional(),
    searchText: z.string().trim().max(200).optional(),
    success: z.boolean().optional(),
    from: isoDate.describe('Start of the time range (ISO 8601)'),
    to: isoDate.describe('End of the time range (ISO 8601)'),
    limit: z.number().int().min(1).max(100).optional().describe('Entries (default 25)'),
    offset: z.number().int().min(0).max(1_000_000).optional(),
  }).strict(),
  annotations: READ_HINTS,
  async run(args, ctx) {
    const query: Record<string, string | number | undefined> = {};
    for (const k of ['action', 'actorEmail', 'targetType', 'targetId', 'searchText', 'from', 'to', 'offset'] as const) {
      const v = args[k];
      if (v !== undefined) query[k] = v as string | number;
    }
    if (args['success'] !== undefined) query['success'] = String(args['success']);
    query['limit'] = (args['limit'] as number | undefined) ?? 25;
    return { data: expectOk(await ctx.call({ method: 'GET', path: '/audit-log', query })) };
  },
};

// ── write tools ───────────────────────────────────────────────────────────────

const createMailbox: McpTool = {
  name: 'create_mailbox',
  title: 'Create a mailbox',
  description: 'Creates a user mailbox in a hosted domain. Without `password` a random initial password is generated and '
    + 'returned once in `initialPassword` (pass it on securely). Admin roles can only be given by Organization Management.',
  mode: 'write',
  available: write('recipients'),
  input: z.object({
    email: z.string().trim().toLowerCase().email().max(320),
    displayName: z.string().trim().min(1).max(200),
    password: z.string().min(1).max(128).optional().describe('Initial password (server password policy applies)'),
    role: ROLE.optional().describe('Default USER'),
    quotaBytes: z.number().int().min(0).optional().describe('Mailbox size limit in bytes (default 5 GiB)'),
  }).strict(),
  annotations: WRITE_HINTS,
  async run(args, ctx) {
    const email = str(args['email']);
    const domain = await resolveDomain(ctx, email.slice(email.lastIndexOf('@') + 1));
    const generated = args['password'] === undefined;
    const password = generated ? generatePassword() : str(args['password']);
    const created = expectOk(await ctx.call({
      method: 'POST', path: '/mailboxes',
      body: {
        email, displayName: args['displayName'], password, domainId: domain.id,
        ...(args['role'] !== undefined ? { role: args['role'] } : {}),
        ...(args['quotaBytes'] !== undefined ? { quotaBytes: args['quotaBytes'] } : {}),
      },
    })) as Record<string, unknown>;
    return {
      data: {
        ...created,
        ...(generated ? { initialPassword: password, note: 'Initial password shown only now — it is not stored in readable form.' } : {}),
      },
      target: { type: 'mailbox', id: str(created['id']), name: str(created['email']) },
      audit: { passwordGenerated: generated },
    };
  },
};

const updateMailbox: McpTool = {
  name: 'update_mailbox',
  title: 'Update a mailbox',
  description: 'Changes display name, quota, active state or role of a user mailbox (only the given fields). '
    + 'Deactivating or changing the role ends all sessions of the account. Roles: Organization Management only.',
  mode: 'write',
  available: (role, scoped) => write('recipients')(role, scoped) || hasAdminAction(role, 'toggleActive', scoped),
  input: z.object({
    mailbox: ref('Mailbox address or id'),
    displayName: z.string().trim().min(1).max(200).optional(),
    quotaBytes: z.number().int().min(0).optional(),
    active: z.boolean().optional(),
    role: ROLE.optional(),
  }).strict().refine(atLeastOne(['displayName', 'quotaBytes', 'active', 'role']), { message: 'Give at least one field to change' }),
  annotations: { ...WRITE_HINTS, idempotentHint: true },
  async run(args, ctx) {
    const u = await resolveUser(ctx, str(args['mailbox']));
    const body: Record<string, unknown> = {};
    for (const k of ['displayName', 'quotaBytes', 'active', 'role'] as const) if (args[k] !== undefined) body[k] = args[k];
    const data = expectOk(await ctx.call({ method: 'PUT', path: `/mailboxes/${enc(u.id)}`, body }));
    return { data, target: { type: 'mailbox', id: u.id, name: u.email } };
  },
};

const addAlias: McpTool = {
  name: 'add_alias',
  title: 'Add an alias',
  description: 'Adds an alias address that delivers into a user or shared mailbox. The alias must be in a hosted domain and not in use.',
  mode: 'write',
  available: write('recipients'),
  input: z.object({
    mailbox: ref('Target mailbox address or id (user or shared mailbox)'),
    alias: z.string().trim().toLowerCase().email().max(320).describe('The new alias address'),
    description: z.string().trim().max(200).optional(),
  }).strict(),
  annotations: WRITE_HINTS,
  async run(args, ctx) {
    const m = await resolveAnyMailbox(ctx, str(args['mailbox']));
    const path = m.kind === 'user' ? `/mailboxes/${enc(m.id)}/aliases` : `/shared-mailboxes/${enc(m.id)}/aliases`;
    const created = expectOk(await ctx.call({
      method: 'POST', path,
      body: { address: args['alias'], ...(args['description'] !== undefined ? { description: args['description'] } : {}) },
    })) as Record<string, unknown>;
    return { data: pickAlias(created), target: { type: 'alias', id: str(created['id']), name: str(created['address']) } };
  },
};

const removeAlias: McpTool = {
  name: 'remove_alias',
  title: 'Remove an alias',
  description: 'Removes an alias address (by address or id). The mailbox itself is not changed.',
  mode: 'write',
  available: write('recipients'),
  input: z.object({ alias: ref('Alias address or id') }).strict(),
  annotations: { ...WRITE_HINTS, destructiveHint: true, idempotentHint: true },
  async run(args, ctx) {
    const want = str(args['alias']).trim().toLowerCase();
    let id = str(args['alias']).trim();
    if (want.includes('@')) {
      const hit = asArray(expectOk(await ctx.call({ method: 'GET', path: '/aliases' }))).find((a) => lower(a['address']) === want);
      if (!hit) throw new ToolError(`Alias not found: ${want}`, 404);
      id = str(hit['id']);
    }
    expectOk(await ctx.call({ method: 'DELETE', path: `/aliases/${enc(id)}` }));
    return { data: { ok: true, removed: want.includes('@') ? want : id }, target: { type: 'alias', id, ...(want.includes('@') ? { name: want } : {}) } };
  },
};

const setQuota: McpTool = {
  name: 'set_quota',
  title: 'Set the mailbox quota',
  description: 'Sets the size limit of a user mailbox in bytes, optionally with the warning and the prohibit-send level '
    + '(null = server default percentage).',
  mode: 'write',
  available: write('recipients'),
  input: z.object({
    mailbox: ref('Mailbox address or id'),
    quotaBytes: z.number().int().min(0).describe('Size limit (receiving stops above it)'),
    warningBytes: z.number().int().min(0).nullable().optional().describe('Warning level; null = server default'),
    prohibitSendBytes: z.number().int().min(0).nullable().optional().describe('Sending stops above it; null = server default'),
  }).strict(),
  annotations: { ...WRITE_HINTS, idempotentHint: true },
  async run(args, ctx) {
    const u = await resolveUser(ctx, str(args['mailbox']));
    const body: Record<string, unknown> = { quotaBytes: args['quotaBytes'] };
    if (args['warningBytes'] !== undefined) body['quotaWarningBytes'] = args['warningBytes'];
    if (args['prohibitSendBytes'] !== undefined) body['quotaProhibitSendBytes'] = args['prohibitSendBytes'];
    const data = expectOk(await ctx.call({ method: 'PUT', path: `/mailboxes/${enc(u.id)}`, body }));
    return { data, target: { type: 'mailbox', id: u.id, name: u.email } };
  },
};

const setProtocolAccess: McpTool = {
  name: 'set_protocol_access',
  title: 'Set protocol access switches',
  description: 'Turns protocols on or off for the server (on | off), a domain or a user mailbox (on | off | inherit). '
    + 'Only the given protocols change; connections of a protocol that is now off end.',
  mode: 'write',
  available: (role, scoped) => canAccess(role, 'servers', 'PUT', scoped) || canAccess(role, 'recipients', 'PUT', scoped),
  input: z.object({
    level: LEVEL.describe('server | domain | user'),
    target: z.string().trim().min(1).max(320).optional().describe('Domain name (level domain) or mailbox address (level user)'),
    switches: z.partialRecord(PROTOCOL, SWITCH).describe('protocol → on | off | inherit, e.g. {"pop3":"off"}'),
  }).strict()
    .refine((o) => o['level'] === 'server' || o['target'] !== undefined, { message: 'target is required for the domain and user level' })
    .refine((o) => Object.keys((o['switches'] ?? {}) as object).length > 0, { message: 'Give at least one protocol switch' }),
  annotations: { ...WRITE_HINTS, idempotentHint: true },
  async run(args, ctx) {
    const switches = args['switches'] as Record<string, string>;
    if (args['level'] === 'server') {
      return { data: expectOk(await ctx.call({ method: 'PUT', path: '/protocol-access', body: switches })), target: { type: 'settings', name: 'server' } };
    }
    if (args['level'] === 'domain') {
      const d = await resolveDomain(ctx, str(args['target']));
      return { data: expectOk(await ctx.call({ method: 'PUT', path: `/protocol-access/domains/${enc(d.id)}`, body: switches })), target: { type: 'domain', id: d.id, name: d.name } };
    }
    const u = await resolveUser(ctx, str(args['target']));
    return { data: expectOk(await ctx.call({ method: 'PUT', path: `/protocol-access/users/${enc(u.id)}`, body: switches })), target: { type: 'mailbox', id: u.id, name: u.email } };
  },
};

const createDomain: McpTool = {
  name: 'create_domain',
  title: 'Create a domain',
  description: 'Adds a hosted mail domain (a DKIM key is generated; publish the DNS records from domain_dns_check afterwards).',
  mode: 'write',
  available: write('domains'),
  input: z.object({
    name: z.string().trim().toLowerCase().min(3).max(253).describe('Domain name, e.g. example.com'),
    dkimSelector: z.string().trim().toLowerCase().min(1).max(63).optional().describe('DKIM selector (default coremail)'),
  }).strict(),
  annotations: WRITE_HINTS,
  async run(args, ctx) {
    const created = expectOk(await ctx.call({
      method: 'POST', path: '/domains',
      body: { name: args['name'], ...(args['dkimSelector'] !== undefined ? { dkimSelector: args['dkimSelector'] } : {}) },
    })) as Record<string, unknown>;
    return { data: created, target: { type: 'domain', id: str(created['id']), name: str(created['name']) } };
  },
};

const LIST_TYPE = z.enum(['BLOCK', 'ALLOW']);
const LIST_SCOPE = z.enum(['GLOBAL', 'DOMAIN', 'USER']);
const PATTERN_TYPE = z.enum(['EXACT', 'WILDCARD', 'REGEX']);

const senderListAdd: McpTool = {
  name: 'sender_list_add',
  title: 'Add a sender list entry',
  description: 'Blocks (BLOCK) or allows (ALLOW) a sender address or domain pattern — for the whole server (GLOBAL), '
    + 'one domain (DOMAIN, target = domain name) or one mailbox (USER, target = address).',
  mode: 'write',
  available: write('hygiene'),
  input: z.object({
    listType: LIST_TYPE,
    scope: LIST_SCOPE.optional().describe('Default GLOBAL'),
    target: z.string().trim().max(320).optional().describe('Domain name (DOMAIN) or mailbox address (USER); empty for GLOBAL'),
    patternType: PATTERN_TYPE.optional().describe('Default EXACT'),
    pattern: z.string().trim().min(1).max(254).describe('Sender address, @domain or pattern'),
    comment: z.string().trim().max(500).optional(),
  }).strict(),
  annotations: WRITE_HINTS,
  async run(args, ctx) {
    const body: Record<string, unknown> = {
      listType: args['listType'], scope: args['scope'] ?? 'GLOBAL', target: args['target'] ?? '',
      patternType: args['patternType'] ?? 'EXACT', pattern: args['pattern'], comment: args['comment'] ?? '',
    };
    const created = expectOk(await ctx.call({ method: 'POST', path: '/security/sender-lists', body })) as Record<string, unknown>;
    return {
      data: {
        id: created['id'], listType: created['listType'], scope: created['scope'], target: created['target'] ?? '',
        patternType: created['patternType'], pattern: created['pattern'], comment: created['comment'], active: created['active'],
      },
      target: { type: 'sender-list', id: str(created['id']), name: str(created['pattern']) },
    };
  },
};

const senderListRemove: McpTool = {
  name: 'sender_list_remove',
  title: 'Remove a sender list entry',
  description: 'Removes a sender list entry by id, or by list type + pattern (+ scope and target when not GLOBAL).',
  mode: 'write',
  available: write('hygiene'),
  input: z.object({
    id: z.string().trim().min(1).max(64).optional(),
    listType: LIST_TYPE.optional(),
    scope: LIST_SCOPE.optional().describe('Default GLOBAL'),
    target: z.string().trim().max(320).optional(),
    pattern: z.string().trim().min(1).max(254).optional(),
  }).strict().refine((o) => o['id'] !== undefined || (o['listType'] !== undefined && o['pattern'] !== undefined), {
    message: 'Give the id, or listType and pattern',
  }),
  annotations: { ...WRITE_HINTS, destructiveHint: true, idempotentHint: true },
  async run(args, ctx) {
    let id = str(args['id']);
    let label = id;
    if (!id) {
      const scope = (args['scope'] as string | undefined) ?? 'GLOBAL';
      const target = lower(args['target']);
      const pattern = lower(args['pattern']);
      const rows = asArray(expectOk(await ctx.call({ method: 'GET', path: '/security/sender-lists' })));
      const hits = rows.filter((r) => r['listType'] === args['listType'] && r['scope'] === scope
        && lower(r['pattern']) === pattern && (scope === 'GLOBAL' || lower(r['target']) === target));
      if (hits.length === 0) throw new ToolError('Sender list entry not found', 404);
      if (hits.length > 1) throw new ToolError(`Several entries match — remove by id: ${hits.map((h) => str(h['id'])).join(', ')}`, 409);
      id = str(hits[0]!['id']);
      label = str(hits[0]!['pattern']);
    }
    expectOk(await ctx.call({ method: 'DELETE', path: `/security/sender-lists/${enc(id)}` }));
    return { data: { ok: true, removed: id }, target: { type: 'sender-list', id, ...(label ? { name: label } : {}) } };
  },
};

const assignRetentionPolicy: McpTool = {
  name: 'assign_retention_policy',
  title: 'Assign a retention policy',
  description: 'Assigns a retention policy (by name or id) to all mailboxes (GLOBAL), a domain (DOMAIN) or one mailbox (USER).',
  mode: 'write',
  available: (role, scoped) => canAccess(role, 'compliance', 'POST', scoped) && !scoped,
  input: z.object({
    policy: ref('Retention policy name or id'),
    target: z.enum(['GLOBAL', 'DOMAIN', 'USER']),
    domain: z.string().trim().min(1).max(253).optional().describe('Domain name (target DOMAIN)'),
    mailbox: z.string().trim().min(1).max(320).optional().describe('Mailbox address (target USER)'),
  }).strict()
    .refine((o) => o['target'] !== 'DOMAIN' || o['domain'] !== undefined, { message: 'domain is required for target DOMAIN' })
    .refine((o) => o['target'] !== 'USER' || o['mailbox'] !== undefined, { message: 'mailbox is required for target USER' }),
  annotations: WRITE_HINTS,
  async run(args, ctx) {
    const policies = asArray(expectOk(await ctx.call({ method: 'GET', path: '/compliance/retention' })));
    const want = str(args['policy']).trim();
    const policy = policies.find((p) => str(p['id']) === want) ?? policies.find((p) => lower(p['name']) === want.toLowerCase());
    if (!policy) {
      const names = policies.map((p) => str(p['name'])).filter(Boolean).slice(0, 30);
      throw new ToolError(`Unknown retention policy: ${want}${names.length ? ` (available: ${names.join(', ')})` : ''}`, 404);
    }
    let targetId = '';
    let targetName = 'all mailboxes';
    if (args['target'] === 'DOMAIN') {
      targetId = lower(args['domain']);
      targetName = targetId;
    } else if (args['target'] === 'USER') {
      const email = lower(args['mailbox']);
      const t = expectOk(await ctx.call({ method: 'GET', path: '/compliance/retention/targets', query: { q: email } })) as { users?: unknown };
      const user = asArray(t.users).find((u) => lower(u['email']) === email);
      if (!user) throw new ToolError(`Mailbox not found: ${email}`, 404);
      targetId = str(user['id']);
      targetName = email;
    }
    const created = expectOk(await ctx.call({
      method: 'POST', path: `/compliance/retention/${enc(str(policy['id']))}/assignments`,
      body: { target: args['target'], ...(targetId ? { targetId } : {}) },
    })) as Record<string, unknown>;
    return {
      data: { ...created, policyName: policy['name'], targetName },
      target: { type: 'retention-policy', id: str(policy['id']), name: str(policy['name']) },
      audit: { assignedTo: `${String(args['target'])}:${targetName}` },
    };
  },
};

/** All tools (v1), in the order `tools/list` returns them. */
export const MCP_TOOLS: readonly McpTool[] = [
  serverStatus, listDomains, domainDnsCheck, listMailboxes, getMailbox, listAliases, protocolAccess, queueStatus,
  messageTraceSearch, messageTraceDetail, listCertificates, auditLogSearch,
  createMailbox, updateMailbox, addAlias, removeAlias, setQuota, setProtocolAccess, createDomain,
  senderListAdd, senderListRemove, assignRetentionPolicy,
];

/** The tools a token may list and call: its mode, and what the admin's role can use at all. */
export function toolsFor(mode: 'read' | 'write', role: string, scoped: boolean): McpTool[] {
  return MCP_TOOLS.filter((t) => (mode === 'write' || t.mode === 'read') && t.available(role, scoped));
}

/** Pure: JSON Schema of a tool's input (from its zod schema; `$schema` and the safe-integer bounds dropped). */
export function inputSchemaOf(tool: McpTool): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === '$schema') continue;
      if ((k === 'minimum' && x === Number.MIN_SAFE_INTEGER) || (k === 'maximum' && x === Number.MAX_SAFE_INTEGER)) continue;
      out[k] = clean(x);
    }
    return out;
  };
  const out = clean(schema) as Record<string, unknown>;
  if (out['type'] !== 'object') out['type'] = 'object';
  return out;
}

/** The `tools/list` entry of a tool. */
export function describeTool(tool: McpTool): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: inputSchemaOf(tool),
    annotations: { title: tool.title, ...tool.annotations },
  };
}
