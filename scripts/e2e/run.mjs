#!/usr/bin/env node
// CoreMail e2e runner — see docs/e2e.md.
//   E2E_STATE_DIR=<dir outside the repo> node scripts/e2e/run.mjs [step ...]
// Steps run in order; state (ids, tokens) is persisted in $E2E_STATE_DIR/state.json
// so single steps can be re-run.
import { flushResults, loadState, saveState } from './lib.mjs';

const ALL = ['setup', 'users', 'smtp', 'imap', 'pop3', 'jmap', 'dav', 'eas', 'eas-body', 'eas-commands', 'eas-legacy', 'rest', 'webmail', 'mailbox-mgmt', 'admin', 'tls', 'legacy-clients', 'backup', 'branding', 'mfa', 'live', 'protocols', 'policies', 'mapi', 'lockout', 'restart', 'storage', 'schema-upgrade'];
const steps = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

const state = loadState();
for (const name of steps) {
  if (!ALL.includes(name)) { console.error(`unknown step ${name}`); process.exit(2); }
  console.log(`\n══ step: ${name} ══`);
  const mod = await import(`./steps/${name}.mjs`);
  try {
    await mod.run(state);
  } catch (err) {
    console.error(`step ${name} aborted:`, err);
  } finally {
    saveState(state);
  }
}
const failed = flushResults(steps.join('+'));
process.exit(failed ? 1 : 0);
