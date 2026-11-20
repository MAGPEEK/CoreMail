#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// CoreMail — bundled configuration installer (installed as
// /usr/local/bin/coremail-init-config; the entrypoint of the coremail container
// runs it on every start when /config is mounted — deploy/docker-compose.yml)
//
//   coremail-init-config [--bundled <dir>] [--config <dir>] [--override <dir>]
//
// The app image carries the configuration files the infrastructure containers
// need (10.4), so a deployment needs no repository checkout:
//
//   <bundled>/postgres/01-init.sql            → postgres /docker-entrypoint-initdb.d
//   <bundled>/postgres/02-app-role.sh         → postgres /docker-entrypoint-initdb.d
//   <bundled>/rspamd/local.d/*                → rspamd   /etc/rspamd/local.d
//   <bundled>/pg-backup/pg-backup.sh          → pg-backup /pg-backup
//
// (bundled default: /usr/share/coremail/config). Every file is copied to
// <config>/<same relative path> (default $COREMAIL_CONFIG_DIR or /config) on
// EVERY run, so an image update brings new versions. A file the image no longer
// carries is removed — but only when this tool wrote it (a hidden manifest
// .coremail-config-files per directory lists what it wrote); nothing else in the
// target directories is ever touched.
//
// Optional user override (rspamd only): regular files in
// <override>/rspamd/local.d (default $COREMAIL_CONFIG_OVERRIDE_DIR or
// /config-override; Compose maps ./config next to the Compose file there) win
// over the bundled file of the same name; other names are added. The override
// directory itself is only read. Removing an override file restores the bundled
// one on the next run.
//
// Targets are written only when <config> exists (it is a volume mount); a
// missing subdirectory is created. After its files every target directory gets
// the ready marker ".ready" (atomic, content = sha256 of the installed files):
// the containers that mount the volume wait for it before they start (the
// marker of an unchanged configuration is left alone). Files are written
// atomically (temp file + fsync + rename), 0644 (0755 when the bundled file is executable), and
// unchanged files are left alone. Symlinks are never followed: a symlink in
// the override directory is skipped, one in a target directory is replaced.
// Postgres runs its init scripts only on an EMPTY data directory, so an
// existing database is unaffected by anything written here.
//
// Node 18+, built-ins only.
// ─────────────────────────────────────────────────────────────────────────────
import {
  closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync,
  renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST = '.coremail-config-files';
/** Written last into every target directory — the consuming containers wait for it. */
export const READY_MARKER = '.ready';
/** Relative directories (below <config>) a user override may extend. */
export const OVERRIDABLE_DIRS = ['rspamd/local.d'];
/** Safe file names: no path separators, no leading dot, no control characters. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Override files larger than this are skipped (rspamd config snippets are small). */
export const MAX_OVERRIDE_BYTES = 1024 * 1024;

/** Windows (tests only) has no POSIX file modes. */
const POSIX_MODES = process.platform !== 'win32';
const isDir = (p) => { try { return lstatSync(p).isDirectory(); } catch { return false; } };

/** Pure-ish: list bundled files as Map<relDir, Map<name, {path, mode}>>. */
export function collectBundled(bundledDir) {
  const out = new Map();
  const walk = (rel) => {
    const abs = rel ? join(bundledDir, rel) : bundledDir;
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { walk(childRel); continue; }
      if (!ent.isFile() || !NAME_RE.test(ent.name) || !rel) continue;
      const st = lstatSync(join(abs, ent.name));
      if (!out.has(rel)) out.set(rel, new Map());
      out.get(rel).set(ent.name, { path: join(abs, ent.name), mode: (st.mode & 0o111) ? 0o755 : 0o644 });
    }
  };
  walk('');
  return out;
}

/** Regular files of one override directory (symlinks, odd names and huge files skipped). */
export function collectOverride(dir, warn = () => undefined) {
  const out = new Map();
  if (!isDir(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (!NAME_RE.test(ent.name)) { if (!ent.name.startsWith('.')) warn(`override ${ent.name}: unsupported file name — skipped`); continue; }
    if (ent.isSymbolicLink()) { warn(`override ${ent.name}: symbolic link — skipped`); continue; }
    if (!ent.isFile()) continue;
    const st = lstatSync(p);
    if (st.size > MAX_OVERRIDE_BYTES) { warn(`override ${ent.name}: larger than ${MAX_OVERRIDE_BYTES} bytes — skipped`); continue; }
    out.set(ent.name, { path: p, mode: 0o644 });
  }
  return out;
}

function readManifest(dir) {
  try {
    const st = lstatSync(join(dir, MANIFEST));
    if (!st.isFile()) return [];
    return readFileSync(join(dir, MANIFEST), 'utf8').split('\n').map((l) => l.trim()).filter((l) => NAME_RE.test(l));
  } catch { return []; }
}

/** Atomic write (temp + fsync + rename) unless the target already has this content. */
export function writeIfChanged(file, data, mode) {
  try {
    const st = lstatSync(file);
    if (st.isFile() && (!POSIX_MODES || (st.mode & 0o777) === mode) && readFileSync(file).equals(data)) return false;
  } catch { /* missing */ }
  const tmp = `${file}.tmp-${process.pid}`;
  try { unlinkSync(tmp); } catch { /* none */ }
  const fd = openSync(tmp, 'wx', mode);
  try {
    if (POSIX_MODES) fchmodSync(fd, mode);   // independent of the umask
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off, data.length - off);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, file);
  return true;
}

/**
 * Install the bundled configuration into <configDir>. Returns a summary per
 * target directory: { dir, written, unchanged, removed, overrides }.
 */
export function syncConfig({ bundledDir, configDir, overrideDir, log = () => undefined }) {
  if (!isDir(configDir)) {
    log(`${configDir} is not mounted — nothing to install`);
    return [];
  }
  const bundled = collectBundled(bundledDir);
  const summary = [];
  for (const [rel, files] of bundled) {
    const dest = join(configDir, ...rel.split('/'));
    mkdirSync(dest, { recursive: true, mode: 0o755 });
    const want = new Map(files);
    let overrides = 0;
    if (overrideDir && OVERRIDABLE_DIRS.includes(rel)) {
      for (const [name, f] of collectOverride(join(overrideDir, ...rel.split('/')), (m) => log(`WARNING: ${rel}: ${m}`))) {
        want.set(name, f);
        overrides++;
      }
    }
    let written = 0, unchanged = 0, removed = 0;
    for (const [name, f] of want) {
      if (writeIfChanged(join(dest, name), readFileSync(f.path), f.mode)) written++; else unchanged++;
    }
    // Remove what an earlier run wrote and is no longer wanted — nothing else.
    for (const name of readManifest(dest)) {
      if (want.has(name)) continue;
      try {
        const st = lstatSync(join(dest, name));
        if (st.isFile() || st.isSymbolicLink()) { unlinkSync(join(dest, name)); removed++; }
      } catch { /* already gone */ }
    }
    writeIfChanged(join(dest, MANIFEST), Buffer.from([...want.keys()].sort().join('\n') + '\n'), 0o644);
    // Ready marker last: the directory is complete.
    const digest = createHash('sha256');
    for (const name of [...want.keys()].sort()) {
      digest.update(`${name}\0`).update(readFileSync(join(dest, name))).update('\0');
    }
    writeIfChanged(join(dest, READY_MARKER), Buffer.from(`sha256:${digest.digest('hex')}\n`), 0o644);
    summary.push({ dir: rel, written, unchanged, removed, overrides });
    log(`${rel}: ${want.size} file(s) — ${written} written, ${unchanged} unchanged, ${removed} removed`
      + (overrides ? `, ${overrides} from the override directory` : ''));
  }
  return summary;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = `usage: coremail-init-config [--bundled <dir>] [--config <dir>] [--override <dir>]

Copies the configuration bundled in the image (/usr/share/coremail/config) into
<config> (default $COREMAIL_CONFIG_DIR or /config). Files in
<override>/rspamd/local.d (default $COREMAIL_CONFIG_OVERRIDE_DIR or
/config-override) win over the bundled ones. Details: docs/deploy.md.`;

function parseArgs(argv, env) {
  const opts = {
    bundledDir: env.COREMAIL_CONFIG_BUNDLED_DIR || '/usr/share/coremail/config',
    configDir: env.COREMAIL_CONFIG_DIR || '/config',
    overrideDir: env.COREMAIL_CONFIG_OVERRIDE_DIR || '/config-override',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a directory`); return argv[++i]; };
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--bundled') opts.bundledDir = val();
    else if (a === '--config') opts.configDir = val();
    else if (a === '--override') opts.overrideDir = val();
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const err = (m) => process.stderr.write(`[init-config] ${m}\n`);
  let opts;
  try { opts = parseArgs(argv, env); } catch (e) { err(e.message); process.stderr.write(`${USAGE}\n`); return 1; }
  if (opts.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  try {
    syncConfig({ ...opts, log: (m) => process.stdout.write(`[init-config] ${m}\n`) });
    return 0;
  } catch (e) {
    err(`ERROR: ${e.message}`);
    return 1;
  }
}

function isMain() {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) process.exitCode = main();
