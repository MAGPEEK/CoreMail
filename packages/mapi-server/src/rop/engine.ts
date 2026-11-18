/**
 * Executes a ROP input buffer (MS-OXCROPS 3.2.5):
 *
 *  1. Every ROP request is parsed first; an unknown RopId or a malformed request
 *     fails the whole Execute with ecRpcFormat (3.2.5.1) — nothing is executed.
 *  2. ROPs run in order; responses are written in the same order. RopRelease has
 *     no response. A handler failure (RopError) becomes that ROP's failure
 *     response; the following ROPs still run.
 *  3. Output space: each ROP gets the room left after keeping enough space for a
 *     RopBufferTooSmall that carries the unexecuted requests (3.2.4.3). When a
 *     response does not fit, RopBufferTooSmall (SizeNeeded + the unexecuted
 *     request bytes) ends the buffer and the remaining ROPs are not executed.
 *  4. The handle table is returned with the new handles at the output indexes.
 */
import { createLogger } from '@coremail/core';
import { BufferReader, WireFormatError } from '../wire/reader.js';
import { BufferWriter } from '../wire/writer.js';
import { Ec, RopError, RopId } from './codes.js';
import { buildRopOutput, outputOverhead, parseRopInput } from './buffer.js';
import { failureResponse, NeedsMoreSpace, type RopContext, type RopDef, type RopHead } from './context.js';
import type { MapiSession } from '../session/session.js';
import type { MailStore } from '../store/types.js';

const log = createLogger('mapi:rop');

/** Smallest output space worth trying a ROP with (header + a few fields). */
const MIN_ROP_SPACE = 16;
/** RopBufferTooSmall: RopId (1) + SizeNeeded (2). */
const TOO_SMALL_HEADER = 3;

interface ParsedRop { def: RopDef; req: object & RopHead; raw: Buffer }

export type RopRegistry = ReadonlyMap<number, RopDef>;

export function parseRops(ropsList: Buffer, registry: RopRegistry): ParsedRop[] {
  const r = new BufferReader(ropsList);
  const out: ParsedRop[] = [];
  while (!r.atEnd) {
    const start = r.position;
    const ropId = r.u8();
    const def = registry.get(ropId);
    if (!def) throw new WireFormatError(`unsupported RopId 0x${ropId.toString(16).padStart(2, '0')}`);
    const logonId = r.u8();
    const req = { ...def.parse(r), ropId, logonId };
    out.push({ def, req, raw: ropsList.subarray(start, r.position) });
  }
  return out;
}

export interface ExecuteDeps {
  session: MapiSession;
  store: MailStore;
  registry: RopRegistry;
  now?: () => Date;
}

/** Output buffer for an input buffer; `maxOut` = largest ROP output buffer allowed. */
export async function executeRopBuffer(input: Buffer, deps: ExecuteDeps, maxOut: number): Promise<Buffer> {
  const { ropsList, handles } = parseRopInput(input);
  const rops = parseRops(ropsList, deps.registry);
  const available = maxOut - outputOverhead(handles.length);
  if (available < TOO_SMALL_HEADER) throw new RopError(Ec.BufferTooSmall, 'MaxRopOut too small for the handle table');

  const out = new BufferWriter(1024);
  const restSize = (from: number): number => rops.slice(from).reduce((n, x) => n + x.raw.length, 0);
  const tooSmall = (from: number, needed: number): void => {
    const pending = Buffer.concat(rops.slice(from).map((x) => x.raw));
    if (out.length + TOO_SMALL_HEADER + pending.length > available) throw new RopError(Ec.BufferTooSmall, 'no room for RopBufferTooSmall');
    const sizeNeeded = Math.min(0xffff, outputOverhead(handles.length) + out.length + needed + restSize(from + 1));
    out.u8(RopId.BufferTooSmall).u16(sizeNeeded).bytes(pending);
  };

  for (let i = 0; i < rops.length; i++) {
    const { def, req } = rops[i]!;
    const budget = available - out.length - TOO_SMALL_HEADER - restSize(i + 1);
    if (budget < MIN_ROP_SPACE) { tooSmall(i, MIN_ROP_SPACE); break; }
    const ctx: RopContext = {
      session: deps.session, store: deps.store, handles, budget, now: deps.now ?? (() => new Date()),
    };
    let response: Buffer | null;
    try {
      response = await def.execute(ctx, req);
    } catch (err) {
      if (err instanceof NeedsMoreSpace) { tooSmall(i, err.needed); break; }
      const code = err instanceof RopError ? err.code : Ec.GeneralFailure;
      if (!(err instanceof RopError)) log.error({ err, rop: def.name }, 'ROP handler failed');
      else log.debug({ rop: def.name, code: code.toString(16) }, 'ROP failed');
      response = failureResponse(def, req, code);
    }
    if (response === null) continue;
    if (response.length > budget) { tooSmall(i, response.length); break; }
    out.bytes(response);
  }
  return buildRopOutput(out.toBuffer(), handles);
}
