/**
 * Review fix — regex step budget per rule, fail-closed for blocking transport rules.
 * A sender padding a message so that the regex budget runs out must not switch
 * off later reject/quarantine/redirect rules.
 * Run: node --import tsx --test src/rule-budget.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

let transportRules: unknown[] = [];
let mailRules: unknown[] = [];
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  transportRule: { findMany: async () => transportRules },
  mailRule: { findMany: async () => mailRules },
  folder: { findFirst: async () => ({ id: 'f-target' }) },
};

const {
  createRulePatternBudget, withRuleBudget, evaluateRulePattern, ruleMessageStepBudget,
  DEFAULT_RULE_PATTERN_STEP_BUDGET, DEFAULT_RULE_PATTERN_MESSAGE_STEP_BUDGET,
} = await import('./rule-pattern.js');
const { applyTransportRules, ruleFailsClosed } = await import('./transport-rules.js');
const { applyMailRules } = await import('./mail-rules.js');

/** Pathological for the step count, linear in time: one budget's worth on 64 KB. */
const EXPENSIVE = '(?:[a-z]?){99}[a-z]{99}x';
const PADDED_BODY = 'a'.repeat(64 * 1024);

const parsed = (body: string) => ({
  fromAddr: 'mallory@evil.test', toAddrs: ['bob@corp.test'], ccAddrs: [], bccAddrs: [], subject: 'Invoice',
  bodyText: body, bodyHtml: '', attachments: [], size: body.length,
}) as never;

test('evaluateRulePattern is tri-state and the message cap defaults to 4 × the per-rule budget', () => {
  assert.equal(evaluateRulePattern('needle', 'a needle', createRulePatternBudget()), 'match');
  assert.equal(evaluateRulePattern('needle', 'hay', createRulePatternBudget()), 'nomatch');
  assert.equal(evaluateRulePattern('needle', 'x'.repeat(5000), createRulePatternBudget({ steps: 100 })), 'exhausted');
  assert.equal(evaluateRulePattern('(', 'x', createRulePatternBudget()), 'invalid');
  assert.equal(ruleMessageStepBudget({}), DEFAULT_RULE_PATTERN_MESSAGE_STEP_BUDGET);
  assert.equal(DEFAULT_RULE_PATTERN_MESSAGE_STEP_BUDGET, 4 * DEFAULT_RULE_PATTERN_STEP_BUDGET);
  assert.equal(ruleMessageStepBudget({ RULE_PATTERN_STEP_BUDGET: '1000', RULE_PATTERN_MESSAGE_STEP_BUDGET: '10' }), 1000);
});

test('withRuleBudget: each rule gets its own budget, charged to the message cap', () => {
  const message = createRulePatternBudget({ steps: 2500 });
  // rule 1 burns its whole per-rule budget …
  const r1 = withRuleBudget(message, (b) => evaluateRulePattern('needle', 'x'.repeat(5000), b), 1000);
  assert.equal(r1, 'exhausted');
  // … rule 2 still has a fresh one
  assert.equal(withRuleBudget(message, (b) => evaluateRulePattern('needle', 'xx needle', b), 1000), 'match');
  assert.ok(message.remaining < 1500 && !message.exhausted);
  // the message cap still bounds the total
  withRuleBudget(message, (b) => evaluateRulePattern('needle', 'x'.repeat(5000), b), 1000);
  withRuleBudget(message, (b) => evaluateRulePattern('needle', 'x'.repeat(5000), b), 1000);
  assert.equal(message.exhausted, true);
  assert.equal(withRuleBudget(message, (b) => evaluateRulePattern('needle', 'needle', b), 1000), 'exhausted');
});

test('padding cannot switch off a later reject rule: exhausted conditions fail closed', async () => {
  transportRules = [
    { id: 'tag', name: 'tag', enabled: true, priority: 1, conditions: [{ field: 'body', op: 'regex', value: EXPENSIVE }], actions: [{ type: 'addHeader', value: 'X-Tag: 1' }] },
    { id: 'block', name: 'block', enabled: true, priority: 2, conditions: [{ field: 'body', op: 'regex', value: EXPENSIVE }], actions: [{ type: 'reject', value: 'blocked' }] },
  ];
  const outcome = await applyTransportRules(parsed(PADDED_BODY));
  assert.equal(outcome.rejected, true, 'blocking rule treated as match');
  assert.deepEqual(outcome.appliedRuleIds, ['block'], 'non-blocking rule treated as no match');
  assert.deepEqual(outcome.headerAdds, []);
  assert.equal(ruleFailsClosed([{ type: 'quarantine' }]), true);
  assert.equal(ruleFailsClosed([{ type: 'redirect' }]), true);
  assert.equal(ruleFailsClosed([{ type: 'addHeader' }]), false);
});

test('a cheap later reject rule still evaluates normally after an expensive earlier rule', async () => {
  transportRules = [
    { id: 'tag', name: 'tag', enabled: true, priority: 1, conditions: [{ field: 'body', op: 'regex', value: EXPENSIVE }], actions: [{ type: 'addHeader', value: 'X-Tag: 1' }] },
    { id: 'block', name: 'block', enabled: true, priority: 2, conditions: [{ field: 'subject', op: 'regex', value: '^invoice$' }], actions: [{ type: 'reject', value: 'no invoices' }] },
    { id: 'other', name: 'other', enabled: true, priority: 3, conditions: [{ field: 'subject', op: 'regex', value: '^order$' }], actions: [{ type: 'quarantine', value: '' }] },
  ];
  const outcome = await applyTransportRules(parsed(PADDED_BODY));
  assert.equal(outcome.rejected, true);
  assert.equal(outcome.quarantined, false, 'a definite no-match stays a no-match');
});

test('inbox rules: an exhausted condition does not match, an exhausted exception counts as matched', async () => {
  mailRules = [
    { id: 'm1', userId: 'u1', name: 'cond', enabled: true, priority: 1, matchAll: true, stopProcessing: false,
      conditions: [{ field: 'body', operator: 'regex', value: EXPENSIVE }], exceptions: [], actions: [{ type: 'markRead' }] },
    { id: 'm2', userId: 'u1', name: 'exc', enabled: true, priority: 2, matchAll: true, stopProcessing: false,
      conditions: [{ field: 'subject', operator: 'contains', value: 'invoice' }],
      exceptions: [{ field: 'body', operator: 'regex', value: EXPENSIVE }], actions: [{ type: 'markFlagged' }] },
    { id: 'm3', userId: 'u1', name: 'plain', enabled: true, priority: 3, matchAll: true, stopProcessing: false,
      conditions: [{ field: 'subject', operator: 'regex', value: 'invoice' }], exceptions: [], actions: [{ type: 'pin' }] },
  ];
  const outcome = await applyMailRules(parsed(PADDED_BODY), 'u1', 'bob@corp.test', 'f-inbox');
  assert.deepEqual(outcome.appliedRuleIds, ['m3']);
  assert.deepEqual(outcome.flagsToAdd, []);
  assert.equal(outcome.pinned, true);
});
