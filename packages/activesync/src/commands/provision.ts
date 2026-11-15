import { prisma } from '@coremail/storage/prisma';
import { createLogger } from '@coremail/core/logger';
import { encodeWbxml, el, getChild, getText, type WbxmlElement } from '../wbxml.js';
import { EAS_GLOBAL_STATUS, newPolicyKey } from '../device-policy.js';

const log = createLogger('activesync:provision');

export const POLICY_TYPE = 'MS-EAS-Provisioning-WBXML';

/** [MS-ASPROV] provision:Status (top level) and policy Status values. */
export const PROVISION_STATUS = { SUCCESS: '1', PROTOCOL_ERROR: '2', SERVER_ERROR: '3' } as const;
export const POLICY_STATUS = { SUCCESS: '1', NO_POLICY: '2', UNKNOWN_POLICY_TYPE: '3', WRONG_POLICY_KEY: '5' } as const;

/** The (permissive) EAS provisioning document sent in phase 1. */
function provisionDoc(): WbxmlElement {
  return el('EASProvisionDoc', undefined, [
    el('DevicePasswordEnabled', '0'),
    el('AlphanumericDevicePasswordRequired', '0'),
    el('RequireStorageCardEncryption', '0'),
    el('PasswordRecoveryEnabled', '0'),
    el('AttachmentsEnabled', '1'),
    el('AllowSimpleDevicePassword', '1'),
    el('AllowStorageCard', '1'),
    el('AllowCamera', '1'),
    el('RequireDeviceEncryption', '0'),
    el('AllowWiFi', '1'),
    el('AllowTextMessaging', '1'),
    el('AllowPOPIMAPEmail', '1'),
    el('AllowBluetooth', '2'),
    el('AllowDesktopSync', '1'),
    el('AllowHTMLEmail', '1'),
    el('MaxEmailAgeFilter', '0'), // 0 = all mail (no age limit imposed on the device)
    el('AllowBrowser', '1'),
    el('AllowConsumerEmail', '1'),
    el('AllowInternetSharing', '1'),
  ]);
}

/**
 * EAS Provision command ([MS-ASPROV]).
 *
 *  - Phase 1 (Policy without PolicyKey): the policy document + a TEMPORARY policy key.
 *  - Phase 2 (Policy with the temporary key + the client's Status): the FINAL policy key,
 *    which every later command must send as `X-MS-PolicyKey` (see device-policy.ts).
 *    A key that is not the pending temporary key → policy Status 5 (client restarts).
 *  - Remote wipe (device status WIPED): `<RemoteWipe/>` instead of a policy; the
 *    client's acknowledgement (`<RemoteWipe><Status>`) is recorded in `remoteWipeAckAt`.
 *    The device stays WIPED (all other commands refused, later Provisions wipe again)
 *    until an admin sets it back to OK.
 *  - Blocked / not approved device: Status 129.
 *  - settings:DeviceInformation in the request (14.1) → stored friendly name + its Status.
 */
export async function handleProvision(
  body: WbxmlElement,
  userId: string,
  deviceId: string,
  deviceType: string,
): Promise<Buffer> {
  let device = await prisma.activeSyncDevice.findUnique({
    where: { userId_deviceId: { userId, deviceId } },
  });
  if (!device) {
    device = await prisma.activeSyncDevice.create({
      data: { userId, deviceId, deviceType, status: 'OK' },
    });
  }

  const deviceInfo = getChild(body, 'DeviceInformation');
  const head: WbxmlElement[] = [];
  if (deviceInfo) {
    const friendly = getText(getChild(deviceInfo, 'Set') ?? deviceInfo, 'FriendlyName');
    if (friendly) {
      await prisma.activeSyncDevice.update({ where: { id: device.id }, data: { deviceFriendlyName: friendly.slice(0, 200) } });
    }
    head.push(el('Settings:DeviceInformation', undefined, [el('Settings:Status', '1')]));
  }
  const respond = (status: string, rest: WbxmlElement[] = []) =>
    encodeWbxml(el('Provision', undefined, [...head, el('Status', status), ...rest]));

  const wipeAck = getChild(body, 'RemoteWipe');

  // ── Remote wipe ────────────────────────────────────────────────────────────
  if (device.status === 'WIPED') {
    if (wipeAck) {
      const clientStatus = getText(wipeAck, 'Status');
      await prisma.activeSyncDevice.update({
        where: { id: device.id },
        data: { remoteWipeAckAt: new Date(), policyKey: '0', pendingPolicyKey: null },
      });
      log.warn({ userId, deviceId, clientStatus }, 'Remote wipe acknowledged by the device');
      return respond(PROVISION_STATUS.SUCCESS);
    }
    log.warn({ userId, deviceId }, 'Remote wipe sent to the device');
    return respond(PROVISION_STATUS.SUCCESS, [el('RemoteWipe')]);
  }
  if (device.status === 'BLOCKED' || device.status === 'PENDING') {
    return respond(EAS_GLOBAL_STATUS.DEVICE_BLOCKED);
  }
  if (wipeAck) return respond(PROVISION_STATUS.SUCCESS); // stale acknowledgement, nothing pending

  // ── Policy handshake ───────────────────────────────────────────────────────
  const policy = getChild(getChild(body, 'Policies') ?? { name: '' }, 'Policy');
  if (!policy) return respond(PROVISION_STATUS.PROTOCOL_ERROR);
  const policyType = getText(policy, 'PolicyType');
  const policyResponse = (status: string, extra: WbxmlElement[] = []) =>
    el('Policies', undefined, [el('Policy', undefined, [el('PolicyType', policyType), el('Status', status), ...extra])]);
  if (policyType !== POLICY_TYPE) {
    return respond(PROVISION_STATUS.SUCCESS, [policyResponse(POLICY_STATUS.UNKNOWN_POLICY_TYPE)]);
  }

  const clientKey = getText(policy, 'PolicyKey');
  if (clientKey) {
    // Phase 2: acknowledgement of the temporary key. The policy is permissive, so any
    // client Status (1 applied, 2 partially, 3 not applied, 4 third party) is accepted.
    if (!device.pendingPolicyKey || clientKey !== device.pendingPolicyKey) {
      return respond(PROVISION_STATUS.SUCCESS, [policyResponse(POLICY_STATUS.WRONG_POLICY_KEY)]);
    }
    const finalKey = newPolicyKey();
    await prisma.activeSyncDevice.update({
      where: { id: device.id },
      data: { policyKey: finalKey, pendingPolicyKey: null, lastSyncAt: new Date() },
    });
    return respond(PROVISION_STATUS.SUCCESS, [policyResponse(POLICY_STATUS.SUCCESS, [el('PolicyKey', finalKey)])]);
  }

  // Phase 1: policy document + temporary key (the current final key stays valid until
  // the device acknowledges the new one).
  const tempKey = newPolicyKey();
  await prisma.activeSyncDevice.update({
    where: { id: device.id },
    data: { pendingPolicyKey: tempKey, lastSyncAt: new Date() },
  });
  return respond(PROVISION_STATUS.SUCCESS, [
    policyResponse(POLICY_STATUS.SUCCESS, [el('PolicyKey', tempKey), el('Data', undefined, [provisionDoc()])]),
  ]);
}
