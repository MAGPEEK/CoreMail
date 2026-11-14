// Child-process fixture for http.test.ts (not a test file itself).
import { installProcessGuards } from './process-guards.js';

const log = {
  error: (_o: object, msg?: string) => console.log(`ERROR ${msg ?? ''}`),
  fatal: (_o: object, msg?: string) => console.log(`FATAL ${msg ?? ''}`),
};
installProcessGuards(log);

void Promise.reject(new Error('stray rejection'));
setTimeout(() => {
  console.log('ALIVE_AFTER_REJECTION');
  setTimeout(() => { throw new Error('sync crash'); }, 10);
}, 50);
// Keep the event loop alive in case the guard does not exit
setTimeout(() => { console.log('STILL_RUNNING'); process.exit(0); }, 5_000);
