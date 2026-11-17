/**
 * Review 7.1.0 (CRITICAL): device block, remote wipe and the policy-key handshake were never
 * enforced — any device synced without provisioning, a BLOCKED or WIPED device kept syncing
 * and never received a wipe. Covers [MS-ASPROV] phase 1/2 (temporary → final key),
 * X-MS-PolicyKey checks (142/144), BLOCKED (129), RemoteWipe + acknowledgement (140 after).
 * Run: node --import tsx --test src/device-policy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, clientWbxml, wbxmlTags, type WNode } from './test-support/fake-db.js';

const db = installFakeDb({ activeSyncDevice: [] });

const { deviceAccess, deniedResponse, EAS_GLOBAL_STATUS, newPolicyKey } = await import('./device-policy.js');
const { handleProvision } = await import('./commands/provision.js');
const { decodeWbxml } = await import('./wbxml.js');
type E = import('./wbxml.js').WbxmlElement;

const P = (t: number, k?: WNode[] | string): WNode => [14, t, k];
const kid = (e: E | undefined, name: string): E | undefined => e?.children?.find((c): c is E => typeof c !== 'string' && c.name === name);
const policyOf = (t: E) => kid(kid(t, 'Policies'), 'Policy');
const phase1 = () => P(0x05, [P(0x06, [P(0x07, [P(0x08, 'MS-EAS-Provisioning-WBXML')])])]);
const phase2 = (key: string) => P(0x05, [P(0x06, [P(0x07, [P(0x08, 'MS-EAS-Provisioning-WBXML'), P(0x09, key), P(0x0b, '1')])])]);
const provision = async (node: WNode) => decodeWbxml(await handleProvision(decodeWbxml(clientWbxml(node)), 'u1', 'DEV1', 'iPhone'));
const device = () => db.tables['activeSyncDevice']!.find((d) => d['deviceId'] === 'DEV1')!;
const access = (command: string, key: string | undefined) => deviceAccess(device() as { status: string; policyKey: string }, command, key);

test('policy keys are random non-zero uint32 values', () => {
  for (let i = 0; i < 200; i++) {
    const k = Number(newPolicyKey());
    assert.ok(Number.isInteger(k) && k > 0 && k <= 0xffffffff, String(k));
  }
});

test('no device / unprovisioned / missing key → 142, wrong key → 144, Provision always allowed', () => {
  assert.deepEqual(deviceAccess(null, 'Sync', '123'), { allow: false, status: '142' });
  assert.deepEqual(deviceAccess(null, 'Provision', undefined), { allow: true });
  assert.deepEqual(deviceAccess({ status: 'OK', policyKey: '0' }, 'FolderSync', '0'), { allow: false, status: '142' });
  assert.deepEqual(deviceAccess({ status: 'OK', policyKey: '77' }, 'Sync', undefined), { allow: false, status: '142' });
  assert.deepEqual(deviceAccess({ status: 'OK', policyKey: '77' }, 'Sync', '0'), { allow: false, status: '142' });
  assert.deepEqual(deviceAccess({ status: 'OK', policyKey: '77' }, 'Sync', '78'), { allow: false, status: '144' });
  assert.deepEqual(deviceAccess({ status: 'OK', policyKey: '77' }, 'GetAttachment', '77'), { allow: true });
  assert.deepEqual(deviceAccess({ status: 'BLOCKED', policyKey: '77' }, 'Ping', '77'), { allow: false, status: '129' });
  assert.deepEqual(deviceAccess({ status: 'PENDING', policyKey: '77' }, 'Ping', '77'), { allow: false, status: '129' });
  assert.deepEqual(deviceAccess({ status: 'WIPED', policyKey: '77' }, 'Sync', '77'), { allow: false, status: '140' });
});

test('refusal bytes: global status inside the command element (14.x), HTTP 449/403 otherwise', () => {
  // <Sync><Status>142</Status></Sync> on page 0
  const sync = deniedResponse('Sync', EAS_GLOBAL_STATUS.DEVICE_NOT_PROVISIONED, '14.1', '77');
  assert.equal(sync.httpStatus, 200);
  assert.deepEqual([...sync.body!], [0x03, 0x01, 0x6a, 0x00, 0x00, 0x00, 0x45, 0x4e, 0x03, 0x31, 0x34, 0x32, 0x00, 0x01, 0x01]);
  // FolderSync (page 7): FolderSync 0x16, Status 0x0c
  const fs = deniedResponse('FolderSync', EAS_GLOBAL_STATUS.DEVICE_BLOCKED, '14.0', '77');
  assert.deepEqual(wbxmlTags(fs.body!), [[7, 0x16], [7, 0x0c]]);
  assert.equal(kid(decodeWbxml(fs.body!), 'Status')?.text, '129');
  // Ping (page 13), ItemOperations (page 20)
  assert.deepEqual(wbxmlTags(deniedResponse('Ping', EAS_GLOBAL_STATUS.REMOTE_WIPE_REQUESTED, '14.1', undefined).body!), [[13, 0x05], [13, 0x07]]);
  assert.deepEqual(wbxmlTags(deniedResponse('ItemOperations', EAS_GLOBAL_STATUS.INVALID_POLICY_KEY, '14.1', '78').body!), [[20, 0x05], [20, 0x0d]]);
  // no WBXML response (GetAttachment) or protocol < 14 → HTTP status
  assert.deepEqual(deniedResponse('GetAttachment', EAS_GLOBAL_STATUS.DEVICE_NOT_PROVISIONED, '14.1', undefined), { httpStatus: 449 });
  assert.deepEqual(deniedResponse('Sync', EAS_GLOBAL_STATUS.INVALID_POLICY_KEY, '12.1', '78'), { httpStatus: 449 });
  assert.deepEqual(deniedResponse('Sync', EAS_GLOBAL_STATUS.DEVICE_BLOCKED, '12.1', '77'), { httpStatus: 403 });
});

test('12.1 has no global status codes: the HTTP codes of [MS-ASCMD] 2.2.2 for every command (449; 403 blocked, or wipe without key)', () => {
  const commands = ['Sync', 'FolderSync', 'Ping', 'SendMail', 'SmartReply', 'SmartForward', 'ItemOperations', 'GetItemEstimate',
    'Settings', 'Search', 'MoveItems', 'MeetingResponse', 'ResolveRecipients', 'GetAttachment'];
  const expected = (status: string, key: string | undefined) => (status === '129' || (status === '140' && key === undefined) ? 403 : 449);
  for (const command of commands) {
    for (const status of Object.values(EAS_GLOBAL_STATUS)) {
      for (const key of ['77', undefined]) {
        assert.deepEqual(deniedResponse(command, status, '12.1', key), { httpStatus: expected(status, key) }, `${command} ${status} key=${key}`);
      }
    }
    if (command !== 'GetAttachment') {
      const wbxml = deniedResponse(command, EAS_GLOBAL_STATUS.DEVICE_NOT_PROVISIONED, '14.0', undefined);
      assert.equal(wbxml.httpStatus, 200, command);
      assert.equal(kid(decodeWbxml(wbxml.body!), 'Status')?.text, '142', command);
    }
  }
  // a wipe with a key header (also "0") → 449: the device provisions and receives <RemoteWipe/>; a blank header = no key
  assert.deepEqual(deniedResponse('Sync', EAS_GLOBAL_STATUS.REMOTE_WIPE_REQUESTED, '12.1', '0'), { httpStatus: 449 });
  assert.deepEqual(deniedResponse('Sync', EAS_GLOBAL_STATUS.REMOTE_WIPE_REQUESTED, '12.1', ' '), { httpStatus: 403 });
});

test('Provision phase 1 → temporary key (not usable), phase 2 → final key (usable); wrong key → policy Status 5', async () => {
  const p1 = await provision(phase1());
  assert.equal(kid(p1, 'Status')?.text, '1');
  const temp = kid(policyOf(p1), 'PolicyKey')!.text!;
  assert.ok(/^\d+$/.test(temp) && Number(temp) <= 0xffffffff);
  assert.equal(kid(kid(kid(policyOf(p1), 'Data'), 'EASProvisionDoc'), 'MaxEmailAgeFilter')?.text, '0', 'no age limit imposed');
  assert.deepEqual(access('Sync', temp), { allow: false, status: '142' }, 'the temporary key does not grant access');

  const wrong = await provision(phase2(String((Number(temp) % 0xfffffffe) + 1)));
  assert.equal(kid(policyOf(wrong), 'Status')?.text, '5');
  assert.equal(kid(policyOf(wrong), 'PolicyKey'), undefined);

  const p2 = await provision(phase2(temp));
  const final = kid(policyOf(p2), 'PolicyKey')!.text!;
  assert.equal(kid(policyOf(p2), 'Status')?.text, '1');
  assert.equal(kid(policyOf(p2), 'Data'), undefined, 'phase 2 carries no policy document');
  assert.notEqual(final, temp);
  assert.deepEqual(access('Sync', final), { allow: true });
  assert.deepEqual(access('Sync', temp), { allow: false, status: '144' });
  // replaying phase 2 with the consumed temporary key fails
  assert.equal(kid(policyOf(await provision(phase2(temp))), 'Status')?.text, '5');
  assert.deepEqual(access('Sync', final), { allow: true });
  // every Provision tag is on page 14
  assert.ok(wbxmlTags(await handleProvision(decodeWbxml(clientWbxml(phase1())), 'u1', 'DEV1', 'iPhone')).every(([p]) => p === 14));
});

test('unknown PolicyType → policy Status 3; DeviceInformation in Provision → stored + its Status', async () => {
  const t = await provision(P(0x05, [P(0x06, [P(0x07, [P(0x08, 'MS-WAP-Provisioning-XML')])])]));
  assert.equal(kid(policyOf(t), 'Status')?.text, '3');
  const S = (tok: number, k?: WNode[] | string): WNode => [18, tok, k];
  const withInfo = await provision(P(0x05, [S(0x16, [S(0x08, [S(0x19, "Bob's phone")])]), P(0x06, [P(0x07, [P(0x08, 'MS-EAS-Provisioning-WBXML')])])]));
  assert.equal(kid(kid(withInfo, 'DeviceInformation'), 'Status')?.text, '1');
  assert.equal(device()['deviceFriendlyName'], "Bob's phone");
});

test('BLOCKED device: Provision Status 129, every command refused', async () => {
  device()['status'] = 'BLOCKED';
  const t = await provision(phase1());
  assert.equal(kid(t, 'Status')?.text, '129');
  assert.equal(kid(t, 'Policies'), undefined);
  assert.deepEqual(access('Sync', String(device()['policyKey'])), { allow: false, status: '129' });
  device()['status'] = 'OK';
});

test('remote wipe: commands → 140, Provision → <RemoteWipe/>, acknowledgement recorded, device stays refused', async () => {
  const key = String(device()['policyKey']);
  assert.deepEqual(access('FolderSync', key), { allow: true });
  Object.assign(device(), { status: 'WIPED', remoteWipeAt: new Date(), remoteWipeAckAt: null }); // admin POST /wipe
  assert.deepEqual(access('FolderSync', key), { allow: false, status: '140' });

  const buf = await handleProvision(decodeWbxml(clientWbxml(phase1())), 'u1', 'DEV1', 'iPhone');
  // <Provision><Status>1</Status><RemoteWipe/></Provision>: RemoteWipe = page 14 token 0x0c, no content
  assert.deepEqual([...buf], [0x03, 0x01, 0x6a, 0x00, 0x00, 0x0e, 0x45, 0x4b, 0x03, 0x31, 0x00, 0x01, 0x0c, 0x01]);
  assert.equal(device()['remoteWipeAckAt'], null, 'not acknowledged yet');

  // device acknowledges: <Provision><RemoteWipe><Status>1</Status></RemoteWipe></Provision>
  const ack = await provision(P(0x05, [P(0x0c, [P(0x0b, '1')])]));
  assert.equal(kid(ack, 'Status')?.text, '1');
  assert.equal(kid(ack, 'RemoteWipe'), undefined);
  assert.ok(device()['remoteWipeAckAt'] instanceof Date);
  assert.equal(device()['policyKey'], '0');
  // still blocked afterwards: every command refused, a new Provision wipes again
  assert.deepEqual(access('Sync', key), { allow: false, status: '140' });
  assert.ok(kid(await provision(phase1()), 'RemoteWipe'));
  assert.equal(kid(await provision(phase1()), 'Policies'), undefined, 'no new policy key for a wiped device');
});
