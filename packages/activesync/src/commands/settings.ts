/**
 * Settings command ([MS-ASCMD] 2.2.1.18, EAS 14.0/14.1).
 *
 *  - Oof Get/Set          → UserSettings.oof* (same source as MWA /api/v1/user/oof,
 *                           JMAP VacationResponse and the SMTP auto-reply)
 *  - DeviceInformation Set → ActiveSyncDevice.deviceFriendlyName (other fields accepted)
 *  - UserInformation Get  → primary address + active aliases
 *  - RightsManagementInformation Get → empty (no IRM templates)
 *  - DevicePassword Set   → accepted (no recovery password storage)
 */
import { prisma } from '@coremail/storage/prisma';
import { encodeWbxml, el, getChild, getText, type WbxmlElement } from '../wbxml.js';

export const SETTINGS_STATUS = {
  SUCCESS: '1',
  PROTOCOL_ERROR: '2',
  ACCESS_DENIED: '3',
  SERVER_UNAVAILABLE: '4',
  INVALID_ARGUMENTS: '5',
  CONFLICTING_ARGUMENTS: '6',
} as const;

/** The UserSettings columns the Oof mapping reads and writes. */
export interface OofFields {
  oofEnabled: boolean;
  oofInternal: string;
  oofExternal: string;
  oofExternalEnabled: boolean;
  oofExternalOnlyContacts: boolean;
  oofUseTimeRange: boolean;
  oofStart: Date | null;
  oofEnd: Date | null;
}

export const OOF_DEFAULTS: OofFields = {
  oofEnabled: false, oofInternal: '', oofExternal: '', oofExternalEnabled: true,
  oofExternalOnlyContacts: false, oofUseTimeRange: false, oofStart: null, oofEnd: null,
};

const kids = (e: WbxmlElement | undefined): WbxmlElement[] =>
  (e?.children ?? []).filter((c): c is WbxmlElement => typeof c !== 'string');

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .trim();
}

function oofMessage(kind: 'AppliesToInternal' | 'AppliesToExternalKnown' | 'AppliesToExternalUnknown', enabled: boolean, text: string, bodyType: string): WbxmlElement {
  const html = bodyType.toUpperCase() === 'HTML';
  return el('OofMessage', undefined, [
    el(kind),
    el('Enabled', enabled ? '1' : '0'),
    ...(text ? [el('ReplyMessage', html ? text : htmlToText(text))] : []),
    el('BodyType', html ? 'HTML' : 'Text'),
  ]);
}

/** Pure: Oof Get response content for the stored settings. */
export function oofGetElements(s: OofFields, bodyType: string): WbxmlElement[] {
  const state = !s.oofEnabled ? '0' : s.oofUseTimeRange ? '2' : '1';
  const unknownEnabled = s.oofExternalEnabled && !s.oofExternalOnlyContacts;
  return [
    el('OofState', state),
    ...(s.oofUseTimeRange && s.oofStart ? [el('StartTime', s.oofStart.toISOString())] : []),
    ...(s.oofUseTimeRange && s.oofEnd ? [el('EndTime', s.oofEnd.toISOString())] : []),
    oofMessage('AppliesToInternal', s.oofInternal.trim() !== '', s.oofInternal, bodyType),
    oofMessage('AppliesToExternalKnown', s.oofExternalEnabled, s.oofExternal, bodyType),
    oofMessage('AppliesToExternalUnknown', unknownEnabled, s.oofExternal, bodyType),
  ];
}

/**
 * Pure: apply an Oof <Set> to the stored settings. Returns the new fields or a
 * Settings status on invalid input. OofMessage blocks that are absent keep the
 * stored values (clients may send only the state).
 */
export function applyOofSet(current: OofFields, set: WbxmlElement): { ok: true; fields: OofFields } | { ok: false; status: string } {
  const next: OofFields = { ...current };
  const state = getText(set, 'OofState');
  if (state !== '') {
    if (state === '0') next.oofEnabled = false;
    else if (state === '1') { next.oofEnabled = true; next.oofUseTimeRange = false; }
    else if (state === '2') {
      const start = new Date(getText(set, 'StartTime'));
      const end = new Date(getText(set, 'EndTime'));
      if (isNaN(start.getTime()) || isNaN(end.getTime())) return { ok: false, status: SETTINGS_STATUS.PROTOCOL_ERROR };
      if (end.getTime() <= start.getTime()) return { ok: false, status: SETTINGS_STATUS.CONFLICTING_ARGUMENTS };
      next.oofEnabled = true; next.oofUseTimeRange = true; next.oofStart = start; next.oofEnd = end;
    } else return { ok: false, status: SETTINGS_STATUS.PROTOCOL_ERROR };
  }

  let known: { enabled: boolean; text: string | null } | null = null;
  let unknown: { enabled: boolean; text: string | null } | null = null;
  for (const msg of kids(set).filter((c) => c.name === 'OofMessage')) {
    const enabled = getText(msg, 'Enabled') === '1';
    const replyEl = getChild(msg, 'ReplyMessage');
    const text = replyEl ? (replyEl.text ?? '') : null;
    if (getChild(msg, 'AppliesToInternal')) {
      // No separate "internal enabled" column: disabled = no internal text.
      next.oofInternal = enabled ? (text ?? current.oofInternal) : '';
    } else if (getChild(msg, 'AppliesToExternalKnown')) known = { enabled, text };
    else if (getChild(msg, 'AppliesToExternalUnknown')) unknown = { enabled, text };
  }
  if (known || unknown) {
    const knownOn = known?.enabled ?? (current.oofExternalEnabled);
    const unknownOn = unknown?.enabled ?? (current.oofExternalEnabled && !current.oofExternalOnlyContacts);
    next.oofExternalEnabled = knownOn || unknownOn;
    next.oofExternalOnlyContacts = knownOn && !unknownOn;
    const text = (unknownOn ? unknown?.text : null) ?? (knownOn ? known?.text : null) ?? unknown?.text ?? known?.text ?? null;
    if (text !== null) next.oofExternal = text;
  }
  return { ok: true, fields: next };
}

async function loadOof(userId: string): Promise<OofFields> {
  const s = await prisma.userSettings.findUnique({ where: { userId } });
  if (!s) return { ...OOF_DEFAULTS };
  return {
    oofEnabled: s.oofEnabled, oofInternal: s.oofInternal, oofExternal: s.oofExternal,
    oofExternalEnabled: s.oofExternalEnabled, oofExternalOnlyContacts: s.oofExternalOnlyContacts,
    oofUseTimeRange: s.oofUseTimeRange, oofStart: s.oofStart, oofEnd: s.oofEnd,
  };
}

async function handleOof(oof: WbxmlElement, userId: string): Promise<WbxmlElement> {
  const get = getChild(oof, 'Get');
  const set = getChild(oof, 'Set');
  if (get) {
    const s = await loadOof(userId);
    return el('Oof', undefined, [
      el('Status', SETTINGS_STATUS.SUCCESS),
      el('Get', undefined, oofGetElements(s, getText(get, 'BodyType') || 'Text')),
    ]);
  }
  if (set) {
    const res = applyOofSet(await loadOof(userId), set);
    if (!res.ok) return el('Oof', undefined, [el('Status', res.status)]);
    const f = res.fields;
    await prisma.userSettings.upsert({
      where: { userId },
      update: { ...f },
      create: { userId, ...f },
    });
    return el('Oof', undefined, [el('Status', SETTINGS_STATUS.SUCCESS)]);
  }
  return el('Oof', undefined, [el('Status', SETTINGS_STATUS.PROTOCOL_ERROR)]);
}

async function handleDeviceInformation(info: WbxmlElement, userId: string, deviceId: string): Promise<WbxmlElement> {
  const set = getChild(info, 'Set');
  if (!set) return el('DeviceInformation', undefined, [el('Status', SETTINGS_STATUS.PROTOCOL_ERROR)]);
  // Only the friendly name has a column; model/OS/IMEI/user agent are accepted and not stored.
  const name = (getText(set, 'FriendlyName') || getText(set, 'Model')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
  if (name) {
    await prisma.activeSyncDevice.updateMany({ where: { userId, deviceId }, data: { deviceFriendlyName: name } });
  }
  return el('DeviceInformation', undefined, [el('Status', SETTINGS_STATUS.SUCCESS)]);
}

/** Pure: UserInformation Get content (14.1: Accounts form, 14.0: EmailAddresses only). */
export function userInformationGet(user: { email: string; displayName: string }, aliases: string[], protocolVersion: string): WbxmlElement {
  const primary = user.email.toLowerCase();
  const others = [...new Set(aliases.map((a) => a.toLowerCase()))].filter((a) => a !== primary);
  if (parseFloat(protocolVersion) >= 14.1) {
    return el('Get', undefined, [el('Accounts', undefined, [el('Account', undefined, [
      el('UserDisplayName', user.displayName || user.email),
      el('EmailAddresses', undefined, [
        el('PrimarySmtpAddress', primary),
        ...others.map((a) => el('SmtpAddress', a)),
      ]),
    ])])]);
  }
  return el('Get', undefined, [el('EmailAddresses', undefined, [primary, ...others].map((a) => el('SmtpAddress', a)))]);
}

async function handleUserInformation(info: WbxmlElement, userId: string, protocolVersion: string): Promise<WbxmlElement> {
  if (!getChild(info, 'Get')) return el('UserInformation', undefined, [el('Status', SETTINGS_STATUS.PROTOCOL_ERROR)]);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, displayName: true } });
  if (!user) return el('UserInformation', undefined, [el('Status', SETTINGS_STATUS.ACCESS_DENIED)]);
  const aliases = await prisma.emailAlias.findMany({ where: { targetUserId: userId, active: true }, select: { address: true } });
  return el('UserInformation', undefined, [
    el('Status', SETTINGS_STATUS.SUCCESS),
    userInformationGet(user, aliases.map((a) => a.address), protocolVersion),
  ]);
}

export async function handleSettings(
  body: WbxmlElement,
  userId: string,
  deviceId: string,
  protocolVersion = '14.1',
): Promise<Buffer> {
  if (body.name !== 'Settings') {
    return encodeWbxml(el('Settings', undefined, [el('Status', SETTINGS_STATUS.PROTOCOL_ERROR)]));
  }
  const out: WbxmlElement[] = [el('Status', SETTINGS_STATUS.SUCCESS)];
  for (const child of kids(body)) {
    switch (child.name) {
      case 'Oof': out.push(await handleOof(child, userId)); break;
      case 'DeviceInformation': out.push(await handleDeviceInformation(child, userId, deviceId)); break;
      case 'UserInformation': out.push(await handleUserInformation(child, userId, protocolVersion)); break;
      case 'RightsManagementInformation':
        out.push(el('RightsManagementInformation', undefined, [el('Status', SETTINGS_STATUS.SUCCESS), el('Get')]));
        break;
      case 'DevicePassword':
        out.push(el('DevicePassword', undefined, [el('Status', SETTINGS_STATUS.SUCCESS)]));
        break;
      default: break;
    }
  }
  return encodeWbxml(el('Settings', undefined, out));
}
