import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRegisterForm, parseRegisterConfig, registerBody, registerErrorOf, validLocalPart } from './selfRegistration.ts';

const form = { displayName: 'Erika', localPart: 'erika', domainId: 'dA', password: 'longpassword', passwordConfirm: 'longpassword', inviteCode: '' };
const cfg = { minPasswordLength: 8, inviteRequired: false, formToken: 'tok' };

test('config: off / malformed → null; defaults applied', () => {
  assert.equal(parseRegisterConfig(null), null);
  assert.equal(parseRegisterConfig({ error: 'Not found' }), null);
  assert.equal(parseRegisterConfig({ enabled: true, domains: [], formToken: 'x' }), null);
  const c = parseRegisterConfig({ enabled: true, domains: [{ id: 'd', name: 'a.example' }, { bad: 1 }], formToken: 'x', mode: '??' });
  assert.deepEqual(c, { enabled: true, domains: [{ id: 'd', name: 'a.example' }], inviteRequired: false, mode: 'approval', minPasswordLength: 8, formToken: 'x' });
});

test('local part rule matches the server', () => {
  for (const ok of ['a', 'erika.muster', 'a_b-c', 'X1']) assert.equal(validLocalPart(ok), true, ok);
  for (const bad of ['', '.a', 'a.', 'a..b', 'a b', 'a+b', 'é', 'x'.repeat(65)]) assert.equal(validLocalPart(bad), false, bad);
});

test('client checks in field order', () => {
  assert.equal(checkRegisterForm(form, cfg), null);
  assert.equal(checkRegisterForm({ ...form, displayName: ' ' }, cfg)?.field, 'displayName');
  assert.equal(checkRegisterForm({ ...form, localPart: 'a..b' }, cfg)?.field, 'localPart');
  assert.equal(checkRegisterForm({ ...form, password: 'short', passwordConfirm: 'short' }, cfg)?.key, 'register_err_password_short');
  assert.equal(checkRegisterForm({ ...form, passwordConfirm: 'other' }, cfg)?.key, 'register_err_mismatch');
  assert.equal(checkRegisterForm(form, { ...cfg, inviteRequired: true })?.field, 'inviteCode');
});

test('server codes map to fields; taken and reserved share one text', () => {
  assert.deepEqual(registerErrorOf(409, 'ADDRESS_UNAVAILABLE'), { field: 'localPart', key: 'register_err_unavailable' });
  assert.equal(registerErrorOf(400, 'INVALID_FORM').key, 'register_err_form');
  assert.equal(registerErrorOf(429, undefined).key, 'register_err_rate');
  assert.equal(registerErrorOf(503, undefined).key, 'register_err_maintenance');
  assert.equal(registerErrorOf(500, undefined).key, 'register_err_generic');
});

test('request body: trimmed, lower-cased local part, invite only when required, honeypot passed through', () => {
  const b = registerBody({ ...form, localPart: ' Erika ', inviteCode: ' C0DE ' }, cfg, '');
  assert.deepEqual(b, { domainId: 'dA', displayName: 'Erika', localPart: 'erika', password: 'longpassword', formToken: 'tok', website: '' });
  assert.equal(registerBody({ ...form, inviteCode: ' C0DE ' }, { ...cfg, inviteRequired: true }, '')['inviteCode'], 'C0DE');
});
