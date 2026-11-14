/**
 * Login/password policy read from ServerSettings: maintenance mode and the
 * minimum password length.
 */
import { prisma } from '../prisma/index.js';

/** Roles that may log in while maintenance mode is on (UserRole has no 'ADMIN'). */
export const MAINTENANCE_EXEMPT_ROLES: readonly string[] = ['ORGANIZATION_MANAGEMENT', 'SERVER_MANAGEMENT'];

export const DEFAULT_MAINTENANCE_MESSAGE =
  'The server is currently under maintenance. Please try again later.';

/** Returns the maintenance message when a user with `role` is blocked, else null. */
export async function maintenanceBlock(role: string): Promise<string | null> {
  if (MAINTENANCE_EXEMPT_ROLES.includes(role)) return null;
  const s = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: { maintenanceMode: true, maintenanceMessage: true },
  });
  if (!s?.maintenanceMode) return null;
  return s.maintenanceMessage || DEFAULT_MAINTENANCE_MESSAGE;
}

export const PASSWORD_MAX_LENGTH = 128;

export async function getMinPasswordLength(): Promise<number> {
  const s = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: { minPasswordLength: true },
  });
  const n = s?.minPasswordLength ?? 8;
  return Number.isInteger(n) && n > 0 ? n : 8;
}

/** Returns an error message when the password violates the policy, else null. */
export async function checkPasswordPolicy(password: string): Promise<string | null> {
  const min = await getMinPasswordLength();
  if (password.length < min) return `Password must be at least ${min} characters long`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters long`;
  return null;
}
