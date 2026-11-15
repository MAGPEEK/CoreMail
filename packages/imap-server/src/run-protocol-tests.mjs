/**
 * TEST-ONLY runner for the loopback IMAP protocol suite (src/server/imap-protocol.test.ts).
 * The suite replaces @coremail/core / @coremail/storage through module hooks
 * (test-hooks.mjs: module.registerHooks, Node >= 22.15) and runs the TypeScript
 * sources directly (--experimental-transform-types). On older Node versions it
 * is skipped with a notice instead of failing the whole test run.
 * Run (in packages/imap-server): node src/run-protocol-tests.mjs
 */
import { spawnSync } from 'node:child_process';
import module from 'node:module';
import { fileURLToPath } from 'node:url';

if (typeof module.registerHooks !== 'function') {
  console.log(`imap-protocol.test.ts skipped: needs Node >= 22.15 (running ${process.version})`);
  process.exit(0);
}
const run = spawnSync(process.execPath, [
  '--experimental-transform-types', '--no-warnings',
  '--import', new URL('./test-hooks.mjs', import.meta.url).href,
  '--test', fileURLToPath(new URL('./server/imap-protocol.test.ts', import.meta.url)),
  // v9.1: shared / delegated mailboxes (multi-mailbox fake)
  fileURLToPath(new URL('./server/imap-shared.test.ts', import.meta.url)),
], { stdio: 'inherit' });
process.exit(run.status ?? 1);
