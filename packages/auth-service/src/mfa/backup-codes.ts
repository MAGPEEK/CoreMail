/**
 * v7.0.0: backup codes live in @coremail/storage/auth (single source of truth
 * for generation, normalisation and atomic single-use consumption).
 */
export {
  regenerateBackupCodes as generateBackupCodes,
  consumeBackupCode as verifyBackupCode,
  normalizeBackupCode,
} from '@coremail/storage/auth';
