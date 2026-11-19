/**
 * In-memory MailStore for the ROP and HTTP tests (test-only). One mailbox per
 * user plus optional foreign mailboxes; sending records the job instead of
 * queueing it.
 */
import type {
  AttachmentRecord, ClientIdOwner, ComposedMessage, DirectoryRecord, DirectoryStore, FolderRecord, IdRange, ImportOptions,
  MailboxRef, MailStore, MapiObjectTarget, MapiUser, MessageContent, MessageSummary, NewMessage, SubmissionLimits, SubmitResult,
} from '../store/types.js';
import { LOCAL_ID_BASE } from '../ics/keys.js';
import { contains, normalize } from '../ics/globset.js';

export interface MemoryMessage {
  summary: MessageSummary;
  content: MessageContent;
  attachmentData: Map<string, Buffer>;
  deleted: boolean;
}

/** A MapiObject row (the prisma-store table). */
export interface MemoryMapiObject { mailboxId: string; clientId: bigint | null; messageId: string | null; folderId: string | null; pcl: Buffer | null }

export interface SentRecord { user: MapiUser; mailbox: MailboxRef; message: ComposedMessage; saveCopy: boolean }

export class MemoryStore implements MailStore {
  readonly mailboxes = new Map<string, MailboxRef>();
  readonly folders: Array<FolderRecord & { mailboxId: string }> = [];
  readonly messages: MemoryMessage[] = [];
  readonly sent: SentRecord[] = [];
  /** Foreign mailboxes a user may open: userId → refs. */
  readonly access = new Map<string, MailboxRef[]>();
  readonly directory = new Map<string, string>();
  limits: SubmissionLimits = { maxMessageBytes: 25 * 1024 * 1024, maxRecipients: 100 };
  /** Messages stored by importMessage (with their options). */
  readonly imported: Array<{ message: ComposedMessage; opts: ImportOptions }> = [];
  readonly replaced = new Map<string, Set<bigint>>();
  readonly mapiObjects: MemoryMapiObject[] = [];
  private seq = 0;
  private uid = 100;
  private modSeq = 0n;
  private nextLocalId = LOCAL_ID_BASE;

  addMailbox(ref: MailboxRef, folders: string[] = ['INBOX', 'Drafts', 'Sent', 'Trash', 'Junk', 'Archive']): void {
    this.mailboxes.set(ref.mailboxId, ref);
    for (const name of folders) this.addFolder(ref.mailboxId, name, null);
  }

  addFolder(mailboxId: string, name: string, parentId: string | null, displayName = name): FolderRecord & { mailboxId: string } {
    const f = {
      id: `f${++this.seq}`, mailboxId, name, displayName, parentId, totalCount: 0, unreadCount: 0,
      createdAt: new Date('2026-01-01T00:00:00Z'), clientId: null,
    };
    this.folders.push(f);
    return f;
  }

  folderByName(mailboxId: string, name: string): FolderRecord & { mailboxId: string } {
    const f = this.folders.find((x) => x.mailboxId === mailboxId && x.name === name);
    if (!f) throw new Error(`no folder ${name}`);
    return f;
  }

  addMessage(folderId: string, fields: Partial<MessageSummary> & { bodyText?: string; bodyHtml?: string; attachments?: Array<AttachmentRecord & { data: Buffer }> } = {}): MemoryMessage {
    const atts = fields.attachments ?? [];
    const modSeq = ++this.modSeq;
    const summary: MessageSummary = {
      id: `m${++this.seq}`, folderId, uid: ++this.uid, flags: [], subject: 'Hello', fromAddr: 'sender@example.test',
      fromName: 'Sender', toAddrs: ['user@example.test'], ccAddrs: [], messageIdHeader: `<m${this.seq}@example.test>`,
      inReplyTo: null, date: new Date('2026-02-01T10:00:00Z'), createdAt: new Date('2026-02-01T10:00:05Z'),
      rawSize: 1234, hasAttachments: atts.length > 0, modSeq, createdModSeq: modSeq, clientId: null, pcl: null, ...fields,
    };
    const msg: MemoryMessage = {
      summary,
      content: {
        bodyText: fields.bodyText ?? 'Body text', bodyHtml: fields.bodyHtml ?? '', bccAddrs: [],
        attachments: atts.map(({ data: _d, ...rec }) => rec),
      },
      attachmentData: new Map(atts.map((a) => [a.id, a.data])),
      deleted: false,
    };
    this.messages.push(msg);
    this.recount(folderId);
    return msg;
  }

  private live(folderId: string): MemoryMessage[] {
    return this.messages.filter((m) => !m.deleted && m.summary.folderId === folderId);
  }

  private recount(folderId: string): void {
    const f = this.folders.find((x) => x.id === folderId);
    if (!f) return;
    const live = this.live(folderId);
    f.totalCount = live.length;
    f.unreadCount = live.filter((m) => !m.summary.flags.includes('\\Seen')).length;
  }

  async resolveLogon(user: MapiUser, essdn: string): Promise<MailboxRef | null> {
    const own = [...this.mailboxes.values()].find((m) => m.kind === 'own' && m.directoryId === user.userId) ?? null;
    if (!essdn) return own;
    const id = essdn.slice(essdn.lastIndexOf('=') + 1);
    if (id === user.userId) return own;
    return (this.access.get(user.userId) ?? []).find((m) => m.directoryId === id) ?? null;
  }

  async resolveLegacyDn(dn: string): Promise<string | null> {
    return this.directory.get(dn.slice(dn.lastIndexOf('=') + 1)) ?? null;
  }

  async listFolders(mailboxId: string): Promise<FolderRecord[]> {
    return this.folders.filter((f) => f.mailboxId === mailboxId)
      .map(({ mailboxId: _m, ...f }) => ({ ...f, clientId: this.mapiObjects.find((o) => o.folderId === f.id)?.clientId ?? null }));
  }

  /** A summary with its MapiObject data (only while the row lies in the ID's mailbox). */
  private withMapi(s: MessageSummary): MessageSummary {
    const o = this.mapiObjects.find((x) => x.messageId === s.id);
    const valid = o !== undefined && o.mailboxId === this.folders.find((f) => f.id === s.folderId)?.mailboxId;
    return { ...s, clientId: valid ? o.clientId : null, pcl: valid ? o.pcl : null };
  }

  async createFolder(mailbox: MailboxRef, parent: FolderRecord | null, displayName: string): Promise<FolderRecord | 'exists' | 'invalid-name'> {
    const name = parent ? `${parent.name}.${displayName}` : displayName;
    if (this.folders.some((f) => f.mailboxId === mailbox.mailboxId && f.name === name)) return 'exists';
    const { mailboxId: _m, ...f } = this.addFolder(mailbox.mailboxId, name, parent?.id ?? null, displayName);
    return f;
  }

  async deleteFolder(mailbox: MailboxRef, folderId: string): Promise<'ok' | 'not-found' | 'no-trash'> {
    const i = this.folders.findIndex((f) => f.id === folderId && f.mailboxId === mailbox.mailboxId);
    if (i < 0) return 'not-found';
    this.folders.splice(i, 1);
    for (const o of this.mapiObjects) if (o.folderId === folderId) o.folderId = null; // onDelete SetNull
    return 'ok';
  }

  async listMessages(folderId: string): Promise<MessageSummary[]> {
    return this.live(folderId).map((m) => this.withMapi(m.summary));
  }

  async findMessage(folderId: string, uid: number): Promise<MessageSummary | null> {
    const m = this.live(folderId).find((x) => x.summary.uid === uid);
    return m ? this.withMapi(m.summary) : null;
  }

  async loadContent(message: MessageSummary): Promise<MessageContent> {
    const m = this.messages.find((x) => x.summary.id === message.id);
    if (!m) throw new Error('vanished');
    return m.content;
  }

  async loadAttachment(id: string): Promise<Buffer> {
    for (const m of this.messages) { const d = m.attachmentData.get(id); if (d) return d; }
    throw new Error('no attachment');
  }

  async setRead(_mailbox: MailboxRef, message: MessageSummary, read: boolean): Promise<bigint | null> {
    const m = this.messages.find((x) => x.summary.id === message.id)!;
    const flags = m.summary.flags.filter((f) => f !== '\\Seen');
    if (m.summary.flags.includes('\\Seen') === read) return null;
    m.summary.flags = read ? [...flags, '\\Seen'] : flags;
    m.summary.modSeq = ++this.modSeq;
    this.recount(m.summary.folderId);
    return m.summary.modSeq;
  }

  /** Changes a message's flags with a new modSeq (another client, tests). */
  touch(message: MemoryMessage, flags: string[]): void {
    message.summary.flags = flags;
    message.summary.modSeq = ++this.modSeq;
    this.recount(message.summary.folderId);
  }

  async deleteMessages(_mailbox: MailboxRef, folderId: string, uids: number[]): Promise<number> {
    const hit = this.live(folderId).filter((m) => uids.includes(m.summary.uid));
    for (const m of hit) { m.deleted = true; m.summary.modSeq = ++this.modSeq; }
    this.recount(folderId);
    return hit.length;
  }

  async moveOrCopy(source: { folderId: string }, target: { folderId: string }, uids: number[], copy: boolean): Promise<number> {
    const hit = this.live(source.folderId).filter((m) => uids.includes(m.summary.uid));
    for (const m of hit) {
      const modSeq = ++this.modSeq;
      if (copy) {
        this.messages.push({ ...m, summary: { ...m.summary, id: `m${++this.seq}`, uid: ++this.uid, folderId: target.folderId, modSeq, createdModSeq: modSeq } });
      } else {
        Object.assign(m.summary, { folderId: target.folderId, uid: ++this.uid, modSeq, createdModSeq: modSeq });
      }
    }
    this.recount(source.folderId);
    this.recount(target.folderId);
    return hit.length;
  }

  async saveDraft(mailbox: MailboxRef, folderId: string, message: ComposedMessage, replaces: MessageSummary | null): Promise<MessageSummary> {
    if (replaces) await this.deleteMessages(mailbox, replaces.folderId, [replaces.uid]);
    const m = this.addMessage(folderId, {
      flags: ['\\Draft', '\\Seen'], subject: message.subject, fromAddr: mailbox.email, toAddrs: message.to, ccAddrs: message.cc,
      bodyText: message.bodyText, bodyHtml: message.bodyHtml,
    });
    return { ...m.summary };
  }

  async submissionLimits(): Promise<SubmissionLimits> {
    return this.limits;
  }

  async submit(user: MapiUser, mailbox: MailboxRef, message: ComposedMessage, opts: { saveCopy: boolean; draft: MessageSummary | null }): Promise<SubmitResult> {
    if (mailbox.readOnly) return { ok: false, reason: 'read-only' };
    const recipients = message.to.length + message.cc.length + message.bcc.length;
    if (recipients === 0) return { ok: false, reason: 'no-recipients' };
    if (recipients > this.limits.maxRecipients) return { ok: false, reason: 'too-many-recipients' };
    const size = message.bodyText.length + message.bodyHtml.length + message.attachments.reduce((n, a) => n + a.content.length, 0);
    if (size > this.limits.maxMessageBytes) return { ok: false, reason: 'too-large' };
    this.sent.push({ user, mailbox, message, saveCopy: opts.saveCopy });
    if (opts.draft) await this.deleteMessages(mailbox, opts.draft.folderId, [opts.draft.uid]);
    return { ok: true, jobId: `job-${this.sent.length}` };
  }

  async highestModSeq(): Promise<bigint> {
    return this.modSeq;
  }

  async messagesCreatedSince(folderIds: readonly string[], sinceModSeq: bigint, limit: number): Promise<NewMessage[]> {
    return this.messages
      .filter((m) => !m.deleted && folderIds.includes(m.summary.folderId) && m.summary.createdModSeq > sinceModSeq)
      .sort((a, b) => Number(a.summary.createdModSeq - b.summary.createdModSeq))
      .slice(0, limit)
      .map((m) => ({
        folderId: m.summary.folderId, uid: m.summary.uid, read: m.summary.flags.includes('\\Seen'),
        createdModSeq: m.summary.createdModSeq, clientId: this.withMapi(m.summary).clientId,
      }));
  }

  async importMessage(_mailbox: MailboxRef, folderId: string, message: ComposedMessage, opts: ImportOptions): Promise<MessageSummary> {
    this.imported.push({ message, opts });
    const m = this.addMessage(folderId, {
      flags: opts.read ? ['\\Seen'] : [], subject: message.subject, fromAddr: message.from ?? '', toAddrs: message.to,
      ccAddrs: message.cc, bodyText: message.bodyText, bodyHtml: message.bodyHtml, ...(opts.date ? { date: opts.date } : {}),
    });
    return { ...m.summary };
  }

  async renameFolder(mailbox: MailboxRef, folderId: string, parent: FolderRecord | null, displayName: string): Promise<'ok' | 'exists' | 'invalid-name' | 'not-found'> {
    const f = this.folders.find((x) => x.id === folderId && x.mailboxId === mailbox.mailboxId);
    if (!f) return 'not-found';
    const name = parent ? `${parent.name}.${displayName}` : displayName;
    if (this.folders.some((x) => x.mailboxId === mailbox.mailboxId && x.name === name && x.id !== folderId)) return 'exists';
    const old = f.name;
    for (const x of this.folders) {
      if (x.mailboxId === mailbox.mailboxId && x.name.startsWith(`${old}.`)) x.name = name + x.name.slice(old.length);
    }
    Object.assign(f, { name, displayName, parentId: parent?.id ?? null });
    return 'ok';
  }

  async reserveLocalIds(_mailboxId: string, count: number): Promise<bigint> {
    const first = this.nextLocalId;
    this.nextLocalId += BigInt(count);
    return first;
  }

  async localIdsHandedOutBelow(): Promise<bigint | null> {
    return this.nextLocalId;
  }

  async findMessagesByCounters(folderId: string, counters: readonly bigint[]): Promise<Map<bigint, MessageSummary>> {
    const out = new Map<bigint, MessageSummary>();
    const live = this.live(folderId).map((m) => this.withMapi(m.summary));
    for (const c of counters) {
      const hit = live.find((s) => BigInt(s.uid) === c) ?? live.find((s) => s.clientId === c);
      if (hit) out.set(c, hit);
    }
    return out;
  }

  async messageByRowId(id: string): Promise<MessageSummary | null> {
    const m = this.messages.find((x) => x.summary.id === id && !x.deleted);
    return m ? this.withMapi(m.summary) : null;
  }

  async clientIdOwner(mailboxId: string, clientId: bigint): Promise<ClientIdOwner | null> {
    const o = this.mapiObjects.find((x) => x.mailboxId === mailboxId && x.clientId === clientId);
    if (!o) return null;
    if (o.folderId) return { kind: 'folder', folderId: o.folderId };
    if (o.messageId && this.messages.some((m) => m.summary.id === o.messageId && !m.deleted)) return { kind: 'message', messageId: o.messageId };
    return { kind: 'retired' };
  }

  async assignedClientIds(mailboxId: string, ranges: readonly IdRange[]): Promise<bigint[]> {
    const sorted = normalize(ranges);
    return this.mapiObjects.filter((o) => o.mailboxId === mailboxId && o.clientId !== null && contains(sorted, o.clientId)).map((o) => o.clientId!);
  }

  async bindMapiObject(mailboxId: string, target: MapiObjectTarget, data: { clientId?: bigint; pcl?: Buffer }): Promise<void> {
    const isMine = (o: MemoryMapiObject): boolean => ('messageId' in target ? o.messageId === target.messageId : o.folderId === target.folderId);
    const bind = (o: MemoryMapiObject): void => {
      o.messageId = 'messageId' in target ? target.messageId : null;
      o.folderId = 'folderId' in target ? target.folderId : null;
      if (data.pcl) o.pcl = data.pcl;
    };
    let mine = this.mapiObjects.find(isMine);
    if (data.clientId !== undefined && mine && mine.clientId !== null && mine.clientId !== data.clientId) {
      mine.messageId = null; mine.folderId = null; mine = undefined; // the old ID retires
    }
    const holder = data.clientId === undefined ? undefined : this.mapiObjects.find((o) => o.mailboxId === mailboxId && o.clientId === data.clientId);
    if (holder && holder !== mine) {
      if (mine) this.mapiObjects.splice(this.mapiObjects.indexOf(mine), 1);
      bind(holder);
    } else if (mine) {
      if (data.clientId !== undefined) mine.clientId = data.clientId;
      if (data.pcl) mine.pcl = data.pcl;
    } else {
      const o: MemoryMapiObject = { mailboxId, clientId: data.clientId ?? null, messageId: null, folderId: null, pcl: null };
      bind(o);
      this.mapiObjects.push(o);
    }
  }

  async replacedLocalIds(mailboxId: string): Promise<Set<bigint>> {
    return new Set(this.replaced.get(mailboxId) ?? []);
  }

  async addReplacedLocalIds(mailboxId: string, ids: readonly bigint[]): Promise<void> {
    const set = this.replaced.get(mailboxId) ?? new Set<bigint>();
    for (const id of ids) set.add(id);
    this.replaced.set(mailboxId, set);
  }

  async foreignAccess(user: MapiUser, mailbox: MailboxRef): Promise<MailboxRef | null> {
    return (this.access.get(user.userId) ?? []).find((m) => m.mailboxId === mailbox.mailboxId) ?? null;
  }
}

/** In-memory address book source (test-only): the same records for every user. */
export class MemoryDirectory implements DirectoryStore {
  records: DirectoryRecord[] = [];
  loads = 0;

  async listDirectory(): Promise<DirectoryRecord[]> {
    this.loads += 1;
    return this.records;
  }
}
