/**
 * Post-commit publishing of mailbox changes (9.4).
 *
 * The message store records every change it writes (recordMailboxChange). The
 * events must only go out once the transaction has COMMITTED — a consumer
 * (IMAP IDLE, JMAP push, the webmail) that re-reads the mailbox before the commit
 * would see the old state and then wait for its safety refresh. So:
 *
 *   - installChangeScope(prisma) wraps the client's interactive
 *     `$transaction(fn)`: fn runs in an AsyncLocalStorage scope that collects the
 *     changes (merged per mailbox); they are published when the transaction
 *     resolved, and dropped when it failed (rolled back). Every root-client
 *     `$transaction` is a database transaction of its own, so one started inside
 *     another publishes on its own commit (an outer rollback cannot undo it).
 *   - deferMailboxChanges(fn) holds the changes of a writer's whole unit of
 *     work (e.g. SMTP delivery: message transaction, attachments, folder
 *     counters) until fn settled — on success AND on failure, because what the
 *     committed transactions inside wrote stays written.
 *   - Changes recorded outside any scope (a writer using the root client) are
 *     published after a short delay, enough for the auto-committed statements
 *     that follow the allocation.
 *
 * No database import — unit-tested with an in-memory fake client.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { mergeMailboxChange, publishMailboxChange, type MailboxChangeEvent } from '@coremail/core/realtime';

interface Collector {
  changes: Map<string, MailboxChangeEvent>;
  /** Set once the scope ended; late writes from detached async work start a new one. */
  closed: boolean;
  /** tx = an interactive transaction (dropped on rollback); defer = a writer's unit of work. */
  kind: 'tx' | 'defer';
}

const scope = new AsyncLocalStorage<Collector>();
const LOOSE_DELAY_MS = 100;
let loose: Collector | null = null;
type Publisher = (event: MailboxChangeEvent) => Promise<void>;
/** null = the core publisher (resolved at call time, not at module load). */
let publisherOverride: Publisher | null = null;

/** Test seam: replace the publisher (null restores the default). */
export function setMailboxChangePublisher(fn: Publisher | null): void {
  publisherOverride = fn;
}

function publish(change: MailboxChangeEvent): Promise<void> {
  return (publisherOverride ?? publishMailboxChange)(change);
}

function add(collector: Collector, change: MailboxChangeEvent): void {
  const prev = collector.changes.get(change.mailboxId);
  collector.changes.set(change.mailboxId, prev ? mergeMailboxChange(prev, change) : change);
}

function flush(collector: Collector): void {
  collector.closed = true;
  // publishMailboxChange never rejects (it logs); the write has committed either way
  for (const change of collector.changes.values()) void publish(change);
  collector.changes.clear();
}

/** Ends a scope: its changes go to the enclosing scope, or out when there is none. */
function close(collector: Collector, parent: Collector | null): void {
  if (!parent) { flush(collector); return; }
  collector.closed = true;
  for (const change of collector.changes.values()) add(parent, change);
  collector.changes.clear();
}

function drop(collector: Collector): void {
  collector.closed = true;
  collector.changes.clear();
}

function openScope(): Collector | null {
  const c = scope.getStore();
  return c && !c.closed ? c : null;
}

/** Records a change; published after the surrounding transaction committed. */
export function recordMailboxChange(change: MailboxChangeEvent): void {
  const collector = openScope();
  if (collector) { add(collector, change); return; }
  if (!loose) {
    const batch: Collector = { changes: new Map(), closed: false, kind: 'defer' };
    loose = batch;
    setTimeout(() => { if (loose === batch) loose = null; flush(batch); }, LOOSE_DELAY_MS).unref?.();
  }
  add(loose, change);
}

/**
 * The folder list of a mailbox changed (create, rename, move, delete,
 * subscribe). Every folder writer calls this — inside or outside a transaction.
 */
export function announceFolderListChange(mailboxId: string): void {
  recordMailboxChange({ mailboxId, kinds: ['folders'] });
}

async function runScoped<T>(kind: Collector['kind'], fn: () => Promise<T>): Promise<T> {
  const enclosing = openScope();
  // a transaction started inside a transaction is a separate database
  // transaction: its committed changes neither wait for nor die with the outer one
  const parent = kind === 'tx' && enclosing?.kind === 'tx' ? null : enclosing;
  const collector: Collector = { changes: new Map(), closed: false, kind };
  let result: T;
  try {
    result = await scope.run(collector, fn);
  } catch (err) {
    if (kind === 'tx') drop(collector);
    else close(collector, parent);
    throw err;
  }
  close(collector, parent);
  return result;
}

/**
 * Runs an interactive transaction body collecting the changes it records:
 * published (or handed to an enclosing deferMailboxChanges) when it resolves,
 * dropped when it rejects (rollback).
 */
export function runInChangeScope<T>(fn: () => Promise<T>): Promise<T> {
  return runScoped('tx', fn);
}

/**
 * Holds every mailbox change recorded while `fn` runs and publishes them once
 * it settled (success or failure). For writers that update related rows after
 * the message transaction — folder counters, attachments — so the consumers'
 * re-read sees the finished state.
 */
export function deferMailboxChanges<T>(fn: () => Promise<T>): Promise<T> {
  return runScoped('defer', fn);
}

type TransactionFn = (arg: unknown, opts?: unknown) => Promise<unknown>;
const INSTALLED = Symbol.for('coremail.changeScope');

/**
 * Wraps `client.$transaction` so interactive transactions publish their
 * mailbox changes after the commit (idempotent; the batch form is unchanged).
 */
export function installChangeScope(client: object): void {
  const target = client as { $transaction?: TransactionFn; [INSTALLED]?: true };
  if (typeof target.$transaction !== 'function' || target[INSTALLED]) return;
  const original = target.$transaction.bind(client) as TransactionFn;
  target.$transaction = (arg: unknown, opts?: unknown) =>
    typeof arg === 'function' ? runInChangeScope(() => original(arg, opts)) : original(arg, opts);
  target[INSTALLED] = true;
}
