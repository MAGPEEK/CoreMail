import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';

const log = createLogger('auth:totp');

function decryptSecret(encrypted: string): string {
  // In production: decrypt with AES-256 from Vault
  // Here: base64 decode as placeholder for the actual AES-256-GCM decryption
  return Buffer.from(encrypted, 'base64').toString('utf8');
}

function encryptSecret(secret: string): string {
  return Buffer.from(secret).toString('base64');
}

export async function setupTotp(
  userId: string,
  issuer: string,
  accountName: string,
): Promise<{ secret: string; otpauthUrl: string; qrCodeDataUrl: string }> {
  const totp = new OTPAuth.TOTP({
    issuer,
    label: accountName,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  });

  const secret = totp.secret.base32;
  const otpauthUrl = totp.toString();
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

  
  await prisma.userMfa.upsert({
    where: { userId },
    create: { userId, totpSecret: encryptSecret(secret), totpEnabled: false },
    update: { totpSecret: encryptSecret(secret), totpEnabled: false },
  });

  log.info({ userId }, 'TOTP secret generated (not yet confirmed)');
  return { secret, otpauthUrl, qrCodeDataUrl };
}

export async function confirmTotp(userId: string, code: string): Promise<boolean> {
  
  const mfa = await prisma.userMfa.findUnique({ where: { userId } });
  if (!mfa?.totpSecret) return false;

  const secret = decryptSecret(mfa.totpSecret);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) return false;

  await prisma.userMfa.update({
    where: { userId },
    data: { totpEnabled: true },
  });
  log.info({ userId }, 'TOTP confirmed and enabled');
  return true;
}

export async function verifyTotp(userId: string, code: string): Promise<boolean> {
  
  const mfa = await prisma.userMfa.findUnique({ where: { userId } });
  if (!mfa?.totpSecret || !mfa.totpEnabled) return false;

  const secret = decryptSecret(mfa.totpSecret);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}

export async function disableTotp(userId: string): Promise<void> {
  
  await prisma.userMfa.update({
    where: { userId },
    data: { totpSecret: null, totpEnabled: false },
  });
}
