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
 *     resolved, and dropped when it failed (rolled back).
 *   - Changes recorded outside such a scope (a writer using the root client)
 *     are published after a short delay, enough for the auto-committed
 *     statements that follow the allocation.
 *
 * No database import — unit-tested with an in-memory fake client.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { mergeMailboxChange, publishMailboxChange, type MailboxChangeEvent } from '@coremail/core/realtime';

interface Collector {
  changes: Map<string, MailboxChangeEvent>;
  /** Set once the scope ended; late writes from detached async work start a new one. */
  closed: boolean;
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
  for (const change of collector.changes.values()) void publish(change);
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
    const batch: Collector = { changes: new Map(), closed: false };
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

/**
 * Runs `fn` collecting the changes it records; publishes them when fn resolves,
 * drops them when it rejects. Nested calls join the outer scope.
 */
export async function runInChangeScope<T>(fn: () => Promise<T>): Promise<T> {
  if (openScope()) return fn();
  const collector: Collector = { changes: new Map(), closed: false };
  let result: T;
  try {
    result = await scope.run(collector, fn);
  } catch (err) {
    collector.closed = true;
    collector.changes.clear();
    throw err;
  }
  flush(collector);
  return result;
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
