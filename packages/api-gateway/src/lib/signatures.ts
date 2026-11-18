/**
 * 9.4: named signatures (UserSignature) + the legacy single signature.
 *
 * UserSettings.signature/signatureAutoNew/signatureAutoReply stay the "primary"
 * signature for pre-9.4 clients (GET/PUT /user/signature, JMAP Identity): after
 * every change they mirror the own identity's defaults (primary = default for new
 * mails, else for replies, else the first signature). A user who still has only
 * the legacy column gets it imported once as "Standard".
 */
import { prisma } from '@coremail/storage';
import { loadPreferences, savePreferencesPatch } from './preferences-store.js';
import { withoutSignature, type UserPreferences } from './user-preferences.js';

export const MAX_SIGNATURES = 20;
/** Images are inlined (base64, max 500 KB each in the editor). */
export const MAX_SIGNATURE_HTML = 2 * 1024 * 1024;
export const LEGACY_SIGNATURE_NAME = 'Standard';

export interface SignatureRow {
  id: string;
  name: string;
  html: string;
  sortOrder: number;
}

const SELECT = { id: true, name: true, html: true, sortOrder: true } as const;

type OwnDefaults = UserPreferences['signatures']['defaults'][string] | undefined;

/** Pure: which signature the legacy column shows, and its two flags. */
export function legacyMirror(signatures: readonly SignatureRow[], own: OwnDefaults): { signature: string; signatureAutoNew: boolean; signatureAutoReply: boolean } {
  const byId = (id: string | null | undefined) => (id ? signatures.find((s) => s.id === id) : undefined);
  const primary = byId(own?.newId) ?? byId(own?.replyId) ?? signatures[0];
  return {
    signature: primary?.html ?? '',
    signatureAutoNew: !!byId(own?.newId),
    signatureAutoReply: !!byId(own?.replyId),
  };
}

async function rows(userId: string): Promise<SignatureRow[]> {
  return prisma.userSignature.findMany({ where: { userId }, select: SELECT, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
}

/** Writes the legacy column from the current signatures + own defaults. */
export async function mirrorLegacySignature(userId: string): Promise<void> {
  const [list, prefs] = await Promise.all([rows(userId), loadPreferences(userId)]);
  const data = legacyMirror(list, prefs.signatures.defaults['own']);
  await prisma.userSettings.upsert({ where: { userId }, update: data, create: { userId, ...data } });
}

/** All signatures; imports the pre-9.4 single signature on first use. */
export async function listSignatures(userId: string): Promise<SignatureRow[]> {
  const list = await rows(userId);
  if (list.length > 0) return list;
  const legacy = await prisma.userSettings.findUnique({
    where: { userId }, select: { signature: true, signatureAutoNew: true, signatureAutoReply: true },
  });
  if (!legacy?.signature) return list;
  const created = await prisma.userSignature.create({
    data: { userId, name: LEGACY_SIGNATURE_NAME, html: legacy.signature },
    select: SELECT,
  });
  await savePreferencesPatch(userId, {
    signatures: {
      defaults: {
        own: {
          newId: legacy.signatureAutoNew ? created.id : null,
          replyId: legacy.signatureAutoReply ? created.id : null,
        },
      },
    },
  });
  return [created];
}

export async function countSignatures(userId: string): Promise<number> {
  return prisma.userSignature.count({ where: { userId } });
}

export async function createSignature(userId: string, name: string, html: string): Promise<SignatureRow> {
  const sortOrder = await countSignatures(userId);
  const created = await prisma.userSignature.create({ data: { userId, name, html, sortOrder }, select: SELECT });
  await mirrorLegacySignature(userId);
  return created;
}

export async function updateSignature(userId: string, id: string, data: { name?: string; html?: string; sortOrder?: number }): Promise<SignatureRow | null> {
  const { count } = await prisma.userSignature.updateMany({ where: { id, userId }, data });
  if (count === 0) return null;
  await mirrorLegacySignature(userId);
  return prisma.userSignature.findFirst({ where: { id, userId }, select: SELECT });
}

/** Deletes a signature and every default that pointed at it. */
export async function deleteSignature(userId: string, id: string): Promise<boolean> {
  const { count } = await prisma.userSignature.deleteMany({ where: { id, userId } });
  if (count === 0) return false;
  const patch = withoutSignature(await loadPreferences(userId), id);
  if (patch) await savePreferencesPatch(userId, patch);
  await mirrorLegacySignature(userId);
  return true;
}

/**
 * Pre-9.4 PUT /user/signature: edits the primary signature (creating "Standard"
 * when there is none) and sets the own defaults from the two flags.
 */
export async function saveLegacySignature(userId: string, html: string, autoNew?: boolean, autoReply?: boolean): Promise<void> {
  const list = await listSignatures(userId);
  const own = (await loadPreferences(userId)).signatures.defaults['own'];
  const byId = (sid: string | null | undefined) => (sid ? list.find((s) => s.id === sid) : undefined);
  const primary = byId(own?.newId) ?? byId(own?.replyId) ?? list[0];
  if (!primary && !html) return; // nothing to clear, nothing to create
  const target = primary
    ? (await prisma.userSignature.update({ where: { id: primary.id }, data: { html }, select: SELECT }))
    : (await prisma.userSignature.create({ data: { userId, name: LEGACY_SIGNATURE_NAME, html }, select: SELECT }));
  const newId = autoNew === undefined ? (own?.newId ?? (primary ? null : target.id)) : (autoNew ? target.id : null);
  const replyId = autoReply === undefined ? (own?.replyId ?? null) : (autoReply ? target.id : null);
  await savePreferencesPatch(userId, { signatures: { defaults: { own: { newId, replyId } } } });
  await mirrorLegacySignature(userId);
}
