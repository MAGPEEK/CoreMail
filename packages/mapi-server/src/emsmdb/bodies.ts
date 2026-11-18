/**
 * Request and response bodies of the mailbox endpoint (MS-OXCMAPIHTTP 2.2.4).
 * The auxiliary buffers of requests are skipped; responses carry none.
 */
import { BufferReader } from '../wire/reader.js';
import { BufferWriter } from '../wire/writer.js';

export interface ConnectRequest {
  userDn: string;
  flags: number;
  codePage: number;
  lcidSort: number;
  lcidString: number;
}

export function parseConnectRequest(body: Buffer): ConnectRequest {
  const r = new BufferReader(body);
  const userDn = r.asciiZ('ascii');
  const flags = r.u32();
  const codePage = r.u32();
  const lcidSort = r.u32();
  const lcidString = r.u32();
  r.bytes(r.u32()); // AuxiliaryBuffer
  return { userDn, flags, codePage, lcidSort, lcidString };
}

export interface ConnectSuccess {
  errorCode: number;
  pollsMax: number;
  retryCount: number;
  retryDelay: number;
  dnPrefix: string;
  displayName: string;
}

export function buildConnectResponse(c: ConnectSuccess): Buffer {
  return new BufferWriter(128)
    .u32(0).u32(c.errorCode).u32(c.pollsMax).u32(c.retryCount).u32(c.retryDelay)
    .asciiZ(c.dnPrefix, 'ascii').utf16Z(c.displayName).u32(0)
    .toBuffer();
}

export interface ExecuteRequest {
  flags: number;
  ropBuffer: Buffer;
  maxRopOut: number;
}

export function parseExecuteRequest(body: Buffer): ExecuteRequest {
  const r = new BufferReader(body);
  const flags = r.u32();
  const ropBuffer = r.bytes(r.u32());
  const maxRopOut = r.u32();
  r.bytes(r.u32()); // AuxiliaryBuffer
  return { flags, ropBuffer, maxRopOut };
}

/** Execute success body; ErrorCode carries the EcDoRpcExt2 return value. */
export function buildExecuteResponse(errorCode: number, ropBuffer: Buffer): Buffer {
  return new BufferWriter(ropBuffer.length + 24)
    .u32(0).u32(errorCode).u32(0).u32(ropBuffer.length).bytes(ropBuffer).u32(0)
    .toBuffer();
}

export function parseDisconnectRequest(body: Buffer): void {
  if (body.length === 0) return;
  const r = new BufferReader(body);
  r.bytes(r.u32());
}

export function buildDisconnectResponse(): Buffer {
  return new BufferWriter(12).u32(0).u32(0).u32(0).toBuffer();
}

export function parseNotificationWaitRequest(body: Buffer): { flags: number } {
  const r = new BufferReader(body);
  const flags = r.u32();
  r.bytes(r.u32());
  return { flags };
}

export function buildNotificationWaitResponse(eventPending: boolean): Buffer {
  return new BufferWriter(16).u32(0).u32(0).u32(eventPending ? 1 : 0).u32(0).toBuffer();
}
