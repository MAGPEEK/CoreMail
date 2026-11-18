/**
 * Tasks class module ([MS-ASTASK]): the user's tasks as one folder (FolderSync type 7).
 * Writes go through the storage task writer shared with the REST API (status rules,
 * the next occurrence of a completed recurring task) and are announced to the user's
 * other clients (realtime `tasks` events).
 */
import { prisma } from '@coremail/storage/prisma';
import { announceUserEvent, createTask, updateTask } from '@coremail/storage';
import type { UserEventAction } from '@coremail/core';
import { parseTask, renderTask, taskChange, type TaskRow } from './tasks-codec.js';
import { PIM_STATUS, versionOf, type PimClassModule, type PimCollection } from './types.js';

export const TASKS_COLLECTION_ID = 'tasks:default';
/** Display name of the folder (the device shows it under its own tasks label). */
const FOLDER_NAME = 'Aufgaben';
/** [MS-ASCMD] 2.2.3.68.2 FilterType of the Tasks class: 8 = incomplete tasks only. */
export const INCOMPLETE_TASKS = 8;

const TASK_SELECT = {
  id: true, userId: true, subject: true, body: true, bodyHtml: true, status: true, priority: true, startDate: true,
  dueDate: true, completedAt: true, reminder: true, isPrivate: true, rrule: true, updatedAt: true,
} as const;

function announce(userId: string, action: UserEventAction, ids: string[]): void {
  announceUserEvent(userId, { type: 'tasks', action, ids });
}

async function findTask(col: PimCollection, id: string) {
  return prisma.task.findFirst({ where: { id, userId: col.key } });
}

export const tasksModule: PimClassModule<TaskRow> = {
  className: 'Tasks',
  idPrefix: 'tasks:',
  feature: 'tasks',

  async folders() {
    return [{ serverId: TASKS_COLLECTION_ID, displayName: FOLDER_NAME, type: '7' }];
  },

  async collection(userId, collectionId) {
    return collectionId === TASKS_COLLECTION_ID ? { id: collectionId, userId, key: userId } : null;
  },

  async states(col, filterType) {
    const rows = await prisma.task.findMany({ where: { userId: col.key }, select: { id: true, updatedAt: true, status: true } });
    return rows.map((r) => ({
      serverId: r.id,
      version: versionOf(r.updatedAt),
      inFilter: filterType !== INCOMPLETE_TASKS || r.status !== 'COMPLETED',
    }));
  },

  async load(col, ids) {
    if (ids.length === 0) return [];
    return prisma.task.findMany({ where: { userId: col.key, id: { in: ids } }, select: TASK_SELECT });
  },

  rowId: (row) => row.id,
  rowVersion: (row) => versionOf(row.updatedAt),
  render: (row, ctx) => renderTask(row, ctx),

  async create(col, data, ctx) {
    const { columns, patch } = taskChange(parseTask(data), null, ctx);
    const task = await createTask(col.key, { ...columns, subject: columns.subject ?? '' }, patch, ctx.now);
    announce(col.key, 'create', [task.id]);
    return { ok: true, serverId: task.id, version: versionOf(task.updatedAt) };
  },

  async update(col, serverId, data, ctx) {
    const task = await findTask(col, serverId);
    if (!task) return { ok: false, status: PIM_STATUS.OBJECT_NOT_FOUND };
    const { columns, patch } = taskChange(parseTask(data), task, ctx);
    const { updated, next } = await updateTask(task, columns, patch, ctx.now);
    if (!updated) return { ok: false, status: PIM_STATUS.OBJECT_NOT_FOUND };
    announce(col.key, 'update', [updated.id]);
    if (next) announce(col.key, 'create', [next.id]);
    // a completed recurring task lost its rule to the next one: the device gets the change
    return { ok: true, serverId: updated.id, version: versionOf(updated.updatedAt), ...(next ? { normalized: true } : {}) };
  },

  async remove(col, serverId) {
    const task = await findTask(col, serverId);
    if (!task) return false;
    await prisma.task.delete({ where: { id: task.id } });
    announce(col.key, 'delete', [task.id]);
    return true;
  },

  async fingerprint(col) {
    const [count, newest] = await Promise.all([
      prisma.task.count({ where: { userId: col.key } }),
      prisma.task.aggregate({ where: { userId: col.key }, _max: { updatedAt: true } }),
    ]);
    return `${count}:${newest._max.updatedAt?.getTime() ?? 0}`;
  },
};
