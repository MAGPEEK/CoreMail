/**
 * The MAPI folder tree of a mailbox: the special folders a private store has
 * (MS-OXOSFLD / MS-OXCSTOR: Root, Top of Information Store, Outbox, …) plus
 * the CoreMail folders below "Top of Information Store".
 *
 * Special folders have no database row; their contents tables are empty.
 * The Outbox only holds messages being sent in the current session (a message
 * created there lives in memory until it is submitted). Recoverable-items
 * folders are not part of the tree.
 */
import { RECOVERABLE_ROOT } from '@coremail/storage';
import { SpecialCounter, folderCounterForRow } from '../ids.js';
import type { FolderRecord } from '../store/types.js';

export type SpecialFolder =
  | 'root' | 'deferredAction' | 'spoolerQueue' | 'ipmSubtree' | 'outbox'
  | 'commonViews' | 'schedule' | 'finder' | 'views' | 'shortcuts';

export type FolderRole = 'inbox' | 'drafts' | 'sent' | 'trash' | 'junk' | 'archive';

export interface FolderNode {
  counter: bigint;
  parentCounter: bigint | null;
  displayName: string;
  /** Database row; null for special folders. */
  record: FolderRecord | null;
  special: SpecialFolder | null;
  role: FolderRole | null;
  hidden: boolean;
  /** PidTagContainerClass (null = none). */
  containerClass: string | null;
}

const SPECIALS: ReadonlyArray<{ special: SpecialFolder; counter: bigint; parent: bigint | null; name: string; hidden: boolean; cls: string | null }> = [
  { special: 'root', counter: SpecialCounter.Root, parent: null, name: '', hidden: false, cls: null },
  { special: 'deferredAction', counter: SpecialCounter.DeferredAction, parent: SpecialCounter.Root, name: 'Deferred Action', hidden: true, cls: null },
  { special: 'spoolerQueue', counter: SpecialCounter.SpoolerQueue, parent: SpecialCounter.Root, name: 'Spooler Queue', hidden: true, cls: null },
  { special: 'ipmSubtree', counter: SpecialCounter.IpmSubtree, parent: SpecialCounter.Root, name: 'Top of Information Store', hidden: false, cls: null },
  { special: 'commonViews', counter: SpecialCounter.CommonViews, parent: SpecialCounter.Root, name: 'Common Views', hidden: true, cls: null },
  { special: 'schedule', counter: SpecialCounter.Schedule, parent: SpecialCounter.Root, name: 'Schedule', hidden: true, cls: null },
  { special: 'finder', counter: SpecialCounter.Finder, parent: SpecialCounter.Root, name: 'Finder', hidden: true, cls: null },
  { special: 'views', counter: SpecialCounter.Views, parent: SpecialCounter.Root, name: 'Views', hidden: true, cls: null },
  { special: 'shortcuts', counter: SpecialCounter.Shortcuts, parent: SpecialCounter.Root, name: 'Shortcuts', hidden: true, cls: null },
  { special: 'outbox', counter: SpecialCounter.Outbox, parent: SpecialCounter.IpmSubtree, name: 'Outbox', hidden: false, cls: 'IPF.Note' },
];

/** Top-level CoreMail folders with a well-known role (provision-mailbox DEFAULT_FOLDERS). */
const ROLE_BY_NAME: Readonly<Record<string, FolderRole>> = {
  INBOX: 'inbox', Drafts: 'drafts', Sent: 'sent', Trash: 'trash', Junk: 'junk', Archive: 'archive',
};

export class MailboxView {
  private readonly nodes = new Map<bigint, FolderNode>();
  private readonly byRecord = new Map<string, FolderNode>();

  constructor(records: readonly FolderRecord[]) {
    for (const s of SPECIALS) {
      this.nodes.set(s.counter, {
        counter: s.counter, parentCounter: s.parent, displayName: s.name, record: null,
        special: s.special, role: null, hidden: s.hidden, containerClass: s.cls,
      });
    }
    const visible = records.filter((r) => !r.name.startsWith(RECOVERABLE_ROOT));
    // A folder the client created keeps the ID it assigned (cached mode), else the row's counter.
    const counters = new Map(visible.map((r) => [r.id, r.clientId ?? folderCounterForRow(r.id)]));
    for (const r of visible) {
      const parentCounter = r.parentId !== null ? counters.get(r.parentId) : undefined;
      const parentKnown = parentCounter !== undefined;
      const node: FolderNode = {
        counter: counters.get(r.id)!,
        parentCounter: parentCounter ?? SpecialCounter.IpmSubtree,
        displayName: r.displayName || r.name,
        record: r,
        special: null,
        role: parentKnown ? null : (ROLE_BY_NAME[r.name] ?? null),
        hidden: false,
        containerClass: 'IPF.Note',
      };
      this.nodes.set(node.counter, node);
      this.byRecord.set(r.id, node);
    }
  }

  get(counter: bigint): FolderNode | undefined { return this.nodes.get(counter); }
  ofRecord(id: string): FolderNode | undefined { return this.byRecord.get(id); }
  special(s: SpecialFolder): FolderNode { return [...this.nodes.values()].find((n) => n.special === s)!; }
  role(role: FolderRole): FolderNode | undefined { return [...this.nodes.values()].find((n) => n.role === role); }

  children(counter: bigint): FolderNode[] {
    return [...this.nodes.values()].filter((n) => n.parentCounter === counter);
  }

  /** All descendants with their depth (1 = direct child), parents before children. */
  descendants(counter: bigint): Array<{ node: FolderNode; depth: number }> {
    const out: Array<{ node: FolderNode; depth: number }> = [];
    const walk = (parent: bigint, depth: number): void => {
      for (const child of this.children(parent)) {
        out.push({ node: child, depth });
        walk(child.counter, depth + 1);
      }
    };
    walk(counter, 1);
    return out;
  }
}
