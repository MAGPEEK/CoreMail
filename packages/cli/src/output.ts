/**
 * Ausgabe-Helfer: Tabellen (Standard), JSON (`--json`), Bestätigungen, Prompts.
 */
import { createInterface } from 'node:readline';

export interface OutputOptions { json: boolean }

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

/** Einfache Spaltentabelle ohne Abhängigkeiten. */
export function printTable(rows: Array<Record<string, unknown>>, columns: Array<{ key: string; label: string }>): void {
  if (rows.length === 0) { process.stdout.write('(keine Einträge)\n'); return; }
  const cells = rows.map((r) => columns.map((c) => fmtCell(r[c.key])));
  const widths = columns.map((c, i) => Math.max(c.label.length, ...cells.map((row) => row[i]!.length)));
  const line = (vals: string[]): string => vals.map((v, i) => v.padEnd(widths[i]!)).join('  ').trimEnd() + '\n';
  process.stdout.write(line(columns.map((c) => c.label)));
  process.stdout.write(line(widths.map((w) => '─'.repeat(w))));
  for (const row of cells) process.stdout.write(line(row));
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'ja' : 'nein';
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => fmtCell(x)).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function formatBytes(n: number | string | bigint | null | undefined): string {
  if (n === null || n === undefined) return '—';
  let v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** "5GB", "500MB", "1073741824" → Bytes */
export function parseBytes(s: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?b?)\s*$/i.exec(s);
  if (!m) throw new Error(`Ungültige Größe: ${s} (z. B. 5GB, 500MB)`);
  const num = parseFloat(m[1]!);
  const unit = m[2]!.toLowerCase().replace('b', '');
  const factor: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  return Math.round(num * (factor[unit] ?? 1));
}

export function formatDate(v: unknown): string {
  if (!v) return '—';
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 16).replace('T', ' ');
}

export async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise<string>((resolve) => rl.question(question, (a) => resolve(a.trim())));
  } finally {
    rl.close();
  }
}

/** Passwort-Eingabe ohne Echo (bei nicht-interaktivem stdin: Zeile lesen). */
export async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return prompt(question);
  process.stderr.write(question);
  return new Promise<string>((resolve) => {
    const stdin = process.stdin;
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') { process.stderr.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Error('Bestätigung erforderlich — mit --yes bestätigen (nicht-interaktiv)');
  const a = (await prompt(`${question} [j/N] `)).toLowerCase();
  return a === 'j' || a === 'ja' || a === 'y' || a === 'yes';
}

export function fail(message: string): never {
  process.stderr.write(`Fehler: ${message}\n`);
  process.exit(1);
}
