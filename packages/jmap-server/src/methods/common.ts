/**
 * Hilfen für die Standard-Methoden (RFC 8620 §5): Argument-Parsing für
 * /get, /set, /query; PatchObject-Anwendung; Pagination mit anchor.
 */
import { MethodError, anchorNotFound, requestTooLarge, stateMismatch } from '../errors.js';
import { LIMITS } from '../settings.js';
import type { AccountContext, JsonObject, MethodContext } from '../types.js';

export interface GetArgs {
  account: AccountContext;
  ids: string[] | null;
  properties: string[] | null;
}

export function parseGetArgs(args: JsonObject, ctx: MethodContext): GetArgs {
  const account = ctx.account(args['accountId']);
  let ids: string[] | null = null;
  if (args['ids'] !== undefined && args['ids'] !== null) {
    if (!Array.isArray(args['ids']) || !args['ids'].every((i) => typeof i === 'string')) {
      throw new MethodError('invalidArguments', 'ids must be Id[] or null');
    }
    if (args['ids'].length > LIMITS.maxObjectsInGet) throw requestTooLarge();
    ids = (args['ids'] as string[]).map((i) => ctx.resolveId(i));
  }
  let properties: string[] | null = null;
  if (args['properties'] !== undefined && args['properties'] !== null) {
    if (!Array.isArray(args['properties']) || !args['properties'].every((p) => typeof p === 'string')) {
      throw new MethodError('invalidArguments', 'properties must be String[] or null');
    }
    properties = args['properties'] as string[];
  }
  return { account, ids, properties };
}

export function pick(obj: JsonObject, properties: string[] | null): JsonObject {
  if (!properties) return obj;
  const out: JsonObject = { id: obj['id'] };
  for (const p of properties) if (p in obj) out[p] = obj[p];
  return out;
}

export interface SetArgs {
  account: AccountContext;
  ifInState: string | null;
  create: Record<string, JsonObject>;
  update: Record<string, JsonObject>;
  destroy: string[];
}

export function parseSetArgs(args: JsonObject, ctx: MethodContext, requireWritable = true): SetArgs {
  const account = ctx.account(args['accountId']);
  if (requireWritable && account.readOnly) throw new MethodError('accountReadOnly');
  const objArg = (k: string): Record<string, JsonObject> => {
    const v = args[k];
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) throw new MethodError('invalidArguments', `${k} must be an object`);
    return v as Record<string, JsonObject>;
  };
  const create = objArg('create');
  const update = objArg('update');
  let destroy: string[] = [];
  if (args['destroy'] !== undefined && args['destroy'] !== null) {
    if (!Array.isArray(args['destroy'])) throw new MethodError('invalidArguments', 'destroy must be Id[]');
    destroy = (args['destroy'] as unknown[]).map((d) => ctx.resolveId(String(d)));
  }
  const total = Object.keys(create).length + Object.keys(update).length + destroy.length;
  if (total > LIMITS.maxObjectsInSet) throw requestTooLarge();
  const ifInState = typeof args['ifInState'] === 'string' ? args['ifInState'] : null;
  return { account, ifInState, create, update: Object.fromEntries(Object.entries(update).map(([k, v]) => [ctx.resolveId(k), v])), destroy };
}

export function assertState(ifInState: string | null, current: string): void {
  if (ifInState !== null && ifInState !== current) throw stateMismatch();
}

/**
 * PatchObject (RFC 8620 §5.3): Schlüssel sind JSON-Pointer ohne führendes '/'.
 * Liefert ein neues Objekt; wirft invalidPatch bei ungültigem Pfad.
 */
export function applyPatch(base: JsonObject, patch: JsonObject): JsonObject {
  const out: JsonObject = structuredClone(base);
  for (const [path, value] of Object.entries(patch)) {
    const tokens = path.split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
    let cur: JsonObject = out;
    for (let i = 0; i < tokens.length - 1; i++) {
      const t = tokens[i]!;
      const next = cur[t];
      if (next === undefined || next === null) {
        throw new MethodError('invalidPatch', `Path "${path}" does not exist`);
      }
      if (typeof next !== 'object' || Array.isArray(next)) throw new MethodError('invalidPatch', `Path "${path}" is not an object`);
      cur = next as JsonObject;
    }
    const last = tokens[tokens.length - 1]!;
    if (value === null) delete cur[last];
    else cur[last] = value;
  }
  return out;
}

export interface QueryPage {
  position: number;
  ids: string[];
  total: number;
  limit: number | null;
}

export function paginate(allIds: string[], args: JsonObject): QueryPage {
  let position = typeof args['position'] === 'number' ? Math.trunc(args['position']) : 0;
  const limitArg = args['limit'];
  if (limitArg !== undefined && limitArg !== null && (typeof limitArg !== 'number' || limitArg < 0)) {
    throw new MethodError('invalidArguments', 'limit must be a non-negative number');
  }
  const limit = typeof limitArg === 'number' ? Math.min(Math.trunc(limitArg), 1000) : 256;
  const anchor = typeof args['anchor'] === 'string' ? args['anchor'] : null;
  if (anchor) {
    const idx = allIds.indexOf(anchor);
    if (idx === -1) throw anchorNotFound();
    const offset = typeof args['anchorOffset'] === 'number' ? Math.trunc(args['anchorOffset']) : 0;
    position = idx + offset;
  }
  if (position < 0) position = Math.max(0, allIds.length + position);
  if (position > allIds.length) position = allIds.length;
  return { position, ids: allIds.slice(position, position + limit), total: allIds.length, limit: typeof limitArg === 'number' ? limit : null };
}

export function requireString(args: JsonObject, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new MethodError('invalidArguments', `${key} must be a String`);
  return v;
}

export function utc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
