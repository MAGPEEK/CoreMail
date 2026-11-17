/**
 * EAS protocol versions ([MS-ASHTTP] MS-ASProtocolVersion / MS-ASProtocolVersions).
 *
 * The server speaks 12.1, 14.0 and 14.1. Every request names the version it uses (header,
 * or the version byte of the base64 query form — see request.ts); the version is
 * remembered per device (`ActiveSyncDevice.protocolVersion`) and is the fallback for a
 * request without one. Commands never compare version numbers themselves: they ask
 * `supports(version, feature)` for the protocol element that differs between versions.
 *
 * No runtime imports (pure).
 */

/** Versions this server implements, lowest first (announced in OPTIONS). */
export const EAS_VERSIONS = ['12.1', '14.0', '14.1'] as const;
export type EasVersion = (typeof EAS_VERSIONS)[number];
export const HIGHEST_EAS_VERSION: EasVersion = '14.1';

/**
 * First version with each version-dependent protocol element ([MS-ASCMD], [MS-ASAIRS],
 * [MS-ASEMAIL], [MS-ASPROV], [MS-ASWBXML]).
 */
const FEATURE_SINCE = {
  /** Common status codes (101–177, e.g. 129/140/142/144) inside the command's WBXML response; earlier HTTP 403/449. */
  globalStatus: '14.0',
  /** SendMail/SmartReply/SmartForward as ComposeMail WBXML; earlier raw MIME body + query parameters, empty response. */
  composeMailWbxml: '14.0',
  /** Email2 code page (ConversationId, ConversationIndex, …). */
  email2: '14.0',
  /** airsyncbase:Preview in a Body. */
  bodyPreview: '14.0',
  /** ResolveRecipients Availability (free/busy). */
  recipientAvailability: '14.0',
  /** GetItemEstimate Collection with airsync:Options (FilterType) and without Class; earlier both direct children. */
  estimateOptions: '14.0',
  /** settings:DeviceInformation inside the Provision request/response. */
  provisionDeviceInformation: '14.1',
  /** Settings UserInformation in the Accounts form (PrimarySmtpAddress, UserDisplayName). */
  userInformationAccounts: '14.1',
  /** Settings RightsManagementInformation. */
  rightsManagement: '14.1',
} as const satisfies Record<string, EasVersion>;
export type EasFeature = keyof typeof FEATURE_SINCE;

export function isEasVersion(value: string): value is EasVersion {
  return (EAS_VERSIONS as readonly string[]).includes(value);
}

/** True when `version` is `min` or newer. */
export function atLeast(version: EasVersion, min: EasVersion): boolean {
  return EAS_VERSIONS.indexOf(version) >= EAS_VERSIONS.indexOf(min);
}

/** True when the protocol element `feature` exists in `version`. */
export function supports(version: EasVersion, feature: EasFeature): boolean {
  return atLeast(version, FEATURE_SINCE[feature]);
}

export type VersionNegotiation = { ok: true; version: EasVersion } | { ok: false; requested: string };

/**
 * The version a request is served with: the requested one when the server announced it
 * (anything else is refused — the client must pick from MS-ASProtocolVersions); without
 * a requested version the device's remembered one, else the highest.
 */
export function negotiateVersion(requested: string | undefined, remembered: string | null | undefined): VersionNegotiation {
  const wanted = (requested ?? '').trim();
  if (wanted !== '') return isEasVersion(wanted) ? { ok: true, version: wanted } : { ok: false, requested: wanted };
  return { ok: true, version: remembered && isEasVersion(remembered) ? remembered : HIGHEST_EAS_VERSION };
}
