/**
 * MeetingResponse command ([MS-ASCMD] 2.2.1.11).
 *
 * The device answers a meeting request (an iMIP METHOD:REQUEST mail in one of
 * the caller's mail folders):
 *  1. the event is created/updated in the caller's default calendar with the
 *     caller's PARTSTAT (decline: an existing copy is removed),
 *  2. an iTIP REPLY (RFC 5546) is sent to the organizer through the outbound
 *     queue (`smtp-outbound`, same path as SendMail) — only for protocol ≥ 16.0
 *     with SendResponse; at 14.1 the device sends the reply itself,
 *  3. the request mail is moved to Deleted Items (Exchange behaviour — devices
 *     drop it from the Inbox).
 * Result: Status 1 + CalendarId (= CalendarEvent id) for accept/tentative.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '@coremail/storage/prisma';
import {
  attendeesWithResponse, buildITipReplyIcs, buildITipReplyMime, calendarObjectForInvitee,
  announceCalendarChange, expunge, findITipRequest, findOwnAttendee, isWebmailFeatureEnabled, loadRawMessage, moveMessages,
  type ITipPartstat, type RawSourceMessage,
} from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { encodeWbxml, el, getChild, getText, type WbxmlElement } from '../wbxml.js';
import { enqueueRawOutbound, type RawOutboundJob } from '../outbound.js';

const log = createLogger('activesync:meeting-response');

export const MEETING_STATUS = {
  SUCCESS: '1',
  INVALID_REQUEST: '2',
  MAILBOX_ERROR: '3',
  SERVER_ERROR: '4',
} as const;

const USER_RESPONSE: Record<string, ITipPartstat> = { '1': 'ACCEPTED', '2': 'TENTATIVE', '3': 'DECLINED' };

/** Seams for tests (raw message loading and the outbound queue). */
export interface MeetingResponseDeps {
  loadRaw: (msg: RawSourceMessage) => Promise<Buffer>;
  enqueue: (job: RawOutboundJob) => Promise<unknown>;
}

const defaultDeps: MeetingResponseDeps = {
  loadRaw: (msg) => loadRawMessage(msg),
  enqueue: enqueueRawOutbound,
};

const kids = (e: WbxmlElement | undefined): WbxmlElement[] =>
  (e?.children ?? []).filter((c): c is WbxmlElement => typeof c !== 'string');

async function respond(req: WbxmlElement, userId: string, deps: MeetingResponseDeps, protocolVersion: string): Promise<WbxmlElement> {
  const opts = { sendReply: serverSendsReply(req, protocolVersion) };
  const requestId = getText(req, 'RequestId');
  const collectionId = getText(req, 'CollectionId');
  const partstat = USER_RESPONSE[getText(req, 'UserResponse')];
  const result = (status: string, calendarId?: string) => el('Result', undefined, [
    el('RequestId', requestId),
    el('Status', status),
    ...(calendarId ? [el('CalendarId', calendarId)] : []),
  ]);
  if (!requestId || !partstat) return result(MEETING_STATUS.INVALID_REQUEST);

  // The request mail must be in a folder of the caller's own mailbox.
  const folder = collectionId
    ? await prisma.folder.findFirst({ where: { id: collectionId, mailbox: { userId } }, select: { id: true, mailboxId: true, mailbox: { select: { userId: true } } } })
    : null;
  if (!folder || folder.mailbox?.userId !== userId) return result(MEETING_STATUS.INVALID_REQUEST);
  const msg = await prisma.message.findFirst({ where: { id: requestId, folderId: folder.id, deletedAt: null } });
  if (!msg || msg.folderId !== folder.id) return result(MEETING_STATUS.INVALID_REQUEST);

  let raw: Buffer;
  try { raw = await deps.loadRaw(msg as unknown as RawSourceMessage); } catch (err) {
    log.error({ err, userId, requestId }, 'loading meeting request failed');
    return result(MEETING_STATUS.MAILBOX_ERROR);
  }
  const request = findITipRequest(raw);
  if (!request) return result(MEETING_STATUS.INVALID_REQUEST);
  const ev = request.event;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, displayName: true } });
  if (!user) return result(MEETING_STATUS.MAILBOX_ERROR);
  const aliases = await prisma.emailAlias.findMany({ where: { targetUserId: userId, active: true }, select: { address: true } });
  const own = [user.email, ...aliases.map((a) => a.address)].map((a) => a.toLowerCase());
  const responder = findOwnAttendee(ev, own) ?? user.email.toLowerCase();

  // 1. Calendar
  // 8.0.0 (iTIP spoofing): a REQUEST naming one of the caller's own addresses as ORGANIZER
  // is never acted on — the caller organizes that meeting, nobody can invite them to it.
  const organizer = normalizeAddress(ev.organizer);
  if (!organizer || own.includes(organizer)) {
    log.warn({ userId, requestId, uid: ev.uid }, 'meeting request names the caller as organizer — refused');
    return result(MEETING_STATUS.INVALID_REQUEST);
  }
  const existing = await prisma.calendarEvent.findFirst({
    where: { uid: { equals: ev.uid, mode: 'insensitive' }, calendar: { userId } },
    select: { id: true, calendarId: true, sequence: true, organizer: true },
  });
  // An existing event with this UID is only updated or deleted when the request comes
  // from the same organizer. Otherwise anybody who learnt a UID (e.g. from an invite the
  // caller sent) could overwrite or — via Decline — delete the caller's own event.
  if (existing && normalizeAddress(existing.organizer) !== organizer) {
    log.warn({ userId, requestId, uid: ev.uid, eventId: existing.id }, 'meeting request organizer differs from the stored event — refused');
    return result(MEETING_STATUS.INVALID_REQUEST);
  }
  let calendarId: string | undefined;
  if (partstat === 'DECLINED') {
    if (existing) {
      await prisma.calendarEvent.delete({ where: { id: existing.id } });
      announceCalendarChange([existing.calendarId], { action: 'delete', ids: [existing.id] });
    }
  } else {
    const calendar = existing
      ? { id: existing.calendarId }
      : await prisma.calendar.findFirst({ where: { userId }, orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }], select: { id: true } });
    if (!calendar) return result(MEETING_STATUS.MAILBOX_ERROR);
    const data = {
      icalData: calendarObjectForInvitee(request, responder, partstat),
      summary: ev.summary || '(no subject)',
      description: ev.description,
      location: ev.location,
      dtStart: ev.start,
      dtEnd: ev.end,
      allDay: ev.allDay,
      recurring: ev.rrule !== null,
      rrule: ev.rrule,
      organizer: ev.organizer,
      attendees: attendeesWithResponse(ev, responder, partstat),
      status: partstat === 'TENTATIVE' ? 'TENTATIVE' : 'CONFIRMED',
      classification: ev.classification,
      sequence: ev.sequence ?? 0,
      changeKey: Date.now().toString(36),
    };
    const saved = existing
      ? await prisma.calendarEvent.update({ where: { id: existing.id }, data, select: { id: true } })
      : await prisma.calendarEvent.create({ data: { ...data, calendarId: calendar.id, uid: ev.uid }, select: { id: true } });
    calendarId = saved.id;
    announceCalendarChange([calendar.id], { action: existing ? 'update' : 'create', ids: [saved.id] });
  }

  // 2. iTIP REPLY to the organizer (not to ourselves) — only when the server is asked to
  // send it: before EAS 16.0 the client sends the reply itself (SendMail/SmartReply), so
  // a server reply would reach the organizer twice.
  if (opts.sendReply && ev.organizer && ev.organizer.includes('@') && !own.includes(ev.organizer.toLowerCase())) {
    const name = user.displayName || undefined;
    const ics = buildITipReplyIcs(request, { email: responder, ...(name ? { cn: name } : {}) }, partstat);
    const mime = buildITipReplyMime({
      ics, from: { email: responder, ...(name ? { name } : {}) }, to: ev.organizer, summary: ev.summary, partstat,
    });
    try {
      const jobId = `eas-mr-${randomUUID()}`;
      await deps.enqueue({ messageId: jobId, from: responder, to: [ev.organizer], senderUserId: userId, rawMessage: mime.toString('base64') });
      log.info({ userId, jobId, partstat, uid: ev.uid }, 'meeting response REPLY enqueued');
    } catch (err) {
      log.error({ err, userId, requestId }, 'enqueueing meeting REPLY failed');
      return result(MEETING_STATUS.SERVER_ERROR, calendarId);
    }
  }

  // 3. Remove the request from the folder (to Deleted Items when it exists).
  const trash = await prisma.folder.findFirst({ where: { mailboxId: folder.mailboxId, name: 'Trash' }, select: { id: true } });
  if (trash && trash.id !== folder.id) {
    await prisma.$transaction((tx) => moveMessages(tx, [msg.id], trash.id, { targetMailboxId: folder.mailboxId, sourceMailboxId: folder.mailboxId }));
  } else {
    await prisma.$transaction((tx) => expunge(tx, [msg.id], { mailboxId: folder.mailboxId }));
  }

  return result(MEETING_STATUS.SUCCESS, calendarId);
}

/** Calendar address for comparisons: without `mailto:`, trimmed, lower-case. */
export function normalizeAddress(addr: string | null | undefined): string {
  return (addr ?? '').trim().replace(/^mailto:/i, '').toLowerCase();
}

/**
 * [MS-ASCMD] MeetingResponse: the SendResponse element exists from protocol 16.0 on and asks
 * the server to send the response to the organizer. Up to 14.1 the client always sends it
 * itself (as a SendMail / SmartReply after the MeetingResponse).
 *
 * NOTE: the server announces only EAS 12.1/14.0/14.1 (protocol-version.ts), so a conforming
 * client never takes the server-reply path. An unannounced 16.x request is served as 14.1, but
 * the dispatcher passes the version the client named here (as before 9.4), so such a client
 * still gets the reply it asked for. The path is the ready half of EAS 16.x support; 12.1 and
 * 14.x devices send the reply themselves.
 */
export function serverSendsReply(req: WbxmlElement, protocolVersion: string): boolean {
  const version = Number.parseFloat(protocolVersion);
  return Number.isFinite(version) && version >= 16 && !!getChild(req, 'SendResponse');
}

export async function handleMeetingResponse(
  body: WbxmlElement,
  userId: string,
  deps: MeetingResponseDeps = defaultDeps,
  protocolVersion = '14.1',
): Promise<Buffer> {
  const results: WbxmlElement[] = [];
  // 9.4 webmail policy: without the calendar module nothing is written to a calendar —
  // every request answers Status 2 (unreadable policy → 4, nothing changed).
  const calendar = await isWebmailFeatureEnabled(userId, 'calendar').then((on) => (on ? 'on' : 'off'), () => 'error');
  for (const req of kids(body).filter((c) => c.name === 'Request')) {
    if (calendar !== 'on') {
      const status = calendar === 'off' ? MEETING_STATUS.INVALID_REQUEST : MEETING_STATUS.SERVER_ERROR;
      results.push(el('Result', undefined, [el('RequestId', getText(req, 'RequestId')), el('Status', status)]));
      continue;
    }
    try {
      results.push(await respond(req, userId, deps, protocolVersion));
    } catch (err) {
      log.error({ err, userId }, 'MeetingResponse failed');
      results.push(el('Result', undefined, [el('RequestId', getText(req, 'RequestId')), el('Status', MEETING_STATUS.SERVER_ERROR)]));
    }
  }
  return encodeWbxml(el('MeetingResponse', undefined, results));
}
