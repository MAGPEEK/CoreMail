import { prisma } from '@coremail/storage/prisma';
import { encodeWbxml, el, type WbxmlElement } from '../wbxml.js';

/**
 * EAS Provision command (Phase 1 + 2)
 * Phase 1: Server sends policies, client acknowledges
 * Phase 2: Client sends policyKey, server confirms
 */
export async function handleProvision(
  body: WbxmlElement,
  userId: string,
  deviceId: string,
  deviceType: string,
): Promise<Buffer> {
  // Find or create device record
  let device = await prisma.activeSyncDevice.findUnique({
    where: { userId_deviceId: { userId, deviceId } },
  });
  if (!device) {
    device = await prisma.activeSyncDevice.create({
      data: { userId, deviceId, deviceType, status: 'OK' },
    });
  }

  // Generate new policy key
  const newPolicyKey = String(Date.now());

  // Update device
  await prisma.activeSyncDevice.update({
    where: { id: device.id },
    data: { policyKey: newPolicyKey, lastSyncAt: new Date() },
  });

  // Build response with permissive policy
  const response: WbxmlElement = el('Provision', undefined, [
    el('Status', '1'),
    el('Policies', undefined, [
      el('Policy', undefined, [
        el('PolicyType', 'MS-EAS-Provisioning-WBXML'),
        el('Status', '1'),
        el('PolicyKey', newPolicyKey),
        el('Data', undefined, [
          el('EASProvisionDoc', undefined, [
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
            el('MaxEmailAgeFilter', '5'),
            el('AllowBrowser', '1'),
            el('AllowConsumerEmail', '1'),
            el('AllowInternetSharing', '1'),
          ]),
        ]),
      ]),
    ]),
  ]);

  return encodeWbxml(response);
}
