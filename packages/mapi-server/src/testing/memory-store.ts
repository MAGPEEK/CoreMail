/**
 * In-memory MailStore for the ROP and HTTP tests (test-only). One mailbox per
 * user plus optional foreign mailboxes; sending records the job instead of
 * queueing it.
 */
import type {
  AttachmentRecord, ComposedMessage, FolderRecord, MailboxRef, MailStore, MapiUser, MessageContent,
  MessageSummary, SubmissionLimits, SubmitResult,
} from '../store/types.js';

export interface MemoryMessage {
  summary: MessageSummary;
  content: MessageContent;
  attachmentData: Map<string, Buffer>;
  deleted: boolean;
}

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
  private seq = 0;
  private uid = 100;

  addMailbox(ref: MailboxRef, folders: string[] = ['INBOX', 'Drafts', 'Sent', 'Trash', 'Junk', 'Archive']): void {
    this.mailboxes.set(ref.mailboxId, ref);
    for (const name of folders) this.addFolder(ref.mailboxId, name, null);
  }

  addFolder(mailboxId: string, name: string, parentId: string | null, displayName = name): FolderRecord & { mailboxId: string } {
    const f = { id: `f${++this.seq}`, mailboxId, name, displayName, parentId, totalCount: 0, unreadCount: 0, createdAt: new Date('2026-01-01T00:00:00Z') };
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
    const summary: MessageSummary = {
      id: `m${++this.seq}`, folderId, uid: ++this.uid, flags: [], subject: 'Hello', fromAddr: 'sender@example.test',
      fromName: 'Sender', toAddrs: ['user@example.test'], ccAddrs: [], messageIdHeader: `<m${this.seq}@example.test>`,
      inReplyTo: null, date: new Date('2026-02-01T10:00:00Z'), createdAt: new Date('2026-02-01T10:00:05Z'),
      rawSize: 1234, hasAttachments: atts.length > 0, modSeq: 1n, ...fields,
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
    return this.folders.filter((f) => f.mailboxId === mailboxId).map(({ mailboxId: _m, ...f }) => ({ ...f }));
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
    return 'ok';
  }

  async listMessages(folderId: string): Promise<MessageSummary[]> {
    return this.live(folderId).map((m) => ({ ...m.summary }));
  }

  async findMessage(folderId: string, uid: number): Promise<MessageSummary | null> {
    const m = this.live(folderId).find((x) => x.summary.uid === uid);
    return m ? { ...m.summary } : null;
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

  async setRead(_mailbox: MailboxRef, message: MessageSummary, read: boolean): Promise<void> {
    const m = this.messages.find((x) => x.summary.id === message.id)!;
    const flags = m.summary.flags.filter((f) => f !== '\\Seen');
    m.summary.flags = read ? [...flags, '\\Seen'] : flags;
    this.recount(m.summary.folderId);
  }

  async deleteMessages(_mailbox: MailboxRef, folderId: string, uids: number[]): Promise<number> {
    const hit = this.live(folderId).filter((m) => uids.includes(m.summary.uid));
    for (const m of hit) m.deleted = true;
    this.recount(folderId);
    return hit.length;
  }

  async moveOrCopy(source: { folderId: string }, target: { folderId: string }, uids: number[], copy: boolean): Promise<number> {
    const hit = this.live(source.folderId).filter((m) => uids.includes(m.summary.uid));
    for (const m of hit) {
      if (copy) this.messages.push({ ...m, summary: { ...m.summary, id: `m${++this.seq}`, uid: ++this.uid, folderId: target.folderId } });
      else { m.summary.folderId = target.folderId; m.summary.uid = ++this.uid; }
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
}
