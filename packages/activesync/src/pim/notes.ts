/**
 * Notes class module ([MS-ASNOTE], EAS 14.0+): the user's notes as one folder (FolderSync
 * type 10). Notes have no shared writer beyond the REST routes' plain row writes, so the
 * module writes the rows itself and announces them like the REST routes (realtime `notes`).
 */
import { prisma } from '@coremail/storage/prisma';
import { announceUserEvent } from '@coremail/storage';
import type { UserEventAction } from '@coremail/core';
import { noteChange, renderNote, type NoteRow } from './notes-codec.js';
import { PIM_STATUS, versionOf, type PimClassModule, type PimCollection } from './types.js';

export const NOTES_COLLECTION_ID = 'notes:default';
const FOLDER_NAME = 'Notizen';
const NOTE_SELECT = { id: true, subject: true, body: true, updatedAt: true } as const;

function announce(userId: string, action: UserEventAction, ids: string[]): void {
  announceUserEvent(userId, { type: 'notes', action, ids });
}

async function findNote(col: PimCollection, id: string): Promise<NoteRow | null> {
  return prisma.note.findFirst({ where: { id, userId: col.key }, select: NOTE_SELECT });
}

export const notesModule: PimClassModule<NoteRow> = {
  className: 'Notes',
  idPrefix: 'notes:',
  feature: 'notes',
  protocolFeature: 'notesClass',

  async folders() {
    return [{ serverId: NOTES_COLLECTION_ID, displayName: FOLDER_NAME, type: '10' }];
  },

  async collection(userId, collectionId) {
    return collectionId === NOTES_COLLECTION_ID ? { id: collectionId, userId, key: userId } : null;
  },

  async states(col) {
    const rows = await prisma.note.findMany({ where: { userId: col.key }, select: { id: true, updatedAt: true } });
    return rows.map((r) => ({ serverId: r.id, version: versionOf(r.updatedAt), inFilter: true }));
  },

  async load(col, ids) {
    if (ids.length === 0) return [];
    return prisma.note.findMany({ where: { userId: col.key, id: { in: ids } }, select: NOTE_SELECT });
  },

  rowId: (row) => row.id,
  rowVersion: (row) => versionOf(row.updatedAt),
  render: (row, ctx) => renderNote(row, ctx),

  async create(col, data, ctx) {
    const columns = noteChange(data, null, ctx);
    const note = await prisma.note.create({ data: { userId: col.key, ...columns }, select: { id: true, updatedAt: true } });
    announce(col.key, 'create', [note.id]);
    return { ok: true, serverId: note.id, version: versionOf(note.updatedAt) };
  },

  async update(col, serverId, data, ctx) {
    const note = await findNote(col, serverId);
    if (!note) return { ok: false, status: PIM_STATUS.OBJECT_NOT_FOUND };
    const saved = await prisma.note.update({ where: { id: note.id }, data: noteChange(data, note, ctx), select: { id: true, updatedAt: true } });
    announce(col.key, 'update', [saved.id]);
    return { ok: true, serverId: saved.id, version: versionOf(saved.updatedAt) };
  },

  async remove(col, serverId) {
    const note = await findNote(col, serverId);
    if (!note) return false;
    await prisma.note.delete({ where: { id: note.id } });
    announce(col.key, 'delete', [note.id]);
    return true;
  },

  async fingerprint(col) {
    const [count, newest] = await Promise.all([
      prisma.note.count({ where: { userId: col.key } }),
      prisma.note.aggregate({ where: { userId: col.key }, _max: { updatedAt: true } }),
    ]);
    return `${count}:${newest._max.updatedAt?.getTime() ?? 0}`;
  },
};
