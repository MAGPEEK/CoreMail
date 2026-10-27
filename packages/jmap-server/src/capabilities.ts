/** Capability-URNs der implementierten RFCs. */
export const CAP_CORE = 'urn:ietf:params:jmap:core';                     // RFC 8620
export const CAP_MAIL = 'urn:ietf:params:jmap:mail';                     // RFC 8621
export const CAP_SUBMISSION = 'urn:ietf:params:jmap:submission';         // RFC 8621
export const CAP_VACATION = 'urn:ietf:params:jmap:vacationresponse';     // RFC 8621
export const CAP_WEBSOCKET = 'urn:ietf:params:jmap:websocket';           // RFC 8887
export const CAP_BLOB = 'urn:ietf:params:jmap:blob';                     // RFC 9404
export const CAP_QUOTA = 'urn:ietf:params:jmap:quota';                   // RFC 9425
export const CAP_PRINCIPALS = 'urn:ietf:params:jmap:principals';         // RFC 9670
export const CAP_PRINCIPALS_OWNER = 'urn:ietf:params:jmap:principals:owner'; // RFC 9670
export const CAP_VAPID = 'urn:ietf:params:jmap:webpush-vapid';           // RFC 9749

export const ALL_CAPABILITIES = [
  CAP_CORE, CAP_MAIL, CAP_SUBMISSION, CAP_VACATION, CAP_WEBSOCKET, CAP_BLOB, CAP_QUOTA, CAP_PRINCIPALS, CAP_VAPID,
];

export const VAPID_PUBLIC_KEY = process.env['VAPID_PUBLIC_KEY'] ?? '';
