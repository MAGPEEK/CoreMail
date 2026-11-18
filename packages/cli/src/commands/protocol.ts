/**
 * `coremail protocol …` — per-protocol access switches (9.4, /api/v1/admin/protocol-access):
 *   coremail protocol show                                  server level
 *   coremail protocol show --scope domain example.com       domain level
 *   coremail protocol set  --scope user alice@example.com --imap off --webmail inherit
 * Switches: --imap --pop3 --smtp --activesync --jmap --dav --webmail --mapi, each
 * on | off | inherit (the server level is on | off only). The server-level JMAP
 * switch is the same as `coremail connector enable|disable jmap`.
 */
import { Command } from 'commander';
import { resolveDomain, resolveUser, type CoreMailClient } from '../client.js';
import { printJson, printTable } from '../output.js';

export const PROTOCOLS = ['imap', 'pop3', 'smtp', 'activesync', 'jmap', 'dav', 'webmail', 'mapi'] as const;
export type Protocol = typeof PROTOCOLS[number];
type Setting = 'inherit' | 'on' | 'off';
export type ProtocolScope = 'global' | 'domain' | 'user';

export interface ProtocolView {
  level: ProtocolScope;
  id?: string;
  settings: Record<Protocol, Setting>;
  inherited: Record<Protocol, boolean>;
  effective: Record<Protocol, boolean>;
  changedUsers?: number;
}

export function parseScope(raw: string | undefined): ProtocolScope {
  const s = (raw ?? 'global').toLowerCase();
  if (s === 'global' || s === 'domain' || s === 'user') return s;
  throw new Error(`Invalid --scope: ${raw} (global, domain or user)`);
}

/** The values a level accepts: the server level is two-state (nothing to inherit from). */
export function settingsForScope(scope: ProtocolScope): readonly Setting[] {
  return scope === 'global' ? ['on', 'off'] : ['inherit', 'on', 'off'];
}

/** The PUT body from the --<protocol> options; at least one is required. */
export function buildProtocolPatch(opts: Partial<Record<Protocol, string>>, scope: ProtocolScope): Partial<Record<Protocol, Setting>> {
  const allowed = settingsForScope(scope);
  const out: Partial<Record<Protocol, Setting>> = {};
  for (const p of PROTOCOLS) {
    const v = opts[p]?.trim().toLowerCase();
    if (v === undefined) continue;
    if (!(allowed as readonly string[]).includes(v)) {
      throw new Error(`--${p}: ${allowed.join(', ')} on the ${scope} level (got "${opts[p]}")`);
    }
    out[p] = v as Setting;
  }
  if (Object.keys(out).length === 0) throw new Error(`Nothing to set — use ${PROTOCOLS.map((p) => `--${p}`).join(', ')}`);
  return out;
}

/** One row per protocol: setting (inherit shows what it resolves to), effective value. */
export function protocolRows(view: ProtocolView): Array<Record<string, unknown>> {
  const onOff = (b: boolean) => (b ? 'on' : 'off');
  return PROTOCOLS.map((p) => ({
    protocol: p,
    setting: view.settings[p] === 'inherit' ? `inherit (${onOff(view.inherited[p])})` : view.settings[p],
    effective: onOff(view.effective[p]),
  }));
}

/** API path of a level below `base` (server, domain by name, mailbox by address) — also `coremail policy`. */
export async function levelPath(api: CoreMailClient, scope: ProtocolScope, target: string | undefined, base = '/api/v1/admin/protocol-access'): Promise<string> {
  if (scope === 'global') return base;
  if (!target) throw new Error(`--scope ${scope} needs a ${scope === 'domain' ? 'domain name' : 'mailbox address'}`);
  if (scope === 'domain') return `${base}/domains/${(await resolveDomain(api, target)).id}`;
  return `${base}/users/${(await resolveUser(api, target)).id}`;
}

function print(view: ProtocolView, json: boolean): void {
  if (json) { printJson(view); return; }
  printTable(protocolRows(view), [
    { key: 'protocol', label: 'Protocol' }, { key: 'setting', label: 'Setting' }, { key: 'effective', label: 'Effective' },
  ]);
  if (view.changedUsers !== undefined) process.stdout.write(`Accounts with changed access: ${view.changedUsers}\n`);
}

export function registerProtocol(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const c = program.command('protocol').description('Per-protocol access switches (server, domain, mailbox)');
  const scopeOption = ['--scope <scope>', 'global | domain | user', 'global'] as const;

  c.command('show [target]').description('Show the switches of a level (target: domain name or mailbox address)')
    .option(...scopeOption)
    .action(async (target: string | undefined, opts: { scope: string }) => {
      const path = await levelPath(api(), parseScope(opts.scope), target);
      print(await api().get<ProtocolView>(path), json());
    });

  const set = c.command('set [target]').description('Change switches: --imap on|off|inherit … (only the given ones)')
    .option(...scopeOption);
  for (const p of PROTOCOLS) set.option(`--${p} <value>`, 'on | off | inherit (inherit: domain and user scope only)');
  set.action(async (target: string | undefined, opts: { scope: string } & Partial<Record<Protocol, string>>) => {
    const scope = parseScope(opts.scope);
    const patch = buildProtocolPatch(opts, scope);
    const path = await levelPath(api(), scope, target);
    print(await api().put<ProtocolView>(path, patch), json());
  });
}
