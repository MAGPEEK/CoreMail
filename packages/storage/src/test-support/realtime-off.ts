/**
 * Test preload (9.4): realtime events go nowhere unless a test installs its own
 * transport (globalThis.__realtimeRedis / setMailboxChangePublisher) — the
 * message store publishes on every write, and a real Redis client would keep
 * the test process alive.
 */
(globalThis as { __realtimeRedis?: unknown }).__realtimeRedis ??= null;
// 10.5: the send rate limiter (submission-rate.ts) counts in process memory —
// no test opens a Redis connection through it.
(globalThis as { __sendRateRedis?: unknown }).__sendRateRedis ??= null;
export {};
