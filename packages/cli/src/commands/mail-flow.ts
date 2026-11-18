/**
 * 9.4 per-mailbox mail flow and Shared Mailbox send settings:
 *
 *   coremail mailbox flow <email|id> [options]   user mailbox
 *   coremail shared flow <email|id> [options]    shared mailbox (no send limits)
 *   coremail shared sent-copy <email|id> [--send-as on|off] [--on-behalf on|off]
 *
 * Without options `flow` shows the settings. Talks to
 * /api/v1/admin/{mailboxes,shared-mailboxes}/:id/mail-flow (docs/mailbox-management.md).
 */
import type { Command } from 'commander';
import { resolveShared, resolveUser, type CoreMailClient } from '../client.js';
import { fail, printJson, printTable } from '../output.js';

export interface FlowOptions {
  hideGal?: boolean;
  showGal?: boolean;
  forward?: string;
  keepCopy?: string;
  acceptFrom?: string;
  rejectFrom?: string;
  maxSend?: string;
  maxReceive?: string;
  maxRecipients?: string;
}

const NONE = new Set(['none', 'off', '-', '']);

function onOff(flag: string, v: string): boolean {
  const s = v.trim().toLowerCase();
  if (s === 'on' || s === 'true' || s === 'yes') return true;
  if (s === 'off' || s === 'false' || s === 'no') return false;
  return fail(`${flag}: on or off`);
}

function limit(flag: string, v: string): number | null {
  if (NONE.has(v.trim().toLowerCase())) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) fail(`${flag}: a positive whole number or "none"`);
  return n;
}

function list(v: string): string[] {
  return NONE.has(v.trim().toLowerCase()) ? [] : v.split(',').map((e) => e.trim()).filter(Boolean);
}

/** Pure: the PUT body for the given options (only what was given); shared mailboxes have no send limits. */
export function buildFlowPatch(o: FlowOptions, kind: 'user' | 'shared'): Record<string, unknown> {
  if (o.hideGal && o.showGal) fail('--hide-gal and --show-gal exclude each other');
  if (kind === 'shared' && (o.maxSend !== undefined || o.maxRecipients !== undefined)) {
    fail('--max-send and --max-recipients exist for user mailboxes only');
  }
  const body: Record<string, unknown> = {};
  if (o.hideGal) body['hiddenFromGal'] = true;
  if (o.showGal) body['hiddenFromGal'] = false;
  if (o.forward !== undefined) body['forwardTo'] = NONE.has(o.forward.trim().toLowerCase()) ? null : o.forward.trim();
  if (o.keepCopy !== undefined) body['forwardKeepCopy'] = onOff('--keep-copy', o.keepCopy);
  if (o.acceptFrom !== undefined) body['acceptFrom'] = list(o.acceptFrom);
  if (o.rejectFrom !== undefined) body['rejectFrom'] = list(o.rejectFrom);
  if (o.maxSend !== undefined) body['maxSendSizeMb'] = limit('--max-send', o.maxSend);
  if (o.maxReceive !== undefined) body['maxReceiveSizeMb'] = limit('--max-receive', o.maxReceive);
  if (o.maxRecipients !== undefined) body['maxRecipients'] = limit('--max-recipients', o.maxRecipients);
  return body;
}

/** Pure: two-column view of a policy. */
export function flowRows(view: Record<string, unknown>): Array<Record<string, unknown>> {
  const show = (v: unknown): string => (v === null || v === undefined ? '—' : Array.isArray(v) ? (v.length ? v.join(', ') : '—') : String(v));
  return Object.entries(view).map(([setting, value]) => ({ setting, value: show(value) }));
}

function flowCommand(parent: Command, kind: 'user' | 'shared', api: () => CoreMailClient, json: () => boolean): void {
  const cmd = parent.command('flow <email|id>')
    .description(kind === 'user'
      ? 'Mail flow: address list, forwarding, sender lists, size / recipient limits'
      : 'Mail flow: address list, forwarding, sender lists, receive size limit')
    .option('--hide-gal', 'hide from the global address list')
    .option('--show-gal', 'show in the global address list')
    .option('--forward <address|none>', 'forward every message to this address')
    .option('--keep-copy <on|off>', 'also deliver to the mailbox when forwarding')
    .option('--accept-from <list|none>', 'accept only these senders (addresses / domains, comma-separated)')
    .option('--reject-from <list|none>', 'reject these senders (addresses / domains, comma-separated)')
    .option('--max-receive <MB|none>', 'largest message received');
  if (kind === 'user') {
    cmd.option('--max-send <MB|none>', 'largest message sent')
      .option('--max-recipients <n|none>', 'most recipients per message');
  }
  cmd.action(async (ref: string, opts: FlowOptions) => {
    const id = kind === 'user' ? (await resolveUser(api(), ref)).id : (await resolveShared(api(), ref)).id;
    const path = `/api/v1/admin/${kind === 'user' ? 'mailboxes' : 'shared-mailboxes'}/${id}/mail-flow`;
    const body = buildFlowPatch(opts, kind);
    const view = Object.keys(body).length > 0
      ? await api().put<Record<string, unknown>>(path, body)
      : await api().get<Record<string, unknown>>(path);
    if (json()) { printJson(view); return; }
    printTable(flowRows(view), [{ key: 'setting', label: 'Setting' }, { key: 'value', label: 'Value' }]);
  });
}

export function registerMailFlow(mailbox: Command, shared: Command, api: () => CoreMailClient, json: () => boolean): void {
  flowCommand(mailbox, 'user', api, json);
  flowCommand(shared, 'shared', api, json);

  shared.command('sent-copy <email|id>')
    .description('Keep a copy of mail sent as / on behalf of the shared mailbox in its Sent folder')
    .option('--send-as <on|off>', 'copy of mail sent as the mailbox')
    .option('--on-behalf <on|off>', 'copy of mail sent on behalf of the mailbox')
    .action(async (ref: string, opts: { sendAs?: string; onBehalf?: string }) => {
      const s = await resolveShared(api(), ref);
      const body: Record<string, boolean> = {};
      if (opts.sendAs !== undefined) body['sentCopySendAs'] = onOff('--send-as', opts.sendAs);
      if (opts.onBehalf !== undefined) body['sentCopySendOnBehalf'] = onOff('--on-behalf', opts.onBehalf);
      if (Object.keys(body).length === 0) fail('Nothing to set: --send-as and/or --on-behalf');
      const r = await api().put<{ sentCopySendAs?: boolean; sentCopySendOnBehalf?: boolean }>(`/api/v1/admin/shared-mailboxes/${s.id}`, body);
      if (json()) { printJson(r); return; }
      process.stdout.write(`${s.email}: sent copy (send as) ${r.sentCopySendAs ? 'on' : 'off'}, (on behalf) ${r.sentCopySendOnBehalf ? 'on' : 'off'}\n`);
    });
}
