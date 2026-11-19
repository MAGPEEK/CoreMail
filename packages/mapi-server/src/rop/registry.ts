/** Every ROP this server implements, by RopId. */
import type { RopDef } from './context.js';
import type { RopRegistry } from './engine.js';
import { logonRops } from './ops/logon.js';
import { folderRops } from './ops/folder.js';
import { tableRops } from './ops/table.js';
import { messageRops } from './ops/message.js';
import { propertyRops } from './ops/property.js';
import { streamRops } from './ops/stream.js';
import { syncRops } from './ops/sync.js';
import { syncImportRops } from './ops/sync-import.js';

const ALL: RopDef[] = [
  ...logonRops, ...folderRops, ...tableRops, ...messageRops, ...propertyRops, ...streamRops, ...syncRops, ...syncImportRops,
];

export const ROP_REGISTRY: RopRegistry = new Map(ALL.map((d) => [d.id, d]));
