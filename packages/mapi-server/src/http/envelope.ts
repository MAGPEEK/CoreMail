/**
 * The MAPI over HTTP envelope (MS-OXCMAPIHTTP 2.2.2–2.2.7), pure parts:
 * request headers and their validation, X-ResponseCode values, session
 * cookies, and the response body framing
 *   PROCESSING\r\n  [PENDING\r\n …]  DONE\r\n
 *   X-ResponseCode: n\r\n X-ElapsedTime: ms\r\n X-StartTime: <HTTP date>\r\n \r\n <body>
 */

export const ResponseCode = {
  Success: 0,
  UnknownFailure: 1,
  InvalidVerb: 2,
  InvalidPath: 3,
  InvalidHeader: 4,
  InvalidRequestType: 5,
  InvalidContextCookie: 6,
  MissingHeader: 7,
  AnonymousNotAllowed: 8,
  TooLarge: 9,
  ContextNotFound: 10,
  NoPrivilege: 11,
  InvalidRequestBody: 12,
  MissingCookie: 13,
  InvalidSequence: 15,
  EndpointDisabled: 16,
  InvalidResponse: 17,
  EndpointShuttingDown: 18,
} as const;

export type Endpoint = 'emsmdb' | 'nspi';

export const EMSMDB_REQUEST_TYPES = ['Connect', 'Execute', 'Disconnect', 'NotificationWait', 'PING'] as const;
export const NSPI_REQUEST_TYPES = [
  'Bind', 'Unbind', 'CompareMIds', 'DNToMId', 'GetMatches', 'GetPropList', 'GetProps', 'GetSpecialTable',
  'GetTemplateInfo', 'ModLinkAtt', 'ModProps', 'QueryColumns', 'QueryRows', 'ResolveNames', 'ResortRestriction',
  'SeekEntries', 'UpdateStat', 'GetMailboxUrl', 'GetAddressBookUrl', 'PING',
] as const;

export const MAPI_CONTENT_TYPE = 'application/mapi-http';
export const CONTEXT_COOKIE = 'MapiContext';
export const SEQUENCE_COOKIE = 'MapiSequence';
/**
 * The address book endpoint has session contexts of its own (Bind / Unbind):
 * own cookie names on its own path, so the two contexts never mix in a
 * client's cookie store.
 */
export const NSPI_CONTEXT_COOKIE = 'NspiContext';
export const NSPI_SEQUENCE_COOKIE = 'NspiSequence';
export const MAPI_COOKIE_PATH = '/mapi/';
export const NSPI_COOKIE_PATH = '/mapi/nspi';
/** Shown in X-ServerApplication; clients read the version from it (MS-OXCMAPIHTTP 2.2.3.3.7). */
export const SERVER_APPLICATION = 'Exchange/15.02.1544.004';

export interface MapiRequestHeaders {
  requestType: string;
  requestId: string;
  clientInfo: string;
  clientApplication: string;
  cookies: Record<string, string>;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name && !(name in out)) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

export function readMapiHeaders(get: (name: string) => string | undefined): MapiRequestHeaders {
  return {
    requestType: (get('x-requesttype') ?? '').trim(),
    requestId: (get('x-requestid') ?? '').trim(),
    clientInfo: (get('x-clientinfo') ?? '').trim(),
    clientApplication: (get('x-clientapplication') ?? '').trim(),
    cookies: parseCookies(get('cookie')),
  };
}

const KNOWN: Record<Endpoint, ReadonlySet<string>> = {
  emsmdb: new Set(EMSMDB_REQUEST_TYPES),
  nspi: new Set(NSPI_REQUEST_TYPES),
};

/** Header problem of a request (MS-OXCMAPIHTTP 2.2.2.1), or null when it is acceptable. */
export function validateRequest(endpoint: Endpoint, method: string, contentType: string | undefined, h: MapiRequestHeaders): number | null {
  if (method !== 'POST') return ResponseCode.InvalidVerb;
  if (!h.requestType || !h.requestId) return ResponseCode.MissingHeader;
  if (!KNOWN[endpoint].has(h.requestType)) return ResponseCode.InvalidRequestType;
  if (h.requestId.length > 256 || h.clientInfo.length > 256) return ResponseCode.InvalidHeader;
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (h.requestType !== 'PING' && type !== MAPI_CONTENT_TYPE) return ResponseCode.InvalidHeader;
  return null;
}

/** A cookie value we issued: base64url, 43 chars (32 random bytes). */
export function isCookieValue(v: string | undefined): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
}

export function setCookie(name: string, value: string, secure: boolean, path = MAPI_COOKIE_PATH): string {
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function clearCookie(name: string, secure: boolean, path = MAPI_COOKIE_PATH): string {
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export const META_PROCESSING = 'PROCESSING\r\n';
export const META_PENDING = 'PENDING\r\n';

/** DONE meta-tag, the additional headers and the response body. */
export function doneSection(responseCode: number, elapsedMs: number, startedAt: Date, body: Buffer): Buffer {
  const head = `DONE\r\nX-ResponseCode: ${responseCode}\r\nX-ElapsedTime: ${Math.max(0, Math.round(elapsedMs))}\r\n`
    + `X-StartTime: ${startedAt.toUTCString()}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, 'ascii'), body]);
}

/** The headers of every response (MS-OXCMAPIHTTP 2.2.2.2). */
export function responseHeaders(h: MapiRequestHeaders, responseCode: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': MAPI_CONTENT_TYPE,
    'Cache-Control': 'private',
    'X-RequestType': h.requestType,
    'X-RequestId': h.requestId,
    'X-ClientInfo': h.clientInfo,
    'X-ResponseCode': String(responseCode),
    'X-ServerApplication': SERVER_APPLICATION,
    ...extra,
  };
}
