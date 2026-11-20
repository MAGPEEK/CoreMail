/**
 * Out-of-office settings writer (v8.1). Every writer (MWA /api/v1/user/oof,
 * JMAP VacationResponse/set, EAS Settings Oof) saves through saveOofSettings()
 * so that UserSettings.oofPeriodId identifies the current OOF period:
 * a new id whenever OOF is switched on or, while it is on, the texts or the
 * schedule change. The smtp-server auto-reply sends at most ONE reply per
 * sender per period id.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from './prisma/index.js';

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

export const OOF_FIELD_DEFAULTS: OofFields = {
  oofEnabled: false, oofInternal: '', oofExternal: '', oofExternalEnabled: true,
  oofExternalOnlyContacts: false, oofUseTimeRange: false, oofStart: null, oofEnd: null,
};

const time = (d: Date | null): number | null => (d ? d.getTime() : null);

/** Pure: does `next` start a new OOF period compared with `prev`? */
export function startsNewOofPeriod(prev: (OofFields & { oofPeriodId?: string }) | null, next: OofFields): boolean {
  if (!next.oofEnabled) return false;
  if (!prev || !prev.oofEnabled || !prev.oofPeriodId) return true;
  return prev.oofInternal !== next.oofInternal
    || prev.oofExternal !== next.oofExternal
    || prev.oofUseTimeRange !== next.oofUseTimeRange
    || time(prev.oofStart) !== time(next.oofStart)
    || time(prev.oofEnd) !== time(next.oofEnd);
}

/** Pure: the period id to store with `next`. */
export function nextOofPeriodId(prev: (OofFields & { oofPeriodId?: string }) | null, next: OofFields, newId: () => string = randomUUID): string {
  return startsNewOofPeriod(prev, next) ? newId() : (prev?.oofPeriodId ?? '');
}

/** Saves the OOF fields of a user (upsert) and maintains oofPeriodId. Returns the period id. */
export async function saveOofSettings(userId: string, fields: OofFields): Promise<string> {
  const prev = await prisma.userSettings.findUnique({
    where: { userId },
    select: {
      oofEnabled: true, oofInternal: true, oofExternal: true, oofExternalEnabled: true,
      oofExternalOnlyContacts: true, oofUseTimeRange: true, oofStart: true, oofEnd: true, oofPeriodId: true,
    },
  });
  const oofPeriodId = nextOofPeriodId(prev, fields);
  const data = { ...fields, oofPeriodId };
  await prisma.userSettings.upsert({ where: { userId }, update: data, create: { userId, ...data } });
  return oofPeriodId;
}
