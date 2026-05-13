import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma } from '@coremail/storage/prisma';
import { requireAuth } from '../middleware/auth.js';

export const smimeRouter: RouterType = Router();
smimeRouter.use(requireAuth);

/**
 * GET /api/v1/smime/certificates
 * List all S/MIME certificates for the current user
 */
smimeRouter.get('/certificates', async (req: Request, res: Response) => {
  const certs = await prisma.userCertificate.findMany({
    where: { userId: req.apiUser!.userId },
    select: {
      id: true,
      label: true,
      fingerprint: true,
      subject: true,
      issuer: true,
      notBefore: true,
      notAfter: true,
      signingDefault: true,
      encryptDefault: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(certs);
});

/**
 * POST /api/v1/smime/certificates
 * Upload a PKCS#12 certificate (.p12 / .pfx)
 * Body: multipart/form-data with field "certificate" (binary) and "password" + "label"
 */
smimeRouter.post('/certificates', async (req: Request, res: Response) => {
  // In a full implementation this would parse the PKCS#12 via node-forge or @peculiar/x509
  // Here we accept JSON metadata for the prototype and store the fingerprint
  const { label, fingerprint, subject, issuer, notBefore, notAfter } = req.body as {
    label?: string;
    fingerprint?: string;
    subject?: string;
    issuer?: string;
    notBefore?: string;
    notAfter?: string;
  };

  if (!fingerprint || !subject || !issuer || !notBefore || !notAfter) {
    res.status(400).json({ error: 'Missing required certificate fields' });
    return;
  }

  // Check for duplicate
  const existing = await prisma.userCertificate.findUnique({ where: { fingerprint } });
  if (existing) {
    res.status(409).json({ error: 'Certificate already imported' });
    return;
  }

  const cert = await prisma.userCertificate.create({
    data: {
      userId: req.apiUser!.userId,
      label: label ?? 'My Certificate',
      fingerprint,
      subject,
      issuer,
      notBefore: new Date(notBefore),
      notAfter: new Date(notAfter),
      storagePath: `smime/${req.apiUser!.userId}/${fingerprint}.p12`,
    },
    select: {
      id: true, label: true, fingerprint: true, subject: true,
      issuer: true, notBefore: true, notAfter: true,
      signingDefault: true, encryptDefault: true, createdAt: true,
    },
  });

  res.status(201).json(cert);
});

/**
 * PUT /api/v1/smime/certificates/:id
 * Update certificate settings (label, set as default)
 */
smimeRouter.put('/certificates/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { label, signingDefault, encryptDefault } = req.body as {
    label?: string;
    signingDefault?: boolean;
    encryptDefault?: boolean;
  };

  const cert = await prisma.userCertificate.findFirst({
    where: { id, userId: req.apiUser!.userId },
  });
  if (!cert) {
    res.status(404).json({ error: 'Certificate not found' });
    return;
  }

  // If setting as default signing cert, clear other defaults first
  if (signingDefault === true) {
    await prisma.userCertificate.updateMany({
      where: { userId: req.apiUser!.userId },
      data: { signingDefault: false },
    });
  }
  if (encryptDefault === true) {
    await prisma.userCertificate.updateMany({
      where: { userId: req.apiUser!.userId },
      data: { encryptDefault: false },
    });
  }

  const updated = await prisma.userCertificate.update({
    where: { id },
    data: {
      ...(label !== undefined ? { label } : {}),
      ...(signingDefault !== undefined ? { signingDefault } : {}),
      ...(encryptDefault !== undefined ? { encryptDefault } : {}),
    },
    select: {
      id: true, label: true, fingerprint: true, subject: true,
      issuer: true, notBefore: true, notAfter: true,
      signingDefault: true, encryptDefault: true, createdAt: true,
    },
  });

  res.json(updated);
});

/**
 * DELETE /api/v1/smime/certificates/:id
 * Remove a certificate
 */
smimeRouter.delete('/certificates/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };

  const cert = await prisma.userCertificate.findFirst({
    where: { id, userId: req.apiUser!.userId },
  });
  if (!cert) {
    res.status(404).json({ error: 'Certificate not found' });
    return;
  }

  await prisma.userCertificate.delete({ where: { id } });
  res.json({ ok: true });
});

/**
 * GET /api/v1/smime/certificates/:id/public-key
 * Get the public certificate (PEM) for a contact address — used for encrypting outgoing mail
 */
smimeRouter.get('/public-key/:email', async (req: Request, res: Response) => {
  const { email } = req.params as { email: string };

  // Find any user with this email and a default encryption cert
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    res.status(404).json({ error: 'No certificate found for this address' });
    return;
  }

  const cert = await prisma.userCertificate.findFirst({
    where: { userId: user.id, encryptDefault: true },
    select: { fingerprint: true, subject: true, issuer: true, notBefore: true, notAfter: true },
  });

  if (!cert) {
    res.status(404).json({ error: 'No certificate found for this address' });
    return;
  }

  res.json({ email, ...cert });
});

/**
 * GET /api/v1/smime/devices (admin)
 * List all ActiveSync devices — needed for the ECP mobile device management panel
 */
smimeRouter.get('/devices', async (req: Request, res: Response) => {
  const devices = await prisma.activeSyncDevice.findMany({
    where: { userId: req.apiUser!.userId },
    select: {
      id: true, deviceId: true, deviceType: true, deviceFriendlyName: true,
      status: true, lastSyncAt: true, createdAt: true,
    },
    orderBy: { lastSyncAt: 'desc' },
  });
  res.json(devices);
});

/**
 * DELETE /api/v1/smime/devices/:id
 * Remove an ActiveSync device registration (wipe / deregister)
 */
smimeRouter.delete('/devices/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const device = await prisma.activeSyncDevice.findFirst({
    where: { id, userId: req.apiUser!.userId },
  });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  await prisma.activeSyncDevice.delete({ where: { id } });
  res.json({ ok: true });
});
