#!/usr/bin/env node
// CoreMail — classifies the warnings of a refused `prisma db push` for
// schema-sync.sh (installed as /usr/local/lib/coremail/schema-sync-classify.mjs).
//
//   node schema-sync-classify.mjs [<db schema>] < prisma-output.txt
//
// Prisma reports "There might be data loss" for changes that never delete
// anything. The one CoreMail relies on is a NEW UNIQUE CONSTRAINT (Prisma 5):
//   • A unique constraint covering the columns `[calendarId,uid]` on the table
//     `resource_bookings` will be added. If there are existing duplicate values, this will fail.
// It is safe as long as the table holds no duplicates; schema-sync runs the
// duplicate-check query printed below for every such constraint before it
// applies the change automatically. EVERY other warning — dropped table
// ("You are about to drop the `x` table, which is not empty (N rows)."), dropped
// column ("You are about to drop the column `c` on the `t` table, which still
// contains N non-null values."), type change, removed enum value, primary key
// change, anything unknown — is "unsafe" and stays fail-closed
// (COREMAIL_ALLOW_SCHEMA_DATA_LOSS).
//
// Output (tab-separated lines, read by schema-sync.sh):
//   verdict<TAB>safe|unsafe|none
//   unique<TAB><table><TAB><col,col><TAB><SQL returning the number of duplicate groups>
//   unsafe<TAB><warning text>
// "none" = no warning bullet recognised (schema-sync treats it as unsafe).
// No dependencies; Node 18+. Tests: node --test infra/docker/schema-sync-classify.test.mjs
import { pathToFileURL } from 'node:url';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNIQUE_RE = /^A unique constraint covering the columns `\[([^\]]+)\]` on the table `([^`]+)` will be added\. If there are existing duplicate values, this will fail\.$/;

const q = (id) => `"${id}"`;

/** Splits Prisma's output into warning bullets ("•" lines plus their continuation lines). */
export function parseWarnings(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    const m = /^•\s*(.*)$/.exec(line);
    if (m) {
      if (cur !== null) out.push(cur);
      cur = m[1].trim();
    } else if (cur !== null && line) {
      cur += ` ${line}`;
    } else if (cur !== null) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** SQL: number of value groups that would violate UNIQUE(columns) (NULLs never conflict in PostgreSQL). */
export function duplicateCheckSql(schema, table, columns) {
  const cols = columns.map(q).join(', ');
  const notNull = columns.map((c) => `${q(c)} IS NOT NULL`).join(' AND ');
  return `SELECT count(*) FROM (SELECT 1 FROM ${q(schema)}.${q(table)} WHERE ${notNull} GROUP BY ${cols} HAVING count(*) > 1) AS d`;
}

/** Classifies one warning: { kind: 'unique', table, columns, sql } or { kind: 'unsafe', text }. */
export function classifyWarning(text, schema = 'public') {
  const m = UNIQUE_RE.exec(text.trim());
  if (m) {
    const table = m[2];
    const columns = m[1].split(',').map((c) => c.trim());
    // Identifiers are quoted into SQL — anything unusual is not auto-applied.
    if (IDENT.test(schema) && IDENT.test(table) && columns.length > 0 && columns.every((c) => IDENT.test(c))) {
      return { kind: 'unique', table, columns, sql: duplicateCheckSql(schema, table, columns) };
    }
  }
  return { kind: 'unsafe', text: text.trim() };
}

/** Classifies a whole Prisma output. verdict: safe (only new unique constraints) | unsafe | none. */
export function classify(output, schema = 'public') {
  const items = parseWarnings(output).map((w) => classifyWarning(w, schema));
  // "We found changes that cannot be executed" — never auto-applied.
  const unexecutable = /cannot be executed/i.test(String(output));
  let verdict = 'none';
  if (items.length > 0) verdict = !unexecutable && items.every((i) => i.kind === 'unique') ? 'safe' : 'unsafe';
  else if (unexecutable) verdict = 'unsafe';
  return { verdict, items };
}

/** Database schema from a Prisma DATABASE_URL (?schema=…), default public. */
export function schemaFromUrl(url) {
  const m = /[?&]schema=([^&]+)/.exec(String(url ?? ''));
  return m ? decodeURIComponent(m[1]) : 'public';
}

export function format(result) {
  const lines = [`verdict\t${result.verdict}`];
  for (const i of result.items) {
    lines.push(i.kind === 'unique'
      ? `unique\t${i.table}\t${i.columns.join(',')}\t${i.sql}`
      : `unsafe\t${i.text.replace(/[\t\n]/g, ' ')}`);
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const schema = process.argv[2] || schemaFromUrl(process.env.DATABASE_URL);
  process.stdout.write(format(classify(Buffer.concat(chunks).toString('utf8'), schema)));
}
