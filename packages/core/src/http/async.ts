/**
 * Async route handling for Express 4 (v6 hardening).
 *
 * Express 4 ignores the promise returned by a handler: a rejection becomes an
 * `unhandledRejection` and (Node ≥ 15) kills the process. Two tools:
 *
 *   asyncHandler(fn)               — wrap a single handler explicitly
 *   installAsyncErrorHandling(express)
 *                                  — patch Express' internal Layer once per
 *                                    process so EVERY handler/middleware on
 *                                    every app/router (also routers created
 *                                    later) forwards rejections to next(err).
 *
 * Both forward to the regular error middleware (see errorMiddleware()).
 */

type Next = (err?: unknown) => void;

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';
}

function rejectionToError(reason: unknown): unknown {
  // next(undefined) / next('route') would silently continue routing — never allow that.
  if (reason === undefined || reason === null || reason === 'route' || reason === 'router') {
    return new Error('Async handler rejected without an error');
  }
  return reason;
}

/**
 * Wrap a (possibly async) request handler so that thrown errors and promise
 * rejections reach `next(err)`. Do not use for 4-argument error handlers.
 */
export function asyncHandler<A extends unknown[]>(fn: (...args: A) => unknown): (...args: A) => void {
  return function asyncWrapped(...args: A): void {
    const next = args[args.length - 1] as unknown;
    const forward = (e: unknown): void => {
      if (typeof next === 'function') (next as Next)(rejectionToError(e));
    };
    try {
      const r = fn(...args);
      if (isThenable(r)) r.then(undefined, forward);
    } catch (e) {
      forward(e);
    }
  };
}

const PATCHED = Symbol.for('coremail.asyncLayerPatched');

interface LayerProto {
  handle_request: (this: { handle: (...a: unknown[]) => unknown }, req: unknown, res: unknown, next: Next) => void;
  handle_error: (this: { handle: (...a: unknown[]) => unknown }, err: unknown, req: unknown, res: unknown, next: Next) => void;
  [PATCHED]?: boolean;
}

/**
 * Patch Express 4's Layer prototype (shared by app router, Router() and
 * Route) so returned promises are observed. Idempotent. Pass the default
 * export of `express` from the calling package.
 *
 * Returns true when the patch is active (also when it already was).
 */
export function installAsyncErrorHandling(expressModule: unknown): boolean {
  const routerFactory = (expressModule as { Router?: () => unknown } | null)?.Router;
  if (typeof routerFactory !== 'function') return false;
  const probe = routerFactory() as { use: (fn: unknown) => void; stack?: Array<{ constructor: { prototype: LayerProto } }> };
  probe.use(function probeLayer() { /* used only to reach the Layer class */ });
  const proto = probe.stack?.[0]?.constructor?.prototype;
  if (!proto || typeof proto.handle_request !== 'function') return false;
  if (proto[PATCHED]) return true;

  proto.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) { next(); return; } // not a request handler (error handler)
    try {
      const r = fn(req, res, next);
      if (isThenable(r)) r.then(undefined, (e) => next(rejectionToError(e)));
    } catch (err) {
      next(err);
    }
  };

  proto.handle_error = function handleError(error, req, res, next) {
    const fn = this.handle;
    if (fn.length !== 4) { next(error); return; } // not an error handler
    try {
      const r = fn(error, req, res, next);
      if (isThenable(r)) r.then(undefined, (e) => next(rejectionToError(e)));
    } catch (err) {
      next(err);
    }
  };

  proto[PATCHED] = true;
  return true;
}
