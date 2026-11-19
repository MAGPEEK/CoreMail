/**
 * What a ROP handler works with: the session, the store, the server object
 * handle table of the current request and the output space left for its
 * response. Plus the definition shape every ROP implements.
 */
import type { BufferReader } from '../wire/reader.js';
import { BufferWriter } from '../wire/writer.js';
import { Ec, RopError } from './codes.js';
import { HANDLE_UNUSED } from './handles.js';
import { sessionFootprint } from '../objects/footprint.js';
import type { MapiSession } from '../session/session.js';
import type { MailStore } from '../store/types.js';
import type { LogonState, ObjectKind, ServerObject } from '../objects/state.js';

export interface RopContext {
  readonly session: MapiSession;
  readonly store: MailStore;
  /** The Server object handle table of the request (updated in place). */
  readonly handles: number[];
  /** Bytes this ROP's response may occupy. */
  budget: number;
  now(): Date;
}

export interface RopHead { ropId: number; logonId: number }

export interface RopDef<Req extends object = object> {
  readonly id: number;
  readonly name: string;
  /** Reads the request fields after RopId and LogonId. */
  parse(r: BufferReader): Req;
  /** The response buffer; null for RopRelease (no response). */
  execute(ctx: RopContext, req: Req & RopHead): Promise<Buffer | null>;
  /** Handle index echoed in the response. */
  responseIndex(req: Req): number;
  /** Fields after ReturnValue that a failure response still carries. */
  failureTail?: readonly number[];
}

/** A dynamically sized response cannot fit its minimum into the output buffer. */
export class NeedsMoreSpace extends Error {
  readonly needed: number;
  constructor(needed: number) {
    super(`ROP response needs ${needed} bytes`);
    this.name = 'NeedsMoreSpace';
    this.needed = needed;
  }
}

/** Type-erasing helper so heterogeneous definitions fit one registry. */
export function defineRop<Req extends object>(def: RopDef<Req>): RopDef {
  return def as unknown as RopDef;
}

/** RopId | index | ReturnValue 0 — the start of every success response. */
export function okResponse(ropId: number, index: number): BufferWriter {
  return new BufferWriter(64).u8(ropId).u8(index).u32(Ec.Success);
}

export function failureResponse(def: RopDef, req: object, code: number): Buffer {
  const w = new BufferWriter(16).u8(def.id).u8(def.responseIndex(req)).u32(code);
  for (const b of def.failureTail ?? []) w.u8(b);
  return w.toBuffer();
}

export function objectAt(ctx: RopContext, index: number): ServerObject {
  const handle = ctx.handles[index];
  if (handle === undefined || handle === HANDLE_UNUSED) throw new RopError(Ec.NullObject);
  return ctx.session.objects.get(handle);
}

/** The object at `index`, which must be of one of the given kinds. */
export function objectOf<K extends ObjectKind>(ctx: RopContext, index: number, ...kinds: K[]): Extract<ServerObject, { kind: K }> {
  const o = objectAt(ctx, index);
  if (!(kinds as ObjectKind[]).includes(o.kind)) throw new RopError(Ec.NotSupported, `${o.kind} object cannot do this`);
  return o as Extract<ServerObject, { kind: K }>;
}

/** Registers a new server object and stores its handle at `index`. */
export function putObject(ctx: RopContext, index: number, object: ServerObject, logonId: number): void {
  if (index >= ctx.handles.length) throw new RopError(Ec.InvalidParameter, 'output handle index outside the handle table');
  ctx.handles[index] = ctx.session.objects.add(object, logonId);
}

export function logonOf(ctx: RopContext, logonId: number): LogonState {
  const logon = ctx.session.logons.get(logonId);
  if (!logon) throw new RopError(Ec.NullObject, `no logon ${logonId}`);
  return logon;
}

/** The mailbox of a logon may be changed (FULL_ACCESS / own). */
export function assertWritable(logon: LogonState): void {
  if (logon.mailbox.readOnly) throw new RopError(Ec.AccessDenied, 'mailbox is read-only for this account');
}

/**
 * Refuses work that would grow the session's server objects past their byte
 * budget (MapiSession.memoryLimit, objects/footprint.ts) — `code` is the ROP's
 * failure value (ecMAPIOOM by default, STG_E_MEDIUMFULL for streams).
 */
export function assertMemory(ctx: RopContext, extraBytes: number, code: number = Ec.OutOfMemory): void {
  if (!fitsMemory(ctx, extraBytes)) throw new RopError(code, 'session memory budget exceeded');
}

/** Bytes the session's server objects may still grow by. */
export function memoryLeft(ctx: RopContext): number {
  return Math.max(0, ctx.session.memoryLimit - sessionFootprint(ctx.session.objects.all()));
}

export function fitsMemory(ctx: RopContext, extraBytes: number): boolean {
  return extraBytes <= 0 || sessionFootprint(ctx.session.objects.all()) + extraBytes <= ctx.session.memoryLimit;
}
