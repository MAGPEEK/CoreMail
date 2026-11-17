/**
 * Device access control ([MS-ASPROV] policy-key handshake, [MS-ASHTTP] X-MS-PolicyKey,
 * [MS-ASCMD] global status codes).
 *
 * Every command except Provision needs a provisioned device whose final policy key
 * matches the request's `X-MS-PolicyKey` header. A blocked (or not yet approved)
 * device is refused, and a device with a pending remote wipe is told to provision —
 * Provision then answers `<RemoteWipe/>` (see commands/provision.ts).
 *
 * Protocol 14.0+ gets the global status inside the command's WBXML response
 * (`<Sync><Status>142</Status></Sync>`); 12.1 (no global status codes) and commands
 * without a WBXML response such as GetAttachment get HTTP 449 (provision) / 403 (blocked,
 * or a pending wipe without policy key) — see `httpStatusOf`.
 *
 * No runtime imports besides the WBXML and version helpers.
 */
import { randomInt } from 'node:crypto';
import { encodeWbxml, el } from './wbxml.js';
import { supports, type EasVersion } from './protocol-version.js';

export const EAS_GLOBAL_STATUS = {
  DEVICE_BLOCKED: '129',
  REMOTE_WIPE_REQUESTED: '140',
  DEVICE_NOT_PROVISIONED: '142',
  INVALID_POLICY_KEY: '144',
} as const;
export type EasGlobalStatus = (typeof EAS_GLOBAL_STATUS)[keyof typeof EAS_GLOBAL_STATUS];

export interface DeviceAccessRow {
  status: string;
  policyKey: string;
}

export type DeviceAccess = { allow: true } | { allow: false; status: EasGlobalStatus };

/** Statuses an admin sets to keep a device out (PENDING = not approved yet). */
const REFUSED = new Set(['BLOCKED', 'PENDING']);

/** Decide whether `command` may run for this device with the given X-MS-PolicyKey header. */
export function deviceAccess(device: DeviceAccessRow | null, command: string, headerKey: string | undefined): DeviceAccess {
  if (command === 'Provision') return { allow: true }; // handles wipe / block itself
  if (!device) return { allow: false, status: EAS_GLOBAL_STATUS.DEVICE_NOT_PROVISIONED };
  if (device.status === 'WIPED') return { allow: false, status: EAS_GLOBAL_STATUS.REMOTE_WIPE_REQUESTED };
  if (REFUSED.has(device.status)) return { allow: false, status: EAS_GLOBAL_STATUS.DEVICE_BLOCKED };
  if (!device.policyKey || device.policyKey === '0') return { allow: false, status: EAS_GLOBAL_STATUS.DEVICE_NOT_PROVISIONED };
  const key = (headerKey ?? '').trim();
  if (key === '' || key === '0') return { allow: false, status: EAS_GLOBAL_STATUS.DEVICE_NOT_PROVISIONED };
  if (key !== device.policyKey) return { allow: false, status: EAS_GLOBAL_STATUS.INVALID_POLICY_KEY };
  return { allow: true };
}

/** Root element of each command's WBXML response (its Status is the global status). */
const RESPONSE_ROOT: Record<string, string> = {
  Sync: 'Sync', FolderSync: 'FolderSync', Ping: 'Ping', SendMail: 'SendMail', SmartReply: 'SmartReply',
  SmartForward: 'SmartForward', ItemOperations: 'ItemOperations', GetItemEstimate: 'GetItemEstimate',
  Settings: 'Settings', Search: 'Search', MoveItems: 'MoveItems', MeetingResponse: 'MeetingResponse',
  ResolveRecipients: 'ResolveRecipients',
};

/**
 * HTTP status of a refusal without WBXML body — the codes [MS-ASCMD] 2.2.2 (Common Status
 * Codes) gives for protocol versions without Status 1xx: 142 / 144 → 449 (provision first),
 * 140 RemoteWipeRequested → 449, but 403 when the request carries no policy key. 129 has no
 * HTTP code in that table; a blocked device gets 403 Forbidden ([MS-ASHTTP] 2.2.2.1.1).
 */
export function httpStatusOf(status: EasGlobalStatus, policyKey?: string): number {
  if (status === EAS_GLOBAL_STATUS.DEVICE_BLOCKED) return 403;
  if (status === EAS_GLOBAL_STATUS.REMOTE_WIPE_REQUESTED && (policyKey ?? '').trim() === '') return 403;
  return 449;
}

/** HTTP answer for a refused request (`policyKey`: the request's policy key, undefined = none sent). */
export function deniedResponse(
  command: string, status: EasGlobalStatus, version: EasVersion, policyKey: string | undefined,
): { httpStatus: number; body?: Buffer } {
  const root = RESPONSE_ROOT[command];
  if (!root || !supports(version, 'globalStatus')) return { httpStatus: httpStatusOf(status, policyKey) };
  return { httpStatus: 200, body: encodeWbxml(el(root, undefined, [el('Status', status)])) };
}

/** Random non-zero 32-bit policy key ([MS-ASPROV] PolicyKey is an unsigned 32-bit integer). */
export function newPolicyKey(): string {
  return String(randomInt(1, 0xffffffff));
}
