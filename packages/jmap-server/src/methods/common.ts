/**
 * Helpers for the standard methods (RFC 8620 §5): argument parsing for
 * /get, /set, /query; PatchObject application; pagination with anchor.
 */
import { MethodError, anchorNotFound, requestTooLarge, stateMismatch } from '../errors.js';
import { LIMITS } from '../settings.js';
import { normalizeKeywordPatch } from '../mail/keywords.js';
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
 * PatchObject (RFC 8620 §5.3): keys are JSON pointers without a leading '/'.
 * Returns a new object; throws invalidPatch on an invalid path.
 */
const FORBIDDEN_PATCH_TOKENS = new Set(['__proto__', 'constructor', 'prototype']);

export function applyPatch(base: JsonObject, patch: JsonObject): JsonObject {
  // RFC 8620 §5.3: no pointer may be a prefix of another pointer in the same PatchObject.
  const paths = Object.keys(patch);
  for (const p of paths) {
    const clash = paths.find((q) => q !== p && q.startsWith(`${p}/`));
    if (clash) throw new MethodError('invalidPatch', `Path "${p}" is a prefix of "${clash}"`);
  }
  const out: JsonObject = structuredClone(base);
  // Email keywords are case-insensitive (RFC 8621 §4.1.1) and stored lower-case in
  // the patched object, so "keywords/Foo": null must address "foo".
  for (const [path, value] of Object.entries(normalizeKeywordPatch(patch) as JsonObject)) {
    const tokens = path.split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
    // Prototype pollution guard: a path like "keywords/__proto__/x" would
    // otherwise walk into Object.prototype and modify it process-wide.
    if (tokens.some((t) => FORBIDDEN_PATCH_TOKENS.has(t))) {
      throw new MethodError('invalidPatch', `Path "${path}" is not allowed`);
    }
    let cur: JsonObject = out;
    for (let i = 0; i < tokens.length - 1; i++) {
      const t = tokens[i]!;
      if (!Object.hasOwn(cur, t)) {
        throw new MethodError('invalidPatch', `Path "${path}" does not exist`);
      }
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

/** Default and maximum /query page size. RFC 8620 §5.5: a server-imposed limit is reported in "limit". */
export const QUERY_DEFAULT_LIMIT = 256;
export const QUERY_MAX_LIMIT = 1000;

export function paginate(allIds: string[], args: JsonObject): QueryPage {
  let position = typeof args['position'] === 'number' ? Math.trunc(args['position']) : 0;
  const limitArg = args['limit'];
  if (limitArg !== undefined && limitArg !== null && (typeof limitArg !== 'number' || limitArg < 0)) {
    throw new MethodError('invalidArguments', 'limit must be a non-negative number');
  }
  const requested = typeof limitArg === 'number' ? Math.trunc(limitArg) : null;
  const limit = requested !== null ? Math.min(requested, QUERY_MAX_LIMIT) : QUERY_DEFAULT_LIMIT;
  const anchor = typeof args['anchor'] === 'string' ? args['anchor'] : null;
  if (anchor) {
    const idx = allIds.indexOf(anchor);
    if (idx === -1) throw anchorNotFound();
    const offset = typeof args['anchorOffset'] === 'number' ? Math.trunc(args['anchorOffset']) : 0;
    // RFC 8620 §5.5: with an anchor, a negative index is clamped to 0 (no wrap-around).
    position = Math.max(0, idx + offset);
  } else if (position < 0) {
    position = Math.max(0, allIds.length + position);
  }
  if (position > allIds.length) position = allIds.length;
  return {
    position, ids: allIds.slice(position, position + limit), total: allIds.length,
    // Reported only when the server applied a limit the client did not ask for.
    limit: requested === limit ? null : limit,
  };
}

/** Query response fields shared by every /query method (position, ids, total, limit). */
export function pageFields(page: QueryPage, args: JsonObject): JsonObject {
  return {
    position: page.position, ids: page.ids,
    ...(args['calculateTotal'] === true ? { total: page.total } : {}),
    ...(page.limit !== null ? { limit: page.limit } : {}),
  };
}

/**
 * Comparator chain (RFC 8620 §5.5: comparators in order of precedence — the
 * first one decides, later ones only break ties).
 */
export function compareBy<T>(comparators: Array<(a: T, b: T) => number>): (a: T, b: T) => number {
  return (a, b) => {
    for (const c of comparators) {
      const r = c(a, b);
      if (r !== 0) return r;
    }
    return 0;
  };
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
