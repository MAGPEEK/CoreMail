/**
 * BCP quarantine release — re-injects a quarantined raw message for its
 * original envelope recipients.
 *
 * One BullMQ job on 'smtp-outbound' (rawMessage path) carries all recipients;
 * the smtp-server worker splits them: local recipients → storeInboundMessage()
 * (alias expansion included), external ones → MX/smarthost relay. The job's
 * `quarantineReleaseId` makes the worker store with `quarantineRelease`, so a
 * transport-rule quarantine does not fire again; the worker never runs the
 * content filter (ClamAV/rspamd) that caused the original quarantine.
 *
 * Idempotent: the record is claimed with a conditional update
 * (`released=false → true`), a second (or concurrent) release gets 409.
 */
import crypto from 'node:crypto';
import {
  QUARANTINE_RELEASE_HEADER, VIRUS_SCAN_HEADER, RULE_FORWARDED_HEADER, internalHeadersExcept, prependHeader, quarantineEnvelope, stripHeaders,
} from '@coremail/storage';

export interface QuarantineRow {
  id:       string;
  fromAddr: string;
  toAddr:   string;
  subject:  string;
  reason:   string;
  details:  unknown;
  rawPath:  string;
  released: boolean;
}

export interface ReleaseJob {
  messageId:           string;
  from:                string;
  to:                  string[];
  rawMessage:          string;
  quarantineReleaseId: string;
}

export interface ReleaseDeps {
  findById:  (id: string) => Promise<QuarantineRow | null>;
  /** Conditional claim: sets released fields only where released=false; returns affected rows. */
  claim:     (id: string, releasedBy: string, at: Date) => Promise<number>;
  unclaim:   (id: string) => Promise<void>;
  download:  (path: string) => Promise<Buffer>;
  enqueue:   (job: ReleaseJob) => Promise<string>;
  isLocalAddress: (addr: string) => Promise<boolean>;
}

export class ReleaseError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export interface ReleaseResult {
  id:         string;
  jobId:      string;
  from:       string;
  recipients: string[];
  local:      string[];
  external:   string[];
}

export async function releaseQuarantine(id: string, actorId: string, deps: ReleaseDeps): Promise<ReleaseResult> {
  const item = await deps.findById(id);
  if (!item) throw new ReleaseError(404, 'Not found');
  if (item.released) throw new ReleaseError(409, 'Already released');
  // The BCP never offers a release for virus findings; the API enforces it too.
  if (item.reason === 'VIRUS') {
    throw new ReleaseError(409, 'Virus-infected messages cannot be released');
  }

  const envelope = quarantineEnvelope(item);
  if (envelope.recipients.length === 0) throw new ReleaseError(422, 'Quarantine item has no recipients');

  let raw: Buffer;
  try {
    raw = await deps.download(item.rawPath);
  } catch {
    throw new ReleaseError(502, 'Raw message not available in object storage');
  }

  // Claim first (idempotency / concurrent clicks), then enqueue.
  const claimed = await deps.claim(id, actorId, new Date());
  if (claimed === 0) throw new ReleaseError(409, 'Already released');

  // Trace header: replace anything stored with ours (never trusted, informational).
  // The X-CoreMail-Virus-Scan verdict stays: smtp-server strips sender copies on
  // receipt, so the stored one is ours (e.g. "infected" with clamavAction=pass
  // on a transport-rule quarantine) and must survive the release — like a
  // genuine rule-forward loop header (forged copies never get past ingress).
  const released = prependHeader(
    stripHeaders(raw, internalHeadersExcept([VIRUS_SCAN_HEADER, RULE_FORWARDED_HEADER])),
    QUARANTINE_RELEASE_HEADER, id,
  );

  let jobId: string;
  try {
    jobId = await deps.enqueue({
      messageId:           `quarantine-release-${id}-${crypto.randomUUID()}`,
      from:                envelope.from,
      to:                  envelope.recipients,
      rawMessage:          released.toString('base64'),
      quarantineReleaseId: id,
    });
  } catch {
    await deps.unclaim(id).catch(() => undefined);
    throw new ReleaseError(503, 'Outbound queue unavailable — release rolled back');
  }

  const local: string[] = [];
  const external: string[] = [];
  for (const r of envelope.recipients) {
    if (await deps.isLocalAddress(r).catch(() => false)) local.push(r);
    else external.push(r);
  }

  return { id, jobId, from: envelope.from, recipients: envelope.recipients, local, external };
}
