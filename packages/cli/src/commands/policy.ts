/**
 * `coremail policy …` — webmail policies (9.4, /api/v1/admin/webmail-policies):
 *   coremail policy show                                         server level
 *   coremail policy show --scope domain example.com
 *   coremail policy set --scope user alice@example.com --calendar off --external-images block
 *   coremail policy set --blocked-extensions exe,js,bat --max-upload-mb 20
 * Modules: --calendar --contacts --tasks --notes --rules --signatures --categories
 * --recover-items --change-password --themes --external-clients --app-passwords
 * --shared-mailboxes, each on | off | inherit (the server level is on | off only).
 * Values: --blocked-extensions / --save-only-extensions <list|inherit>,
 * --max-upload-mb <MB|inherit|none> (none = no own limit, server level only),
 * --external-images ask|contacts|block|inherit.
 */
import { Command } from 'commander';
import type { CoreMailClient } from '../client.js';
import { printJson, printTable } from '../output.js';
import { levelPath, parseScope, settingsForScope, type ProtocolScope } from './protocol.js';

export const FEATURES = [
  'calendar', 'contacts', 'tasks', 'notes', 'rules', 'signatures', 'categories', 'recoverItems',
  'changePassword', 'themes', 'externalClients', 'appPasswords', 'sharedMailboxes',
] as const;
export type Feature = typeof FEATURES[number];
type Setting = 'inherit' | 'on' | 'off';
const IMAGE_MODES = ['ask', 'contacts', 'block'] as const;
type Source = 'default' | 'global' | 'domain' | 'user';

interface ContentSettings {
  blockedExtensions: string[] | null;
  downloadOnlyExtensions: string[] | null;
  maxUploadMb: number | null;
  externalImages: string | null;
}
interface ContentPolicy { blockedExtensions: string[]; downloadOnlyExtensions: string[]; maxUploadMb: number | null; externalImages: string }

export interface PolicyView {
  level: ProtocolScope;
  id?: string;
  settings: { features: Record<Feature, Setting>; content: ContentSettings };
  inherited: { features: Record<Feature, boolean>; content: ContentPolicy };
  effective: { features: Record<Feature, boolean>; content: ContentPolicy };
  sources: { features: Record<Feature, Source>; content: Record<keyof ContentSettings, Source> };
  users?: number;
}

/** --recover-items → recoverItems (commander's option names). */
export const flagOf = (f: Feature): string => f.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export interface PolicyOptions extends Partial<Record<Feature, string>> {
  blockedExtensions?: string;
  saveOnlyExtensions?: string;
  maxUploadMb?: string;
  externalImages?: string;
}

function extensionList(raw: string, flag: string, scope: ProtocolScope): string[] | null {
  const v = raw.trim().toLowerCase();
  if (v === 'inherit') {
    if (scope === 'global') throw new Error(`--${flag}: inherit only with --scope domain|user`);
    return null;
  }
  if (v === '' || v === 'none') return [];
  return [...new Set(v.split(/[\s,;]+/).map((e) => e.replace(/^\.+/, '')).filter(Boolean))];
}

function uploadLimit(raw: string, scope: ProtocolScope): number | null {
  const v = raw.trim().toLowerCase();
  if (v === 'inherit' || v === 'none') {
    if ((v === 'inherit') === (scope === 'global')) {
      throw new Error(`--max-upload-mb: ${scope === 'global' ? 'none (no own limit) or MB' : 'inherit or MB'} on the ${scope} level`);
    }
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10_240) throw new Error(`--max-upload-mb: 1..10240 MB (got "${raw}")`);
  return n;
}

/** The PUT body from the options; at least one value is required. */
export function buildPolicyPatch(opts: PolicyOptions, scope: ProtocolScope): { features?: Partial<Record<Feature, Setting>>; content?: Partial<ContentSettings> } {
  const allowed = settingsForScope(scope);
  const features: Partial<Record<Feature, Setting>> = {};
  for (const f of FEATURES) {
    const v = opts[f]?.trim().toLowerCase();
    if (v === undefined) continue;
    if (!(allowed as readonly string[]).includes(v)) throw new Error(`--${flagOf(f)}: ${allowed.join(', ')} on the ${scope} level (got "${opts[f]}")`);
    features[f] = v as Setting;
  }
  const content: Partial<ContentSettings> = {};
  if (opts.blockedExtensions !== undefined) content.blockedExtensions = extensionList(opts.blockedExtensions, 'blocked-extensions', scope);
  if (opts.saveOnlyExtensions !== undefined) content.downloadOnlyExtensions = extensionList(opts.saveOnlyExtensions, 'save-only-extensions', scope);
  if (opts.maxUploadMb !== undefined) content.maxUploadMb = uploadLimit(opts.maxUploadMb, scope);
  if (opts.externalImages !== undefined) {
    const v = opts.externalImages.trim().toLowerCase();
    const modes: readonly string[] = scope === 'global' ? IMAGE_MODES : [...IMAGE_MODES, 'inherit'];
    if (!modes.includes(v)) throw new Error(`--external-images: ${modes.join(', ')} on the ${scope} level`);
    content.externalImages = v === 'inherit' ? null : v;
  }
  const out = {
    ...(Object.keys(features).length ? { features } : {}),
    ...(Object.keys(content).length ? { content } : {}),
  };
  if (!out.features && !out.content) throw new Error('Nothing to set — see coremail policy set --help');
  return out;
}

const onOff = (b: boolean) => (b ? 'on' : 'off');
const listText = (l: string[]) => (l.length ? l.join(', ') : '-');

/** One row per module and value: setting (inherit shows what it resolves to), effective value, deciding level. */
export function policyRows(view: PolicyView): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = FEATURES.map((f) => ({
    name: flagOf(f),
    setting: view.settings.features[f] === 'inherit' ? `inherit (${onOff(view.inherited.features[f])})` : view.settings.features[f],
    effective: onOff(view.effective.features[f]),
    source: view.sources.features[f],
  }));
  const c = view.settings.content;
  const e = view.effective.content;
  const show = (v: unknown, text: string) => (v === null && view.level !== 'global' ? `inherit (${text})` : text);
  rows.push(
    { name: 'blocked-extensions', setting: show(c.blockedExtensions, listText(view.inherited.content.blockedExtensions)), effective: listText(e.blockedExtensions), source: view.sources.content.blockedExtensions },
    { name: 'save-only-extensions', setting: show(c.downloadOnlyExtensions, listText(view.inherited.content.downloadOnlyExtensions)), effective: listText(e.downloadOnlyExtensions), source: view.sources.content.downloadOnlyExtensions },
    { name: 'max-upload-mb', setting: c.maxUploadMb ?? (view.level === 'global' ? 'none' : 'inherit'), effective: e.maxUploadMb ?? 'none', source: view.sources.content.maxUploadMb },
    { name: 'external-images', setting: c.externalImages ?? `inherit (${view.inherited.content.externalImages})`, effective: e.externalImages, source: view.sources.content.externalImages },
  );
  return rows;
}

const BASE = '/api/v1/admin/webmail-policies';

function print(view: PolicyView, json: boolean): void {
  if (json) { printJson(view); return; }
  printTable(policyRows(view), [
    { key: 'name', label: 'Policy' }, { key: 'setting', label: 'Setting' }, { key: 'effective', label: 'Effective' }, { key: 'source', label: 'Source' },
  ]);
  if (view.users !== undefined) process.stdout.write(`Accounts in scope: ${view.users}\n`);
}

export function registerPolicy(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const c = program.command('policy').description('Webmail policies: modules, attachments, external images (server, domain, mailbox)');
  const scopeOption = ['--scope <scope>', 'global | domain | user', 'global'] as const;

  c.command('show [target]').description('Show the policy of a level (target: domain name or mailbox address)')
    .option(...scopeOption)
    .action(async (target: string | undefined, opts: { scope: string }) => {
      print(await api().get<PolicyView>(await levelPath(api(), parseScope(opts.scope), target, BASE)), json());
    });

  const set = c.command('set [target]').description('Change values (only the given ones)').option(...scopeOption);
  for (const f of FEATURES) set.option(`--${flagOf(f)} <value>`, 'on | off | inherit (inherit: domain and user scope only)');
  set.option('--blocked-extensions <list>', 'file extensions, comma-separated | none | inherit');
  set.option('--save-only-extensions <list>', 'file extensions that are only downloaded | none | inherit');
  set.option('--max-upload-mb <value>', 'MB per attachment | none (server level) | inherit');
  set.option('--external-images <mode>', 'ask | contacts | block | inherit');
  set.action(async (target: string | undefined, opts: { scope: string } & PolicyOptions) => {
    const scope = parseScope(opts.scope);
    const patch = buildPolicyPatch(opts, scope);
    print(await api().put<PolicyView>(await levelPath(api(), scope, target, BASE), patch), json());
  });
}
