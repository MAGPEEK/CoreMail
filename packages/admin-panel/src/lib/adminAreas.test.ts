import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaForPath, accessForPath, firstAllowedPath } from './adminAreas.ts';

test('areaForPath maps routes (with and without /bcp prefix)', () => {
  assert.equal(areaForPath('/mailboxes'), 'recipients');
  assert.equal(areaForPath('/bcp/smtp-config'), 'servers');
  assert.equal(areaForPath('/bcp/audit-log'), 'compliance');
  assert.equal(areaForPath('/transport-rules'), 'hygiene');
  assert.equal(areaForPath('/sso'), 'identity');
  assert.equal(areaForPath('/compliance-info'), null);
  assert.equal(areaForPath('/unknown'), undefined);
  assert.equal(areaForPath('/'), 'dashboard');
});

test('accessForPath: no adminAreas from the server keeps full access', () => {
  assert.equal(accessForPath(null, '/mailboxes'), 'write');
});

test('accessForPath: missing area → none, read → read', () => {
  const areas = { recipients: 'read', domains: 'write' } as const;
  assert.equal(accessForPath(areas, '/mailboxes'), 'read');
  assert.equal(accessForPath(areas, '/domains'), 'write');
  assert.equal(accessForPath(areas, '/servers'), 'none');
  assert.equal(accessForPath(areas, '/compliance-info'), 'write');
});

test('firstAllowedPath', () => {
  assert.equal(firstAllowedPath(null), '/dashboard');
  assert.equal(firstAllowedPath({ domains: 'read' }), '/domains');
  assert.equal(firstAllowedPath({}), '/compliance-info');
});
