/**
 * 9.4: personal settings of the signed-in user (mounted on /api/v1/user next to
 * routes/user.ts).
 *
 *   GET          /preferences   → { inactivityTimeoutMinutes, inactivityTimeoutMinutesGlobal, preferences }
 *   PUT | PATCH  /preferences   { inactivityTimeoutMinutes?, preferences?, migrateFromLocal? }
 *                               → same shape as GET (+ applied)
 *   GET          /signatures    → { signatures, defaults }
 *   POST         /signatures    { name, html }
 *   PUT          /signatures/:id { name?, html?, sortOrder? }
 *   DELETE       /signatures/:id
 *
 * `preferences` are validated against lib/user-preferences.ts; `migrateFromLocal`
 * imports the browser values once (ignored when preferences were written before).
 * The sessions list lives in the auth-service (/auth/sessions, 9.4: `current` +
 * revoke-others).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';
import { PreferencesPatchSchema } from '../lib/user-preferences.js';
import { loadPreferences, savePreferencesPatch } from '../lib/preferences-store.js';
import {
  MAX_SIGNATURES, MAX_SIGNATURE_HTML, countSignatures, createSignature, deleteSignature, listSignatures, mirrorLegacySignature, updateSignature,
} from '../lib/signatures.js';

export const userSettingsRouter: RouterType = Router();

// ── Preferences ──────────────────────────────────────────────────────────────

async function inactivityOf(userId: string): Promise<{ inactivityTimeoutMinutes: number | null; inactivityTimeoutMinutesGlobal: number }> {
  const [settings, global] = await Promise.all([
    prisma.userSettings.findUnique({ where: { userId }, select: { inactivityTimeoutMinutes: true } }),
    prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { inactivityTimeoutMinutes: true } }),
  ]);
  return {
    inactivityTimeoutMinutes: settings?.inactivityTimeoutMinutes ?? null,
    inactivityTimeoutMinutesGlobal: global?.inactivityTimeoutMinutes ?? 30,
  };
}

userSettingsRouter.get('/preferences', requireAuth, async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const [inactivity, preferences] = await Promise.all([inactivityOf(userId), loadPreferences(userId)]);
  res.json({ ...inactivity, preferences });
});

const PreferencesBodySchema = z.object({
  // null = use the global setting; 0 = off; 1–1440 = own value
  inactivityTimeoutMinutes: z.number().int().min(0).max(1440).nullable().optional(),
  preferences: PreferencesPatchSchema.optional(),
  migrateFromLocal: z.boolean().optional(),
}).strict();

async function savePreferences(req: Request, res: Response): Promise<void> {
  const parsed = PreferencesBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Ungültige Eingabe', details: parsed.error.issues });
    return;
  }
  const userId = req.apiUser!.userId;
  if (parsed.data.inactivityTimeoutMinutes !== undefined) {
    const inactivityTimeoutMinutes = parsed.data.inactivityTimeoutMinutes;
    await prisma.userSettings.upsert({
      where: { userId },
      create: { userId, inactivityTimeoutMinutes },
      update: { inactivityTimeoutMinutes },
    });
  }
  let applied = true;
  let preferences;
  if (parsed.data.preferences) {
    const saved = await savePreferencesPatch(userId, parsed.data.preferences, { onlyIfUnmigrated: parsed.data.migrateFromLocal === true });
    applied = saved.applied;
    preferences = saved.preferences;
    // pre-9.4 clients read the own default signature from the legacy column
    if (applied && parsed.data.preferences.signatures) await mirrorLegacySignature(userId);
  } else {
    preferences = await loadPreferences(userId);
  }
  res.json({ ok: true, applied, ...(await inactivityOf(userId)), preferences });
}

userSettingsRouter.put('/preferences', requireAuth, savePreferences);
userSettingsRouter.patch('/preferences', requireAuth, savePreferences);

// ── Signatures ───────────────────────────────────────────────────────────────

const SignatureSchema = z.object({
  name: z.string().trim().min(1).max(80),
  html: z.string().max(MAX_SIGNATURE_HTML),
}).strict();

const SignaturePatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  html: z.string().max(MAX_SIGNATURE_HTML).optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
}).strict();

userSettingsRouter.get('/signatures', requireAuth, async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const signatures = await listSignatures(userId);
  res.json({ signatures, defaults: (await loadPreferences(userId)).signatures.defaults });
});

userSettingsRouter.post('/signatures', requireAuth, async (req: Request, res: Response) => {
  const parsed = SignatureSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Ungültige Signatur', details: parsed.error.issues }); return; }
  const userId = req.apiUser!.userId;
  await listSignatures(userId); // imports the pre-9.4 signature first
  if (await countSignatures(userId) >= MAX_SIGNATURES) {
    res.status(409).json({ error: `Höchstens ${MAX_SIGNATURES} Signaturen`, code: 'SIGNATURE_LIMIT' });
    return;
  }
  res.status(201).json(await createSignature(userId, parsed.data.name, parsed.data.html));
});

userSettingsRouter.put('/signatures/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = SignaturePatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Ungültige Signatur', details: parsed.error.issues }); return; }
  const { id } = req.params as { id: string };
  const data = {
    ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
    ...(parsed.data.html !== undefined ? { html: parsed.data.html } : {}),
    ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {}),
  };
  const updated = await updateSignature(req.apiUser!.userId, id, data);
  if (!updated) { res.status(404).json({ error: 'Signatur nicht gefunden' }); return; }
  res.json(updated);
});

userSettingsRouter.delete('/signatures/:id', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  if (!(await deleteSignature(req.apiUser!.userId, id))) { res.status(404).json({ error: 'Signatur nicht gefunden' }); return; }
  res.json({ ok: true });
});
