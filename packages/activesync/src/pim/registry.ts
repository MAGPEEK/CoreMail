/**
 * The PIM class modules and which of them a user gets: the webmail module of the class must
 * be on for the user (9.4 policies — calendar / tasks / notes / contacts off → no folder, no
 * sync) and the negotiated protocol version must know the class (Notes: 14.0+).
 */
import { isWebmailFeatureEnabled } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { supports, type EasVersion } from '../protocol-version.js';
import { calendarModule } from './calendar.js';
import { tasksModule } from './tasks.js';
import { notesModule } from './notes.js';
import { contactsModule } from './contacts.js';
import type { PimClassModule, PimCollection, PimFolder } from './types.js';

const log = createLogger('activesync:pim');

export const CLASS_MODULES: readonly PimClassModule[] = [
  calendarModule as PimClassModule,
  tasksModule as PimClassModule,
  notesModule as PimClassModule,
  contactsModule as PimClassModule,
];

/** The module owning `collectionId` (by its prefix); undefined for a mail folder id. */
export function moduleFor(collectionId: string): PimClassModule | undefined {
  return CLASS_MODULES.find((m) => collectionId.startsWith(m.idPrefix));
}

/** Is the class available to the user in this version? Throws when the policy cannot be read. */
async function available(module: PimClassModule, userId: string, version: EasVersion): Promise<boolean> {
  if (module.protocolFeature && !supports(version, module.protocolFeature)) return false;
  return isWebmailFeatureEnabled(userId, module.feature);
}

/** FolderSync entries of every available class. Throws when the policy cannot be read. */
export async function pimFolders(userId: string, version: EasVersion): Promise<PimFolder[]> {
  const out: PimFolder[] = [];
  for (const module of CLASS_MODULES) {
    if (await available(module, userId, version)) out.push(...await module.folders(userId));
  }
  return out;
}

export type ResolvedCollection =
  | { status: 'ok'; module: PimClassModule; collection: PimCollection }
  /** No such collection of the user. */
  | { status: 'unknown' }
  /** The class is switched off for the user (or not in this protocol version). */
  | { status: 'disabled' }
  /** The policy could not be read (temporary). */
  | { status: 'error' };

export async function resolveCollection(userId: string, collectionId: string, version: EasVersion): Promise<ResolvedCollection> {
  const module = moduleFor(collectionId);
  if (!module) return { status: 'unknown' };
  let on: boolean;
  try {
    on = await available(module, userId, version);
  } catch (err) {
    log.warn({ err, userId, collectionId }, 'EAS: webmail policy not readable — collection answered as temporarily unavailable');
    return { status: 'error' };
  }
  if (!on) return { status: 'disabled' };
  const collection = await module.collection(userId, collectionId);
  return collection ? { status: 'ok', module, collection } : { status: 'unknown' };
}
