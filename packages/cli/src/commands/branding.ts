/**
 * `coremail branding …` (9.3) — product name, colours, logos via /api/v1/admin/branding.
 *
 *   coremail branding show
 *   coremail branding set --name "Acme Mail" --color "#0a5bd3" --header-color none --allow-user-accent false --powered-by true
 *   coremail branding upload logoLight ./logo.svg
 *   coremail branding remove favicon
 *   coremail branding reset --yes
 */
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { Command } from 'commander';
import type { CoreMailClient } from '../client.js';
import { confirm, printJson } from '../output.js';

export const BRANDING_SLOTS = ['logoLight', 'logoDark', 'favicon', 'loginBackground'] as const;
type Slot = typeof BRANDING_SLOTS[number];

interface Branding {
  version: number; productName: string; primaryColor: string | null; headerColor: string | null;
  allowUserAccent: boolean; showPoweredBy: boolean; loginText: string;
  footerLinks: Array<{ label: string; url: string }>;
  assets: Record<Slot, string | null>;
  warnings?: Array<{ field: string; message: string; suggestion: string }>;
}

export interface SetOptions {
  name?: string; color?: string; headerColor?: string; allowUserAccent?: string; poweredBy?: string; loginText?: string;
}

function parseBool(flag: string, v: string): boolean {
  if (/^(true|yes|on|1)$/i.test(v)) return true;
  if (/^(false|no|off|0)$/i.test(v)) return false;
  throw new Error(`${flag} expects true or false`);
}

function parseColor(flag: string, v: string, resetWord: string): string | null {
  if (v.toLowerCase() === resetWord) return null;
  if (!/^#?[0-9a-f]{6}$/i.test(v)) throw new Error(`${flag} expects #rrggbb or "${resetWord}"`);
  return (v.startsWith('#') ? v : `#${v}`).toLowerCase();
}

/** CLI options → PUT body (only the options given). */
export function buildBrandingUpdate(o: SetOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (o.name !== undefined) {
    const n = o.name.trim();
    if (n.toLowerCase() === 'default') body['productName'] = null;
    else if (n.length < 1 || n.length > 40) throw new Error('--name must be 1–40 characters (or "default")');
    else body['productName'] = n;
  }
  if (o.color !== undefined) body['primaryColor'] = parseColor('--color', o.color, 'default');
  if (o.headerColor !== undefined) body['headerColor'] = parseColor('--header-color', o.headerColor, 'none');
  if (o.allowUserAccent !== undefined) body['allowUserAccent'] = parseBool('--allow-user-accent', o.allowUserAccent);
  if (o.poweredBy !== undefined) body['showPoweredBy'] = parseBool('--powered-by', o.poweredBy);
  if (o.loginText !== undefined) {
    if (o.loginText.length > 280) throw new Error('--login-text may have at most 280 characters');
    body['loginText'] = o.loginText;
  }
  if (Object.keys(body).length === 0) throw new Error('Nothing to set — use --name, --color, --header-color, --allow-user-accent, --powered-by or --login-text');
  return body;
}

const TYPES: Record<string, string> = { '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

/** Content type from the file extension (the server checks the bytes too). */
export function contentTypeForFile(path: string): string {
  const t = TYPES[extname(path).toLowerCase()];
  if (!t) throw new Error('Unsupported file type — use .png, .webp, .svg (or .jpg for loginBackground)');
  return t;
}

export function assertSlot(slot: string): Slot {
  if (!(BRANDING_SLOTS as readonly string[]).includes(slot)) throw new Error(`Unknown slot ${slot} — use ${BRANDING_SLOTS.join(', ')}`);
  return slot as Slot;
}

/** Human-readable summary of the branding object. */
export function formatBranding(b: Branding): string {
  const lines = [
    `Product name:       ${b.productName}`,
    `Primary colour:     ${b.primaryColor ?? 'default'}`,
    `Header colour:      ${b.headerColor ?? '(primary colour)'}`,
    `User accent colour: ${b.allowUserAccent ? 'allowed' : 'locked to the brand colour'}`,
    `Powered by:         ${b.showPoweredBy ? 'shown' : 'hidden'}`,
    `Login text:         ${b.loginText ? JSON.stringify(b.loginText) : '—'}`,
    `Footer links:       ${b.footerLinks.length ? b.footerLinks.map((l) => `${l.label} <${l.url}>`).join(', ') : '—'}`,
    ...BRANDING_SLOTS.map((s) => `${(s + ':').padEnd(20)}${b.assets[s] ?? '—'}`),
    `Version:            ${b.version}`,
  ];
  return lines.join('\n') + '\n';
}

function printWarnings(b: Branding): void {
  for (const w of b.warnings ?? []) process.stderr.write(`Warning (${w.field}): ${w.message} Suggested: ${w.suggestion}\n`);
}

export function registerBranding(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const branding = program.command('branding').description('Branding: product name, colours, logos, favicon, login page');
  const P = '/api/v1/admin/branding';
  const out = (b: Branding): void => { if (json()) printJson(b); else process.stdout.write(formatBranding(b)); };

  branding.command('show', { isDefault: true }).description('Current branding')
    .action(async () => out(await api().get<Branding>(P)));

  branding.command('set').description('Change product name, colours and switches (only the given options)')
    .option('--name <name>', 'product name, 1–40 characters ("default" = BRANDING_NAME / CoreMail)')
    .option('--color <hex>', 'primary colour #rrggbb ("default" = BRANDING_COLOR / #0078d4)')
    .option('--header-color <hex>', 'header colour #rrggbb ("none" = primary colour)')
    .option('--allow-user-accent <bool>', 'users may pick their own accent colour (true|false)')
    .option('--powered-by <bool>', 'show "Powered by CoreMail" on the login page (true|false)')
    .option('--login-text <text>', 'welcome text on the login page (plain text, ≤ 280 characters)')
    .action(async (o: SetOptions) => {
      const b = await api().put<Branding>(P, buildBrandingUpdate(o));
      printWarnings(b);
      out(b);
    });

  branding.command('upload <slot> <file>').description(`Upload an image (${BRANDING_SLOTS.join(' | ')}): PNG, WebP, SVG; loginBackground also JPEG`)
    .action(async (slotArg: string, file: string) => {
      const slot = assertSlot(slotArg);
      const type = contentTypeForFile(file);
      const max = slot === 'loginBackground' ? 2 * 1024 * 1024 : 512 * 1024;
      if (statSync(file).size > max) throw new Error(`${slot} may be at most ${max / 1024} KB`);
      const b = await api().postRaw<Branding>(`${P}/assets/${slot}`, readFileSync(file), { 'Content-Type': type });
      if (json()) { printJson(b); return; }
      process.stdout.write(`${slot} uploaded: ${b.assets[slot]}\n`);
    });

  branding.command('remove <slot>').description('Remove an uploaded image (the built-in default applies again)')
    .action(async (slotArg: string) => {
      const slot = assertSlot(slotArg);
      const b = await api().delete<Branding>(`${P}/assets/${slot}`);
      if (json()) { printJson(b); return; }
      process.stdout.write(`${slot} removed\n`);
    });

  branding.command('reset').description('Reset all branding to the defaults (removes uploaded images)')
    .option('-y, --yes', 'no confirmation prompt')
    .action(async (o: { yes?: boolean }) => {
      if (!await confirm('Reset all branding to the defaults (uploaded images are deleted)?', !!o.yes)) { process.stdout.write('Aborted.\n'); return; }
      const b = await api().post<Branding>(`${P}/reset`);
      if (json()) { printJson(b); return; }
      process.stdout.write('Branding reset to the defaults\n');
    });
}
