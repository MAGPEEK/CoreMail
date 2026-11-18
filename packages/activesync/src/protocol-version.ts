/**
 * EAS protocol versions ([MS-ASHTTP] 2.2.1.1.2.6 MS-ASProtocolVersion, 2.2.4.1.2.2
 * MS-ASProtocolVersions).
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
 * First version with each version-dependent protocol element, with the public Open
 * Specifications section that defines the version split.
 */
const FEATURE_SINCE = {
  /**
   * Common status codes (101–177, e.g. 129/140/142/144) inside the command's WBXML response;
   * 2.5–12.1 get an HTTP 4xx/5xx instead ([MS-ASCMD] 2.2.2 Common Status Codes).
   */
  globalStatus: '14.0',
  /**
   * SendMail/SmartReply/SmartForward as ComposeMail WBXML; 2.5–12.1 send the raw MIME
   * (`message/rfc822`) with the parameters in the request line ([MS-ASCMD] 2.2.1.17,
   * 2.2.1.19, 2.2.1.20 "Protocol Versions"; [MS-ASWBXML] 2.1.2.1.22 code page 21).
   */
  composeMailWbxml: '14.0',
  /** Email2 code page — ConversationId, ConversationIndex, … ([MS-ASWBXML] 2.1.2.1.23). */
  email2: '14.0',
  /** airsyncbase:Preview in a Body ([MS-ASWBXML] 2.1.2.1.18, token 0x18). */
  bodyPreview: '14.0',
  /** ResolveRecipients Availability / MergedFreeBusy ([MS-ASWBXML] 2.1.2.1.11, tokens 0x16–0x19). */
  recipientAvailability: '14.0',
  /**
   * GetItemEstimate: FilterType inside airsync:Options and no getitemestimate:Class; 2.5–12.1
   * carry both directly in the Collection ([MS-ASCMD] 2.2.3.29.1, 2.2.3.27.2, 2.2.3.68.1).
   */
  estimateOptions: '14.0',
  /** settings:DeviceInformation inside Provision ([MS-ASPROV] 2.2.2.53: 14.1, 16.0, 16.1 only). */
  provisionDeviceInformation: '14.1',
  /** Settings UserInformation Accounts form — Accounts, UserDisplayName, … ([MS-ASWBXML] 2.1.2.1.19, 0x23–0x29). */
  userInformationAccounts: '14.1',
  /** Settings RightsManagementInformation ([MS-ASWBXML] 2.1.2.1.19, token 0x2B). */
  rightsManagement: '14.1',
  /** The Notes class and its code page 23 ([MS-ASNOTE] "Protocol versions"; [MS-ASWBXML] 2.1.2.1.24). */
  notesClass: '14.0',
  /** calendar:ResponseRequested / ResponseType of a meeting ([MS-ASWBXML] 2.1.2.1.5, tokens 0x34, 0x36). */
  meetingResponseType: '14.0',
  /** FirstDayOfWeek of a calendar / task Recurrence ([MS-ASWBXML] 2.1.2.1.5 token 0x39, 2.1.2.1.10 token 0x26). */
  recurrenceFirstDayOfWeek: '14.1',
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

export interface VersionNegotiation {
  /** The version the request is served with. */
  version: EasVersion;
  /** The requested version when the server does not announce it ('' otherwise). */
  unannounced: string;
}

/**
 * The version a request is served with: the requested one when the server announces it; a
 * requested version the server does not announce (2.5, 12.0, 16.x, …) is served as the
 * highest one, as before 9.4 (a conforming client picks from MS-ASProtocolVersions, so only a
 * non-conforming one gets here — refusing it would lock such a device out); without a
 * requested version the device's remembered one, else the highest.
 */
export function negotiateVersion(requested: string | undefined, remembered: string | null | undefined): VersionNegotiation {
  const wanted = (requested ?? '').trim();
  if (wanted === '') return { version: remembered && isEasVersion(remembered) ? remembered : HIGHEST_EAS_VERSION, unannounced: '' };
  if (isEasVersion(wanted)) return { version: wanted, unannounced: '' };
  return { version: HIGHEST_EAS_VERSION, unannounced: wanted };
}

