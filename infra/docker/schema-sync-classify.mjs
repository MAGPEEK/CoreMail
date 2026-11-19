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
// It is safe as long as the table holds no duplicates. For every such
// constraint schema-sync runs the guard query printed below and, when the guard
// answers "check", the duplicate-check query, before it applies the change
// automatically. EVERY other warning — dropped table ("You are about to drop the
// `x` table, which is not empty (N rows)."), dropped column ("You are about to
// drop the column `c` on the `t` table, which still contains N non-null
// values."), type change, removed enum value, primary key change, anything
// unknown — is "unsafe" and stays fail-closed (COREMAIL_ALLOW_SCHEMA_DATA_LOSS).
//
// The constraint may cover a column the same update creates (9.4 → 9.5:
// Task.uid String? with @@unique([userId, uid])). The duplicate check cannot
// read a column that does not exist yet, so the guard looks first:
//   new-table   the table does not exist yet — no rows, nothing to check
//   new-column  an optional constraint column WITHOUT a default does not exist
//               yet — Prisma adds it as NULL in every row, and NULLs never
//               conflict in a PostgreSQL unique constraint
//   check       run the duplicate check (it fails — fail-closed — when it names
//               a column that does not exist yet, e.g. one with a default)
// Which columns are optional without a default comes from the target Prisma
// schema: COREMAIL_PRISMA_SCHEMA_FILE, default prisma/schema.prisma below the
// working directory (schema-sync.sh runs in the storage package). Without a
// readable schema no column counts as optional (fail-closed).
//
// Output (tab-separated lines, read by schema-sync.sh):
//   verdict<TAB>safe|unsafe|none
//   unique<TAB><table><TAB><col,col><TAB><guard SQL><TAB><SQL returning the number of duplicate groups>
//   unsafe<TAB><warning text>
// "none" = no warning bullet recognised (schema-sync treats it as unsafe).
// No dependencies; Node 18+. Tests: node --test infra/docker/schema-sync-classify.test.mjs
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNIQUE_RE = /^A unique constraint covering the columns `\[([^\]]+)\]` on the table `([^`]+)` will be added\. If there are existing duplicate values, this will fail\.$/;

const q = (id) => `"${id}"`;
const lit = (id) => `'${id}'`;

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

/** A schema line without its `//` comment (string literals are kept). */
function stripComment(line) {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && inString) i++;
    else if (ch === '"') inString = !inString;
    else if (!inString && ch === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/**
 * Columns per table that the Prisma schema declares optional WITHOUT a default
 * (`name Type?`, no @default): Map<table, Set<column>>. Table = @@map or the
 * model name, column = @map or the field name.
 */
export function optionalColumnsWithoutDefault(schemaText) {
  const tables = new Map();
  const modelRe = /^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\s*\}/gm;
  for (const [, model, body] of String(schemaText).replace(/\r/g, '').matchAll(modelRe)) {
    let table = model;
    const columns = new Set();
    for (const raw of body.split('\n')) {
      const line = stripComment(raw).trim();
      const map = /^@@map\(\s*"([^"]+)"\s*\)/.exec(line);
      if (map) { table = map[1]; continue; }
      const field = /^([A-Za-z_][A-Za-z0-9_]*)\s+[A-Za-z_][A-Za-z0-9_]*(\?|\[\])?(.*)$/.exec(line);
      if (!field || field[2] !== '?' || /@default\(|@relation\(/.test(field[3])) continue;
      columns.add(/@map\(\s*"([^"]+)"\s*\)/.exec(field[3])?.[1] ?? field[1]);
    }
    tables.set(table, columns);
  }
  return tables;
}

/** SQL: number of value groups that would violate UNIQUE(columns) (NULLs never conflict in PostgreSQL). */
export function duplicateCheckSql(schema, table, columns) {
  const cols = columns.map(q).join(', ');
  const notNull = columns.map((c) => `${q(c)} IS NOT NULL`).join(' AND ');
  return `SELECT count(*) FROM (SELECT 1 FROM ${q(schema)}.${q(table)} WHERE ${notNull} GROUP BY ${cols} HAVING count(*) > 1) AS d`;
}

/**
 * SQL answering new-table | new-column | check (see the header). `optional` =
 * the constraint columns the target schema declares optional without a default.
 */
export function guardSql(schema, table, optional) {
  const newColumn = optional.length === 0 ? '' : ` WHEN (SELECT count(*) FROM information_schema.columns WHERE table_schema = ${lit(schema)} AND table_name = ${lit(table)} AND column_name IN (${optional.map(lit).join(', ')})) < ${optional.length} THEN 'new-column'`;
  return `SELECT CASE WHEN to_regclass(${lit(`${q(schema)}.${q(table)}`)}) IS NULL THEN 'new-table'${newColumn} ELSE 'check' END`;
}

/**
 * Classifies one warning: { kind: 'unique', table, columns, guard, sql } or
 * { kind: 'unsafe', text }. `optionalColumns` = optionalColumnsWithoutDefault()
 * of the target schema.
 */
export function classifyWarning(text, schema = 'public', optionalColumns = new Map()) {
  const m = UNIQUE_RE.exec(text.trim());
  if (m) {
    const table = m[2];
    const columns = m[1].split(',').map((c) => c.trim());
    // Identifiers are quoted into SQL — anything unusual is not auto-applied.
    if (IDENT.test(schema) && IDENT.test(table) && columns.length > 0 && columns.every((c) => IDENT.test(c))) {
      const optional = columns.filter((c) => optionalColumns.get(table)?.has(c));
      return { kind: 'unique', table, columns, guard: guardSql(schema, table, optional), sql: duplicateCheckSql(schema, table, columns) };
    }
  }
  return { kind: 'unsafe', text: text.trim() };
}

/** Classifies a whole Prisma output. verdict: safe (only new unique constraints) | unsafe | none. */
export function classify(output, schema = 'public', optionalColumns = new Map()) {
  const items = parseWarnings(output).map((w) => classifyWarning(w, schema, optionalColumns));
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

/** Optional columns of the target Prisma schema file; empty (fail-closed) when it cannot be read. */
export function loadOptionalColumns(file) {
  try {
    return optionalColumnsWithoutDefault(readFileSync(file, 'utf8'));
  } catch {
    return new Map();
  }
}

export function format(result) {
  const lines = [`verdict\t${result.verdict}`];
  for (const i of result.items) {
    lines.push(i.kind === 'unique'
      ? `unique\t${i.table}\t${i.columns.join(',')}\t${i.guard}\t${i.sql}`
      : `unsafe\t${i.text.replace(/[\t\n]/g, ' ')}`);
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const schema = process.argv[2] || schemaFromUrl(process.env.DATABASE_URL);
  const optional = loadOptionalColumns(process.env.COREMAIL_PRISMA_SCHEMA_FILE || 'prisma/schema.prisma');
  process.stdout.write(format(classify(Buffer.concat(chunks).toString('utf8'), schema, optional)));
}
