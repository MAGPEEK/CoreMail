/**
 * RopLogon (MS-OXCSTOR 2.2.1.1), RopRelease (MS-OXCROPS 2.2.15.3),
 * RopGetReceiveFolder (MS-OXCSTOR 2.2.1.2) and RopRegisterNotification
 * (MS-OXCNOTIF 2.2.1.2.1 — the subscription is kept; the change bus queues
 * its events, emsmdb/notify).
 */
import { BufferWriter } from '../../wire/writer.js';
import { Ec, RopError, RopId } from '../codes.js';
import {
  defineRop, logonOf, objectAt, objectOf, okResponse, putObject, type RopDef,
} from '../context.js';
import { HANDLE_UNUSED } from '../handles.js';
import { makeId, storeGuids, SpecialCounter } from '../../ids.js';
import { namedPropertiesOf } from '../../props/named.js';
import { toFileTime } from '../../props/values.js';
import { MailboxView, type FolderRole } from '../../objects/mailbox-view.js';
import { commitStream } from './stream.js';
import type { LogonState } from '../../objects/state.js';

const LOGON_PRIVATE = 0x01;
const LOGON_ECHO_MASK = 0x01 | 0x02 | 0x04;
const RESPONSE_RESERVED = 0x01;
const RESPONSE_OWNER_RIGHT = 0x02;
const RESPONSE_SEND_AS_RIGHT = 0x04;

const GWART_TIME = toFileTime(new Date());

/** The 13 FolderIds of a private logon response, in protocol order. */
const FOLDER_ID_ORDER: ReadonlyArray<bigint | FolderRole> = [
  SpecialCounter.Root, SpecialCounter.DeferredAction, SpecialCounter.SpoolerQueue, SpecialCounter.IpmSubtree,
  'inbox', SpecialCounter.Outbox, 'sent', 'trash',
  SpecialCounter.CommonViews, SpecialCounter.Schedule, SpecialCounter.Finder, SpecialCounter.Views, SpecialCounter.Shortcuts,
];

export function logonFolderIds(view: MailboxView): bigint[] {
  return FOLDER_ID_ORDER.map((x) => {
    if (typeof x === 'bigint') return makeId(x);
    const node = view.role(x);
    return node ? makeId(node.counter) : 0n;
  });
}

function writeLogonTime(w: BufferWriter, d: Date): void {
  w.u8(d.getUTCSeconds()).u8(d.getUTCMinutes()).u8(d.getUTCHours()).u8(d.getUTCDay())
    .u8(d.getUTCDate()).u8(d.getUTCMonth() + 1).u16(d.getUTCFullYear());
}

interface LogonReq { outputIndex: number; logonFlags: number; openFlags: number; essdn: string }

export const ropLogon = defineRop<LogonReq>({
  id: RopId.Logon,
  name: 'RopLogon',
  parse(r) {
    const outputIndex = r.u8();
    const logonFlags = r.u8();
    const openFlags = r.u32();
    r.u32(); // StoreState (ignored)
    const size = r.u16();
    const essdn = size > 0 ? r.slice(size).asciiZ('ascii') : '';
    return { outputIndex, logonFlags, openFlags, essdn };
  },
  responseIndex: (req) => req.outputIndex,
  async execute(ctx, req) {
    if ((req.logonFlags & LOGON_PRIVATE) === 0) throw new RopError(Ec.NotFound, 'public folder logons are not supported');
    const mailbox = await ctx.store.resolveLogon(ctx.session.user, req.essdn);
    if (!mailbox) throw new RopError(Ec.LoginPerm, 'no access to the requested mailbox');

    // Logging on with an active LogonId replaces that logon (MS-OXCROPS 2.2.3.1.1).
    ctx.session.objects.releaseLogon(req.logonId);
    ctx.session.logons.delete(req.logonId);
    ctx.session.notifications.drop({ logonId: req.logonId });

    const view = new MailboxView(await ctx.store.listFolders(mailbox.mailboxId));
    const { maxMessageBytes } = await ctx.store.submissionLimits(ctx.session.user);
    const logon: LogonState = {
      logonId: req.logonId, logonFlags: req.logonFlags, mailbox, guids: storeGuids(mailbox.mailboxId), view,
      named: namedPropertiesOf(mailbox.mailboxId), maxSubmitBytes: maxMessageBytes, notifiedModSeq: null,
    };
    putObject(ctx, req.outputIndex, { kind: 'logon', logon }, req.logonId);
    ctx.session.logons.set(req.logonId, logon);

    const w = okResponse(RopId.Logon, req.outputIndex).u8(req.logonFlags & LOGON_ECHO_MASK);
    for (const id of logonFolderIds(view)) w.u64(id);
    const owner = mailbox.kind === 'own';
    w.u8(RESPONSE_RESERVED | (owner ? RESPONSE_OWNER_RIGHT | RESPONSE_SEND_AS_RIGHT : 0));
    w.bytes(logon.guids.mailbox).u16(0x0001).bytes(logon.guids.replica);
    writeLogonTime(w, ctx.now());
    w.u64(GWART_TIME).u32(0);
    return w.toBuffer();
  },
});

interface IndexReq { inputIndex: number }

export const ropRelease = defineRop<IndexReq>({
  id: RopId.Release,
  name: 'RopRelease',
  parse: (r) => ({ inputIndex: r.u8() }),
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const handle = ctx.handles[req.inputIndex];
    if (handle === undefined || handle === HANDLE_UNUSED) return null;
    const released = ctx.session.objects.release(handle);
    ctx.session.notifications.drop({ handle });
    if (released?.kind === 'logon') {
      ctx.session.objects.releaseLogon(released.logon.logonId);
      ctx.session.logons.delete(released.logon.logonId);
      ctx.session.notifications.drop({ logonId: released.logon.logonId });
    }
    // A released stream keeps what was written (MS-OXCPRPT: release commits).
    if (released?.kind === 'stream' && released.stream.dirty) commitStream(released.stream);
    return null;
  },
});

interface ReceiveFolderReq { inputIndex: number; messageClass: string }

export const ropGetReceiveFolder = defineRop<ReceiveFolderReq>({
  id: RopId.GetReceiveFolder,
  name: 'RopGetReceiveFolder',
  parse: (r) => ({ inputIndex: r.u8(), messageClass: r.asciiZ('ascii') }),
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { logon } = objectOf(ctx, req.inputIndex, 'logon');
    const inbox = logon.view.role('inbox');
    if (!inbox) throw new RopError(Ec.NotFound, 'mailbox has no Inbox');
    return okResponse(RopId.GetReceiveFolder, req.inputIndex).u64(makeId(inbox.counter)).asciiZ('', 'ascii').toBuffer();
  },
});

const NOTIFY_EXTENDED = 0x0400;

interface RegisterReq {
  inputIndex: number; outputIndex: number; notificationTypes: number;
  wholeStore: boolean; folderId: bigint; messageId: bigint;
}

export const ropRegisterNotification = defineRop<RegisterReq>({
  id: RopId.RegisterNotification,
  name: 'RopRegisterNotification',
  parse(r) {
    const inputIndex = r.u8();
    const outputIndex = r.u8();
    const notificationTypes = r.u16();
    if (notificationTypes & NOTIFY_EXTENDED) r.u8(); // Reserved
    const wholeStore = r.u8() !== 0;
    const folderId = wholeStore ? 0n : r.u64();
    const messageId = wholeStore ? 0n : r.u64();
    return { inputIndex, outputIndex, notificationTypes, wholeStore, folderId, messageId };
  },
  responseIndex: (req) => req.outputIndex,
  async execute(ctx, req) {
    objectAt(ctx, req.inputIndex);
    const logon = logonOf(ctx, req.logonId);
    // NewMail is announced for messages that arrive after the first subscription.
    logon.notifiedModSeq ??= await ctx.store.highestModSeq(logon.mailbox.mailboxId);
    putObject(ctx, req.outputIndex, {
      kind: 'notification',
      logon,
      subscription: {
        notificationTypes: req.notificationTypes, wholeStore: req.wholeStore,
        folderId: req.folderId, messageId: req.messageId,
      },
    }, req.logonId);
    return okResponse(RopId.RegisterNotification, req.outputIndex).toBuffer();
  },
});

export const logonRops: RopDef[] = [ropLogon, ropRelease, ropGetReceiveFolder, ropRegisterNotification];
