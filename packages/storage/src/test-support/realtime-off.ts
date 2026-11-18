/**
 * Test preload (9.4): realtime events go nowhere unless a test installs its own
 * transport (globalThis.__realtimeRedis / setMailboxChangePublisher) — the
 * message store publishes on every write, and a real Redis client would keep
 * the test process alive.
 */
(globalThis as { __realtimeRedis?: unknown }).__realtimeRedis ??= null;
export {};
