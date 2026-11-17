/**
 * An EAS answer that is an HTTP status without a WBXML body — e.g. a blocked device on a
 * protocol version without in-band global status codes ([MS-ASHTTP] HTTP 403 / 449).
 * Thrown by a command handler; the dispatcher (server.ts) sends the status.
 */
export class EasHttpError extends Error {
  readonly httpStatus: number;

  constructor(httpStatus: number, message: string) {
    super(message);
    this.name = 'EasHttpError';
    this.httpStatus = httpStatus;
  }
}
