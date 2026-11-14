/**
 * Shared HTTP error handling for every Express service (v6 hardening).
 *
 * `@coremail/core` has no Express dependency, so the types below are minimal
 * structural shapes that Express' Request/Response satisfy.
 *
 * Mapping (never leaks err.message / stack to clients):
 *   HttpError (thrown deliberately)      → its status + its public message
 *   ZodError                             → 400 { error: 'Invalid request', details: [{ path, message }] }
 *   Prisma P2002 (unique violation)      → 409
 *   Prisma P2025 (record not found)      → 404
 *   Prisma P2003/P2014 (FK / relation)   → 409
 *   Prisma P2000/P2006/P2007/P2023       → 400 (invalid value / malformed id)
 *   PrismaClientValidationError          → 400
 *   body-parser: entity.parse.failed     → 400, entity.too.large → 413
 *   anything else                        → 500 { error: 'Internal server error' }
 */

export interface HttpErrorBody {
  error: string;
  code?: string;
  details?: Array<{ path: string; message: string }>;
}

export interface ClassifiedError {
  status: number;
  body: HttpErrorBody;
}

/** Error with an HTTP status and a message that is safe to show to clients. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

interface ErrLike {
  name?: unknown;
  code?: unknown;
  type?: unknown;
  status?: unknown;
  statusCode?: unknown;
  issues?: unknown;
  clientVersion?: unknown;
}

function isObj(v: unknown): v is ErrLike {
  return typeof v === 'object' && v !== null;
}

const PRISMA_MAP: Record<string, ClassifiedError> = {
  P2002: { status: 409, body: { error: 'Conflict: a record with this value already exists', code: 'CONFLICT' } },
  P2025: { status: 404, body: { error: 'Not found', code: 'NOT_FOUND' } },
  P2003: { status: 409, body: { error: 'Conflict: the record is still referenced by other records', code: 'REFERENCED' } },
  P2014: { status: 409, body: { error: 'Conflict: the change would violate a required relation', code: 'REFERENCED' } },
  P2034: { status: 409, body: { error: 'Conflict: concurrent update, please retry', code: 'CONFLICT' } },
  P2000: { status: 400, body: { error: 'Invalid request: value too long', code: 'INVALID_INPUT' } },
  P2006: { status: 400, body: { error: 'Invalid request: invalid value', code: 'INVALID_INPUT' } },
  P2007: { status: 400, body: { error: 'Invalid request: invalid value', code: 'INVALID_INPUT' } },
  P2023: { status: 400, body: { error: 'Invalid request: malformed identifier', code: 'INVALID_INPUT' } },
};

/** Map any thrown value to an HTTP status + client-safe body. Pure — unit-testable. */
export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: err.message, ...(err.code ? { code: err.code } : {}) } };
  }
  if (!isObj(err)) return { status: 500, body: { error: 'Internal server error' } };

  // Zod (structural — the zod instance may differ between packages)
  if (err.name === 'ZodError' && Array.isArray(err.issues)) {
    const details = (err.issues as Array<{ path?: unknown; message?: unknown }>).slice(0, 20).map((i) => ({
      path: Array.isArray(i.path) ? i.path.join('.') : '',
      message: typeof i.message === 'string' ? i.message : 'Invalid value',
    }));
    return { status: 400, body: { error: 'Invalid request', code: 'INVALID_INPUT', details } };
  }

  // Prisma known request errors: code P2xxx (+ clientVersion)
  if (typeof err.code === 'string' && /^P\d{4}$/.test(err.code)
      && (err.name === 'PrismaClientKnownRequestError' || err.clientVersion !== undefined)) {
    const mapped = PRISMA_MAP[err.code];
    if (mapped) return { status: mapped.status, body: { ...mapped.body } };
    return { status: 500, body: { error: 'Internal server error' } };
  }
  if (err.name === 'PrismaClientValidationError') {
    return { status: 400, body: { error: 'Invalid request', code: 'INVALID_INPUT' } };
  }

  // body-parser / raw-body
  if (err.type === 'entity.parse.failed') return { status: 400, body: { error: 'Malformed request body', code: 'INVALID_INPUT' } };
  if (err.type === 'entity.too.large') return { status: 413, body: { error: 'Request body too large' } };
  if (err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') {
    return { status: 415, body: { error: 'Unsupported request encoding' } };
  }

  // Other client errors carrying a 4xx status (e.g. http-errors) — generic text only
  const st = typeof err.status === 'number' ? err.status : typeof err.statusCode === 'number' ? err.statusCode : 0;
  if (st >= 400 && st < 500) return { status: st, body: { error: 'Bad request' } };

  return { status: 500, body: { error: 'Internal server error' } };
}

export interface ErrorMiddlewareLogger {
  error(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

/** Structural subset of express.Request used by the error middleware. */
export interface MinimalRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
}

/** Structural subset of express.Response used by the error middleware. */
export interface MinimalResponse {
  headersSent: boolean;
  status(code: number): MinimalResponse;
  json(body: unknown): unknown;
}

/**
 * Final Express error middleware. Register LAST: `app.use(errorMiddleware(log))`.
 * Logs the full error server-side, sends only the classified body.
 */
export function errorMiddleware(log: ErrorMiddlewareLogger) {
  // 4 parameters — Express recognises error handlers by arity.
  return function coremailErrorMiddleware(
    err: unknown,
    req: MinimalRequest,
    res: MinimalResponse,
    next: (err?: unknown) => void,
  ): void {
    const { status, body } = classifyError(err);
    const ctx = { err, method: req.method, url: (req.originalUrl ?? req.url ?? '').split('?')[0], status };
    if (status >= 500) log.error(ctx, 'Unhandled request error');
    else log.warn(ctx, 'Request rejected');
    if (res.headersSent) {
      // Response already streaming — let Express' default handler close the socket.
      next(err);
      return;
    }
    res.status(status).json(body);
  };
}
