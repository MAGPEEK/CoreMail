/**
 * PIM Property-Mapper (v5.1.0)
 *
 * Lädt Calendar/Contact/Task/Note-Items aus Prisma und mapt sie auf vollständige
 * MAPI-Property-Sets (Standard + Named Properties via PSETID_*).
 *
 * Wird von handleRopGetPropertiesAll (in rop/message.ts) verwendet wenn das
 * Message-Handle einen `pimKind` gesetzt hat.
 */

import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { PR } from '../rop-types.js';
import {
  PSETID_Appointment, PSETID_Address, PSETID_Task, PSETID_Note,
  LID_LOCATION, LID_APPOINTMENT_START_WHOLE, LID_APPOINTMENT_END_WHOLE,
  LID_APPOINTMENT_DURATION, LID_APPOINTMENT_SUB_TYPE, LID_BUSY_STATUS,
  LID_APPOINTMENT_SEQUENCE, LID_RECURRING, LID_APPOINTMENT_RECUR,
  LID_EMAIL1_DISPLAY_NAME, LID_EMAIL1_ADDRESS_TYPE, LID_EMAIL1_EMAIL_ADDRESS,
  LID_EMAIL2_DISPLAY_NAME, LID_EMAIL2_EMAIL_ADDRESS, LID_FILE_AS,
  LID_TASK_STATUS, LID_PERCENT_COMPLETE, LID_TASK_START_DATE,
  LID_TASK_DUE_DATE, LID_TASK_DATE_COMPLETED, LID_TASK_COMPLETE, LID_TASK_OWNER,
  LID_NOTE_COLOR, LID_NOTE_WIDTH, LID_NOTE_HEIGHT,
  getNamedPropMap, resolveNamedProperties, saveNamedPropMap, lidProp,
} from '../named-properties.js';
import { encodeRecurrencePattern } from '../recurrence-pattern.js';

const log = createLogger('mapi:rop:pim-properties');

/**
 * Erstellt die Property-Map für eine bestimmte PIM-Item. Allokiert auch die
 * benötigten Named Properties in der Session (idempotent — wird bei jedem
 * GetPropertiesAll-Call aufgerufen, aber bereits-allozierte IDs werden
 * wiederverwendet).
 */
export async function buildPimPropertyList(
  sessionToken: string,
  pimKind: 'appointment' | 'contact' | 'task' | 'note',
  itemId: string,
): Promise<Map<number, unknown>> {
  // Standard-Named-Properties allokieren (oder reuse falls bereits da)
  const map = await getNamedPropMap(sessionToken);

  switch (pimKind) {
    case 'appointment': return buildAppointmentProps(sessionToken, map, itemId);
    case 'contact':     return buildContactProps(sessionToken, map, itemId);
    case 'task':        return buildTaskProps(sessionToken, map, itemId);
    case 'note':        return buildNoteProps(sessionToken, map, itemId);
  }
}

// ── IPM.Appointment ──────────────────────────────────────────────────────────

async function buildAppointmentProps(
  sessionToken: string,
  baseMap: Awaited<ReturnType<typeof getNamedPropMap>>,
  itemId: string,
): Promise<Map<number, unknown>> {
  const ev = await prisma.calendarEvent.findUnique({
    where: { id: itemId },
    select: {
      id: true, summary: true, description: true, location: true,
      dtStart: true, dtEnd: true, allDay: true, recurring: true,
      rrule: true, organizer: true, sequence: true, classification: true,
    },
  }).catch(() => null);

  const m = new Map<number, unknown>();
  if (!ev) return m;

  // Standard MAPI properties (immer als PR_*)
  m.set(PR.PR_SUBJECT_W,             ev.summary);
  m.set(PR.PR_NORMALIZED_SUBJECT_W,  ev.summary);
  m.set(PR.PR_SUBJECT_PREFIX_W,      '');
  m.set(PR.PR_BODY_W,                ev.description);
  m.set(PR.PR_MESSAGE_CLASS_W,       'IPM.Appointment');
  m.set(PR.PR_MESSAGE_DELIVERY_TIME, ev.dtStart);
  m.set(PR.PR_CREATION_TIME,         ev.dtStart);
  m.set(PR.PR_LAST_MODIFICATION_TIME,ev.dtEnd);
  m.set(PR.PR_MESSAGE_SIZE,          (ev.summary.length + ev.description.length) * 2);
  m.set(PR.PR_MESSAGE_FLAGS,         0x01);
  m.set(PR.PR_HAS_ATTACH,            false);
  if (ev.organizer) {
    m.set(PR.PR_SENDER_NAME_W,           ev.organizer);
    m.set(PR.PR_SENDER_EMAIL_ADDRESS_W,  ev.organizer);
  }

  // Named Properties via PSETID_Appointment
  const reqs = [
    lidProp(PSETID_Appointment, LID_LOCATION),
    lidProp(PSETID_Appointment, LID_APPOINTMENT_START_WHOLE),
    lidProp(PSETID_Appointment, LID_APPOINTMENT_END_WHOLE),
    lidProp(PSETID_Appointment, LID_APPOINTMENT_DURATION),
    lidProp(PSETID_Appointment, LID_APPOINTMENT_SUB_TYPE),
    lidProp(PSETID_Appointment, LID_BUSY_STATUS),
    lidProp(PSETID_Appointment, LID_APPOINTMENT_SEQUENCE),
    lidProp(PSETID_Appointment, LID_RECURRING),
    lidProp(PSETID_Appointment, LID_APPOINTMENT_RECUR),
  ];
  const { ids, map: newMap } = resolveNamedProperties(baseMap, reqs);
  await saveNamedPropMap(sessionToken, newMap);

  const [idLocation, idStart, idEnd, idDuration, idSubType, idBusy, idSeq, idRecur, idRecurPat] = ids;

  // PT_UNICODE = 0x001F, PT_SYSTIME = 0x0040, PT_LONG = 0x0003, PT_BOOLEAN = 0x000B
  // Property-Tag = (id << 16) | type
  const tag = (id: number | undefined, type: number) => (((id ?? 0) & 0xFFFF) << 16) | (type & 0xFFFF);

  m.set(tag(idLocation, 0x001F),  ev.location);
  m.set(tag(idStart,    0x0040),  ev.dtStart);
  m.set(tag(idEnd,      0x0040),  ev.dtEnd);
  const durationMin = Math.floor((ev.dtEnd.getTime() - ev.dtStart.getTime()) / 60000);
  m.set(tag(idDuration, 0x0003),  durationMin);
  m.set(tag(idSubType,  0x000B),  ev.allDay);
  m.set(tag(idBusy,     0x0003),  2);                // 2 = Busy (Default)
  m.set(tag(idSeq,      0x0003),  ev.sequence);
  m.set(tag(idRecur,    0x000B),  ev.recurring);

  // v5.2.0: Recurrence Pattern Binary für PidLidAppointmentRecur (PT_BINARY)
  if (ev.recurring && ev.rrule) {
    try {
      const recurBin = encodeRecurrencePattern(ev.rrule, ev.dtStart, ev.dtEnd);
      m.set(tag(idRecurPat, 0x0102), recurBin);
    } catch (err) {
      log.warn({ err, rrule: ev.rrule }, 'encodeRecurrencePattern failed — skip');
    }
  }

  log.debug({ itemId, namedCount: ids.length, recurring: ev.recurring }, 'buildAppointmentProps OK');
  return m;
}

// ── IPM.Contact ──────────────────────────────────────────────────────────────

async function buildContactProps(
  sessionToken: string,
  baseMap: Awaited<ReturnType<typeof getNamedPropMap>>,
  itemId: string,
): Promise<Map<number, unknown>> {
  const c = await prisma.contact.findUnique({
    where: { id: itemId },
    select: {
      id: true, displayName: true, email: true, email2: true,
      phone: true, mobile: true, company: true, department: true,
      jobTitle: true, notes: true,
    },
  }).catch(() => null);

  const m = new Map<number, unknown>();
  if (!c) return m;

  // Standard properties
  m.set(PR.PR_DISPLAY_NAME_W,        c.displayName);
  m.set(PR.PR_SUBJECT_W,             c.displayName);
  m.set(PR.PR_MESSAGE_CLASS_W,       'IPM.Contact');
  m.set(PR.PR_BODY_W,                c.notes);
  m.set(PR.PR_SENDER_NAME_W,         c.displayName);
  m.set(PR.PR_SENDER_EMAIL_ADDRESS_W, c.email);
  m.set(PR.PR_MESSAGE_FLAGS,         0x01);
  m.set(PR.PR_HAS_ATTACH,            false);

  // Named Properties via PSETID_Address
  const reqs = [
    lidProp(PSETID_Address, LID_EMAIL1_DISPLAY_NAME),
    lidProp(PSETID_Address, LID_EMAIL1_ADDRESS_TYPE),
    lidProp(PSETID_Address, LID_EMAIL1_EMAIL_ADDRESS),
    lidProp(PSETID_Address, LID_EMAIL2_DISPLAY_NAME),
    lidProp(PSETID_Address, LID_EMAIL2_EMAIL_ADDRESS),
    lidProp(PSETID_Address, LID_FILE_AS),
  ];
  const { ids, map: newMap } = resolveNamedProperties(baseMap, reqs);
  await saveNamedPropMap(sessionToken, newMap);

  const [idE1Name, idE1Type, idE1Addr, idE2Name, idE2Addr, idFileAs] = ids;
  const tag = (id: number | undefined, type: number) => (((id ?? 0) & 0xFFFF) << 16) | (type & 0xFFFF);

  m.set(tag(idE1Name, 0x001F), c.displayName);
  m.set(tag(idE1Type, 0x001F), 'SMTP');
  m.set(tag(idE1Addr, 0x001F), c.email);
  if (c.email2) {
    m.set(tag(idE2Name, 0x001F), c.displayName);
    m.set(tag(idE2Addr, 0x001F), c.email2);
  }
  m.set(tag(idFileAs, 0x001F), c.displayName);

  // Standard MAPI fields for company/jobTitle/phones
  // (PR_COMPANY_NAME_W = 0x3A16, PR_TITLE_W = 0x3A17, PR_BUSINESS_TELEPHONE_NUMBER_W = 0x3A08,
  //  PR_MOBILE_TELEPHONE_NUMBER_W = 0x3A1C, PR_DEPARTMENT_NAME_W = 0x3A18)
  const stdTag = (id: number, type: number) => ((id & 0xFFFF) << 16) | (type & 0xFFFF);
  if (c.company)    m.set(stdTag(0x3A16, 0x001F), c.company);
  if (c.jobTitle)   m.set(stdTag(0x3A17, 0x001F), c.jobTitle);
  if (c.department) m.set(stdTag(0x3A18, 0x001F), c.department);
  if (c.phone)      m.set(stdTag(0x3A08, 0x001F), c.phone);
  if (c.mobile)     m.set(stdTag(0x3A1C, 0x001F), c.mobile);

  log.debug({ itemId, displayName: c.displayName }, 'buildContactProps OK');
  return m;
}

// ── IPM.Task ─────────────────────────────────────────────────────────────────

async function buildTaskProps(
  sessionToken: string,
  baseMap: Awaited<ReturnType<typeof getNamedPropMap>>,
  itemId: string,
): Promise<Map<number, unknown>> {
  const t = await prisma.task.findUnique({
    where: { id: itemId },
    select: {
      id: true, subject: true, body: true, dueDate: true, completedAt: true,
      priority: true, status: true, createdAt: true, updatedAt: true,
    },
  }).catch(() => null);

  const m = new Map<number, unknown>();
  if (!t) return m;

  m.set(PR.PR_SUBJECT_W,             t.subject);
  m.set(PR.PR_BODY_W,                t.body);
  m.set(PR.PR_MESSAGE_CLASS_W,       'IPM.Task');
  m.set(PR.PR_CREATION_TIME,         t.createdAt);
  m.set(PR.PR_LAST_MODIFICATION_TIME,t.updatedAt);
  m.set(PR.PR_PRIORITY,              parseInt(t.priority, 10) || 0);
  m.set(PR.PR_MESSAGE_FLAGS,         0x01);
  m.set(PR.PR_HAS_ATTACH,            false);
  m.set(PR.PR_IMPORTANCE,            1);
  if (t.dueDate) m.set(PR.PR_MESSAGE_DELIVERY_TIME, t.dueDate);

  // Named Properties via PSETID_Task
  const reqs = [
    lidProp(PSETID_Task, LID_TASK_STATUS),
    lidProp(PSETID_Task, LID_PERCENT_COMPLETE),
    lidProp(PSETID_Task, LID_TASK_START_DATE),
    lidProp(PSETID_Task, LID_TASK_DUE_DATE),
    lidProp(PSETID_Task, LID_TASK_DATE_COMPLETED),
    lidProp(PSETID_Task, LID_TASK_COMPLETE),
    lidProp(PSETID_Task, LID_TASK_OWNER),
  ];
  const { ids, map: newMap } = resolveNamedProperties(baseMap, reqs);
  await saveNamedPropMap(sessionToken, newMap);

  const [idStatus, idPct, idStart, idDue, idDone, idComplete, idOwner] = ids;
  const tag = (id: number | undefined, type: number) => (((id ?? 0) & 0xFFFF) << 16) | (type & 0xFFFF);

  // TaskStatus: 0=NotStarted, 1=InProgress, 2=Completed, 3=Waiting, 4=Deferred
  const isComplete = t.completedAt !== null || t.status === 'COMPLETED';
  m.set(tag(idStatus,   0x0003), isComplete ? 2 : (t.status === 'IN_PROGRESS' ? 1 : 0));
  m.set(tag(idPct,      0x0005), isComplete ? 1.0 : 0.0);    // PT_DOUBLE in echtem MAPI; vereinfacht
  m.set(tag(idStart,    0x0040), t.createdAt);
  if (t.dueDate)     m.set(tag(idDue,  0x0040), t.dueDate);
  if (t.completedAt) m.set(tag(idDone, 0x0040), t.completedAt);
  m.set(tag(idComplete, 0x000B), isComplete);
  m.set(tag(idOwner,    0x001F), '');                          // Owner-email — vereinfacht

  log.debug({ itemId, subject: t.subject }, 'buildTaskProps OK');
  return m;
}

// ── IPM.StickyNote ───────────────────────────────────────────────────────────

async function buildNoteProps(
  sessionToken: string,
  baseMap: Awaited<ReturnType<typeof getNamedPropMap>>,
  itemId: string,
): Promise<Map<number, unknown>> {
  const n = await prisma.note.findUnique({
    where: { id: itemId },
    select: {
      id: true, subject: true, body: true, createdAt: true, updatedAt: true,
    },
  }).catch(() => null);

  const m = new Map<number, unknown>();
  if (!n) return m;

  m.set(PR.PR_SUBJECT_W,              n.subject);
  m.set(PR.PR_BODY_W,                 n.body);
  m.set(PR.PR_MESSAGE_CLASS_W,        'IPM.StickyNote');
  m.set(PR.PR_CREATION_TIME,          n.createdAt);
  m.set(PR.PR_LAST_MODIFICATION_TIME, n.updatedAt);
  m.set(PR.PR_MESSAGE_FLAGS,          0x01);
  m.set(PR.PR_HAS_ATTACH,             false);

  const reqs = [
    lidProp(PSETID_Note, LID_NOTE_COLOR),
    lidProp(PSETID_Note, LID_NOTE_WIDTH),
    lidProp(PSETID_Note, LID_NOTE_HEIGHT),
  ];
  const { ids, map: newMap } = resolveNamedProperties(baseMap, reqs);
  await saveNamedPropMap(sessionToken, newMap);

  const [idColor, idWidth, idHeight] = ids;
  const tag = (id: number | undefined, type: number) => (((id ?? 0) & 0xFFFF) << 16) | (type & 0xFFFF);

  m.set(tag(idColor,  0x0003), 3);     // 3 = Yellow (Default)
  m.set(tag(idWidth,  0x0003), 200);
  m.set(tag(idHeight, 0x0003), 166);

  log.debug({ itemId, subject: n.subject }, 'buildNoteProps OK');
  return m;
}
