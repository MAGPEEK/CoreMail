/** Shared helpers of the backup runs (moved out of scheduler/index.ts in 9.3). */
import { createLogger } from '@coremail/core';

const log = createLogger('backup:scheduler');

/** Result of one backup run (full / mailbox / system), resolved when the job ended. */
export interface JobOutcome {
  jobId: string;
  status: 'COMPLETED' | 'FAILED';
  /** Mailboxes (full backup) or 1. */
  total: number;
  /** Failed mailboxes (full backup) or 0/1. */
  failed: number;
  errorMsg: string | null;
}

/** Runs the job body after the response (setImmediate); never rejects. */
export function runInBackground(work: () => Promise<JobOutcome>, jobId: string): Promise<JobOutcome> {
  return new Promise<JobOutcome>((resolve) => {
    setImmediate(() => {
      work()
        .then(resolve)
        .catch((err: unknown) => {
          log.error({ err, jobId }, 'Backup job crashed');
          resolve({ jobId, status: 'FAILED', total: 1, failed: 1, errorMsg: err instanceof Error ? err.message : String(err) });
        });
    });
  });
}

/**
 * Classifies errors by typical backup failure modes for RTO reporting.
 */
export function classifyError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('econn') || msg.includes('etimedout') || msg.includes('network')) return 'NETWORK';
  if (msg.includes('nosuchbucket') || msg.includes('s3') || msg.includes('storage') || msg.includes('enospc')) return 'STORAGE';
  if (msg.includes('access denied') || msg.includes('permission') || msg.includes('eacces')) return 'PERMISSION';
  if (msg.includes('parse') || msg.includes('corrupt') || msg.includes('invalid')) return 'CORRUPT';
  return 'UNKNOWN';
}
