/**
 * Maximum message size for JMAP writes that create or send a message (9.4):
 * EmailSubmission/set create, Email/import and Email/set create use the shared storage
 * limit (the same one as REST /mail/send and ActiveSync SendMail).
 */
import { checkOutgoingMessageSize } from '@coremail/storage';
import { setError, type SetError } from '../errors.js';

/** RFC 8621 §7.5 SetError `tooLarge` with the `maxSize` property (octets). */
export function messageTooLarge(limit: number): SetError {
  return { ...setError('tooLarge', `the message exceeds the maximum size of ${limit} octets`), maxSize: limit };
}

/** Throws SetError tooLarge when `size` exceeds the configured maximum message size. */
export async function assertMessageSize(size: number): Promise<void> {
  const check = await checkOutgoingMessageSize(size);
  if (!check.ok) throw messageTooLarge(check.limit);
}
