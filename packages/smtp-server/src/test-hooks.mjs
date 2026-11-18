/**
 * TEST-ONLY module hooks (not part of the build, never imported by production code).
 *
 * Lets `*.test.ts` files run with plain Node (>= 22.15 / 24, built-in TypeScript
 * support) without node_modules, a database, Redis or MinIO:
 *
 *   1. `@coremail/core*` and `@coremail/storage*` resolve to an in-memory stub whose
 *      behaviour is controlled by the test through `globalThis.__coremailTest`
 *      ({ prisma, verifyPassword, redis }).
 *   2. Relative `./x.js` specifiers fall back to `./x.ts` (the repo uses NodeNext
 *      `.js` extensions in TypeScript sources).
 *
 * Usage (from the repository root):
 *   node --experimental-transform-types --import ./packages/<pkg>/src/test-hooks.mjs --test <file.test.ts>
 */
import { registerHooks } from 'node:module';

const STUB_URL = 'coremail-test-stub:all';

const STUB_SOURCE = `
const g = (globalThis.__coremailTest ??= {});
export * from '${new URL('../../core/src/tls/tls-errors.ts', import.meta.url).href}';
export * from '${new URL('../../core/src/tls/legacy-tls.ts', import.meta.url).href}';
export * from '${new URL('../../storage/src/idn.ts', import.meta.url).href}';
const noop = () => {};
const logger = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, child: () => logger };
export const createLogger = () => logger;
export const verifyPassword = (password, hash) =>
  (g.verifyPassword ?? (async (p, h) => h === 'hash:' + p))(password, hash);
export const getRedisClient = () => g.redis ?? {
  duplicate: () => ({ subscribe: async () => 1, on: noop, publish: async () => 0 }),
  publish: async () => 0,
};
export const CHANNEL_MAIL_NEW = 'mail:new';
export const CHANNEL_ADMIN_ATTACK = 'admin:attack';
// v7.1.0 live-connection registry (credential changes) — inert in these tests.
export class LiveConnectionRegistry {
  register() { return () => {}; }
  terminateAffected() { return 0; }
  count() { return 0; }
  attachInvalidation() { return () => {}; }
}
// 9.4 protocol switches — covered by core/live-sessions.test.ts, not by these suites.
export const PROTOCOL_ACCESS_CHANGE = 'protocol-access-change';
export const prisma = new Proxy({}, {
  get(_target, model) {
    const db = g.prisma;
    if (!db || !(model in db)) throw new Error('test stub: prisma.' + String(model) + ' was accessed but is not faked');
    return db[model];
  },
});
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@coremail/core') || specifier.startsWith('@coremail/storage')) {
      return { url: STUB_URL, format: 'module', shortCircuit: true };
    }
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  },
  load(url, context, nextLoad) {
    if (url === STUB_URL) {
      return { format: 'module', source: STUB_SOURCE, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
