/**
 * Session resource (RFC 8620 §2) incl. capability objects of the extensions.
 */
import type { AccountContext, JmapUser, JsonObject } from './types.js';
import { hashState } from './state.js';
import { LIMITS } from './settings.js';
import {
  CAP_BLOB, CAP_CORE, CAP_MAIL, CAP_PRINCIPALS, CAP_PRINCIPALS_OWNER, CAP_QUOTA,
  CAP_SUBMISSION, CAP_VACATION, CAP_VAPID, CAP_WEBSOCKET, VAPID_PUBLIC_KEY,
} from './capabilities.js';

export function sessionStateFor(accounts: Map<string, AccountContext>): string {
  return hashState([...accounts.values()].map((a) => [a.accountId, a.name, a.readOnly, a.maySend]));
}

export function buildSession(user: JmapUser, accounts: Map<string, AccountContext>, baseUrl: string): JsonObject {
  const wsBase = baseUrl.replace(/^http/, 'ws');
  const accountObjs: JsonObject = {};
  for (const a of accounts.values()) {
    const caps: JsonObject = {
      [CAP_MAIL]: {
        maxMailboxesPerEmail: 1,
        maxMailboxDepth: null,
        maxSizeMailboxName: 100,
        maxSizeAttachmentsPerEmail: LIMITS.maxSizeAttachmentsPerEmail,
        emailQuerySortOptions: ['receivedAt', 'sentAt', 'size', 'subject', 'from', 'hasKeyword'],
        mayCreateTopLevelMailbox: !a.readOnly,
      },
      [CAP_QUOTA]: {},
      [CAP_BLOB]: {
        maxSizeBlobSet: LIMITS.maxSizeUpload,
        maxDataSources: 64,
        supportedTypeNames: ['Email', 'Mailbox', 'Thread'],
        supportedDigestAlgorithms: ['sha', 'sha-256'],
      },
      [CAP_PRINCIPALS_OWNER]: {
        accountIdForPrincipal: user.userId,
        principalId: a.sharedMailboxId ? `shared-${a.sharedMailboxId}` : (a.ownerUserId ?? a.accountId),
      },
    };
    if (a.maySend) {
      caps[CAP_SUBMISSION] = { maxDelayedSend: 30 * 24 * 3600, submissionExtensions: {} };
    }
    if (a.isPersonal) {
      caps[CAP_VACATION] = {};
    }
    accountObjs[a.accountId] = {
      name: a.name,
      isPersonal: a.isPersonal,
      isReadOnly: a.readOnly,
      accountCapabilities: caps,
    };
  }

  const primary: JsonObject = {};
  const own = accounts.get(user.userId);
  if (own) {
    for (const c of [CAP_MAIL, CAP_SUBMISSION, CAP_VACATION, CAP_QUOTA, CAP_BLOB]) primary[c] = own.accountId;
  }
  // Principals account: RFC 9670 — own account serves as the principal directory
  if (own) primary[CAP_PRINCIPALS] = own.accountId;

  const capabilities: JsonObject = {
    [CAP_CORE]: {
      maxSizeUpload: LIMITS.maxSizeUpload,
      maxConcurrentUpload: LIMITS.maxConcurrentUpload,
      maxSizeRequest: LIMITS.maxSizeRequest,
      maxConcurrentRequests: LIMITS.maxConcurrentRequests,
      maxCallsInRequest: LIMITS.maxCallsInRequest,
      maxObjectsInGet: LIMITS.maxObjectsInGet,
      maxObjectsInSet: LIMITS.maxObjectsInSet,
      collationAlgorithms: ['i;ascii-numeric', 'i;ascii-casemap', 'i;unicode-casemap'],
    },
    [CAP_MAIL]: {},
    [CAP_SUBMISSION]: {},
    [CAP_VACATION]: {},
    [CAP_QUOTA]: {},
    [CAP_BLOB]: {},
    [CAP_PRINCIPALS]: {},
    [CAP_WEBSOCKET]: { url: `${wsBase}/jmap/ws`, supportsPush: true },
  };
  if (VAPID_PUBLIC_KEY) {
    capabilities[CAP_VAPID] = { applicationServerKey: VAPID_PUBLIC_KEY };
  }

  return {
    capabilities,
    accounts: accountObjs,
    primaryAccounts: primary,
    username: user.email,
    apiUrl: `${baseUrl}/jmap/api`,
    downloadUrl: `${baseUrl}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
    uploadUrl: `${baseUrl}/jmap/upload/{accountId}/`,
    eventSourceUrl: `${baseUrl}/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
    state: sessionStateFor(accounts),
  };
}
