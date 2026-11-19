/**
 * Admin API: branding (9.3) — /api/v1/admin/branding
 *
 *   GET    /                     branding object (same shape as GET /api/v1/branding)
 *   PUT    /                     partial update: productName, primaryColor, headerColor,
 *                                allowUserAccent, showPoweredBy, loginText, footerLinks,
 *                                defaultBackground (10.1: none | builtin:<id>)
 *                                → object + `warnings` (colours below 3:1 are saved but flagged)
 *   POST   /assets/:slot         raw image body (Content-Type image/png | image/webp |
 *                                image/svg+xml, loginBackground also image/jpeg) → object
 *   DELETE /assets/:slot         remove the asset → object
 *   POST   /reset                back to the defaults (assets removed) → object
 *   (every answer also carries `defaults` and `explicit`, see below)
 *
 * The admin answers (GET, PUT, assets, reset) add two admin-only fields to the
 * public shape: `defaults` {productName, primaryColor} — the BRANDING_NAME /
 * BRANDING_COLOR environment defaults — and `explicit` {productName,
 * primaryColor, headerColor} — true when the value is stored in the database
 * (false = the default applies and follows the environment). The public
 * GET /api/v1/branding is unchanged.
 * Asset changes (upload, delete, reset) run under withBrandingAssetLock()
 * (lib/branding/asset-lock.ts) so the cleanup of unreferenced objects never
 * deletes an object a concurrent change has just referenced; a lock held
 * elsewhere for too long → 409 {error, code: 'BUSY'}.
 *
 * Area `organisation` (lib/rbac.ts): write = ORGANIZATION_MANAGEMENT only, read
 * (GET) = SERVER_MANAGEMENT and VIEW_ONLY_ORG as for the rest of the organisation
 * settings. Every change is audited as `settings.branding.update`, increments
 * `version` and publishes CHANNEL_SETTINGS_RELOAD `{type:'branding'}`.
 * Errors: 400 `{error, field}` (fields) / `{error, code}` (assets: TYPE, SIZE,
 * DIMENSIONS, SVG_UNSAFE).
 */
import { createHash } from 'node:crypto';
import express, { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express';
import {
  prisma, getObjectStore, loadBrandingRow, toPublicBranding, brandingDefaults,
  normalizeProductName, normalizeHexColor, normalizeLoginText, normalizeFooterLinks, normalizeDefaultBackground,
  BRANDING_ASSET_SLOTS, BRANDING_KEY_PREFIX,
  type BrandingAssetSlot, type BrandingRow, type BrandingFooterLink, type PublicBranding, type BrandingDefaults, type DefaultBackground,
} from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireArea } from '../../middleware/auth.js';
import { audit, auditContext } from '../../lib/audit.js';
import { colorWarning, type ColorWarning } from '../../lib/branding/color.js';
import { validateAsset, AssetError, MAX_ASSET_BYTES, SLOT_RULES } from '../../lib/branding/image.js';
import { publishBrandingReload, setCurrentBranding } from '../../lib/branding/state.js';
import { withBrandingAssetLock, BrandingBusyError } from '../../lib/branding/asset-lock.js';
import { brandingAssetCache } from '../../lib/branding/asset-cache.js';

const log = createLogger('admin:branding');
export const adminBrandingRouter: RouterType = Router();
adminBrandingRouter.use(requireArea('organisation'));

type FullRow = BrandingRow & Record<`${BrandingAssetSlot}Type`, string | null>;
const KEY_FIELD = (slot: BrandingAssetSlot) => `${slot}Key` as const;
const TYPE_FIELD = (slot: BrandingAssetSlot) => `${slot}Type` as const;

const PUT_FIELDS = ['productName', 'primaryColor', 'headerColor', 'allowUserAccent', 'showPoweredBy', 'loginText', 'footerLinks', 'defaultBackground'] as const;

function isSlot(v: string): v is BrandingAssetSlot {
  return (BRANDING_ASSET_SLOTS as readonly string[]).includes(v);
}

/** Upsert the singleton; every write increments `version` (a new row starts at 1). */
/** Columns a write may set (Json columns as plain values). */
type BrandingWrite = Partial<Record<keyof FullRow, unknown>>;

async function writeBranding(data: BrandingWrite): Promise<FullRow> {
  const row = await prisma.branding.upsert({
    where: { id: 'singleton' },
    create: { ...data, id: 'singleton' } as never,
    update: { ...data, version: { increment: 1 } } as never,
  });
  return row as unknown as FullRow;
}

function referencedKeys(row: Partial<BrandingRow> | null): Set<string> {
  const s = new Set<string>();
  if (!row) return s;
  for (const slot of BRANDING_ASSET_SLOTS) {
    const k = row[KEY_FIELD(slot)];
    if (k) s.add(k);
  }
  return s;
}

/** Deletes asset objects that the new row no longer references (best effort). */
async function deleteUnreferenced(oldKeys: Iterable<string>, row: Partial<BrandingRow> | null): Promise<void> {
  const keep = referencedKeys(row);
  for (const key of new Set(oldKeys)) {
    if (keep.has(key) || !key.startsWith(BRANDING_KEY_PREFIX)) continue;
    await getObjectStore().delete(key).catch((err: unknown) => log.warn({ err, key }, 'Old branding asset not deleted'));
    brandingAssetCache.delete(key.slice(BRANDING_KEY_PREFIX.length));
  }
}

/** Admin answer: the public shape + `defaults` + `explicit` (see the header). */
export interface AdminBranding extends PublicBranding {
  defaults: BrandingDefaults;
  explicit: { productName: boolean; primaryColor: boolean; headerColor: boolean };
}

export function adminView(pub: PublicBranding, row: Partial<BrandingRow> | null): AdminBranding {
  return {
    ...pub,
    defaults: brandingDefaults(),
    explicit: {
      productName: normalizeProductName(row?.productName) !== null,
      primaryColor: normalizeHexColor(row?.primaryColor) !== null,
      headerColor: normalizeHexColor(row?.headerColor) !== null,
    },
  };
}

/** Runs an asset change under the asset lock; a busy lock → 409 BUSY. */
async function underAssetLock(res: Response, fn: () => Promise<void>): Promise<void> {
  try {
    await withBrandingAssetLock(fn);
  } catch (err) {
    if (err instanceof BrandingBusyError) { res.status(409).json({ error: err.message, code: err.code }); return; }
    throw err;
  }
}

function afterChange(req: Request, row: FullRow, changes: Record<string, unknown>): PublicBranding {
  const pub = toPublicBranding(row);
  setCurrentBranding(pub);
  publishBrandingReload();
  audit({
    ...(req.apiUser?.userId !== undefined ? { actorId: req.apiUser.userId } : {}),
    ...(req.apiUser?.email !== undefined ? { actorEmail: req.apiUser.email } : {}),
    action: 'settings.branding.update',
    targetType: 'settings',
    targetId: 'branding',
    changes: { ...changes, version: row.version },
    ...auditContext(req),
  });
  return pub;
}

// ── GET / ─────────────────────────────────────────────────────────────────────
adminBrandingRouter.get('/', async (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  const row = await loadBrandingRow();
  res.json(adminView(toPublicBranding(row), row));
});

// ── PUT / ─────────────────────────────────────────────────────────────────────

type PutData = {
  productName?: string | null; primaryColor?: string | null; headerColor?: string | null;
  allowUserAccent?: boolean; showPoweredBy?: boolean; loginText?: string; footerLinks?: BrandingFooterLink[];
  defaultBackground?: DefaultBackground;
};

/** Validates a PUT body → data, or `{ error, field }`. Exported for tests. */
export function parseBrandingPut(body: unknown): { data: PutData } | { error: string; field: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Body must be a JSON object', field: 'body' };
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).find((k) => !(PUT_FIELDS as readonly string[]).includes(k));
  if (unknown) return { error: `Unknown field ${unknown}`, field: unknown };
  const data: PutData = {};
  if ('productName' in b) {
    if (b['productName'] === null) data.productName = null;
    else {
      const v = normalizeProductName(b['productName']);
      if (!v) return { error: 'productName must be 1–40 characters without control characters', field: 'productName' };
      data.productName = v;
    }
  }
  for (const f of ['primaryColor', 'headerColor'] as const) {
    if (!(f in b)) continue;
    if (b[f] === null) { data[f] = null; continue; }
    const v = normalizeHexColor(b[f]);
    if (!v) return { error: `${f} must be a #rrggbb colour or null`, field: f };
    data[f] = v;
  }
  for (const f of ['allowUserAccent', 'showPoweredBy'] as const) {
    if (!(f in b)) continue;
    if (typeof b[f] !== 'boolean') return { error: `${f} must be true or false`, field: f };
    data[f] = b[f] as boolean;
  }
  if ('loginText' in b) {
    const v = b['loginText'] === null ? '' : normalizeLoginText(b['loginText']);
    if (v === null) return { error: 'loginText must be plain text of at most 280 characters', field: 'loginText' };
    data.loginText = v;
  }
  if ('footerLinks' in b) {
    const v = normalizeFooterLinks(b['footerLinks'] ?? []);
    if (!Array.isArray(v)) return { error: v.error, field: 'footerLinks' };
    data.footerLinks = v;
  }
  if ('defaultBackground' in b) {
    const v = normalizeDefaultBackground(b['defaultBackground'] ?? 'none');
    if (!v) return { error: 'defaultBackground must be none or builtin:<id> of a built-in background', field: 'defaultBackground' };
    data.defaultBackground = v;
  }
  return { data };
}

adminBrandingRouter.put('/', async (req: Request, res: Response) => {
  const parsed = parseBrandingPut(req.body);
  if ('error' in parsed) { res.status(400).json(parsed); return; }
  const d = parsed.data;
  const before = await loadBrandingRow();
  const row = await writeBranding({
    ...(d.productName !== undefined ? { productName: d.productName } : {}),
    ...(d.primaryColor !== undefined ? { primaryColor: d.primaryColor } : {}),
    ...(d.headerColor !== undefined ? { headerColor: d.headerColor } : {}),
    ...(d.allowUserAccent !== undefined ? { allowUserAccent: d.allowUserAccent } : {}),
    ...(d.showPoweredBy !== undefined ? { showPoweredBy: d.showPoweredBy } : {}),
    ...(d.loginText !== undefined ? { loginText: d.loginText } : {}),
    ...(d.footerLinks !== undefined ? { footerLinks: d.footerLinks } : {}),
    ...(d.defaultBackground !== undefined ? { defaultBackground: d.defaultBackground } : {}),
  });
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(d)) {
    const prev = before ? (before as unknown as Record<string, unknown>)[k] : undefined;
    if (JSON.stringify(prev ?? null) !== JSON.stringify(v ?? null)) changes[k] = { from: prev ?? null, to: v ?? null };
  }
  const pub = afterChange(req, row, changes);
  const warnings: ColorWarning[] = [];
  for (const f of ['primaryColor', 'headerColor'] as const) {
    const v = d[f];
    if (v) { const w = colorWarning(f, v); if (w) warnings.push(w); }
  }
  log.info({ fields: Object.keys(d), version: row.version }, 'Branding updated');
  res.json({ ...adminView(pub, row), warnings });
});

// ── Assets ────────────────────────────────────────────────────────────────────

const rawBody = express.raw({ type: () => true, limit: MAX_ASSET_BYTES + 1 });

/** Raw body parser that answers an oversized upload with 400 SIZE (contract) instead of 413. */
function assetBody(req: Request, res: Response, next: NextFunction): void {
  rawBody(req, res, (err?: unknown) => {
    if (!err) { next(); return; }
    const type = (err as { type?: string }).type;
    if (type === 'entity.too.large') { res.status(400).json({ error: 'Upload too large', code: 'SIZE' }); return; }
    if (type === 'request.aborted') { res.status(400).json({ error: 'Upload aborted', code: 'SIZE' }); return; }
    next(err);
  });
}

function slotOr400(req: Request, res: Response): BrandingAssetSlot | null {
  const slot = req.params['slot'] ?? '';
  if (isSlot(slot)) return slot;
  res.status(400).json({ error: `Unknown slot (use ${BRANDING_ASSET_SLOTS.join(', ')})`, code: 'TYPE', field: 'slot' });
  return null;
}

adminBrandingRouter.post('/assets/:slot', (req: Request, res: Response, next: NextFunction) => {
  // Reject an unknown slot / oversized declared length before reading the body.
  const slot = slotOr400(req, res);
  if (!slot) return;
  const declared = Number(req.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > SLOT_RULES[slot].maxBytes) {
    res.status(400).json({ error: `${slot} may be at most ${Math.round(SLOT_RULES[slot].maxBytes / 1024)} KB`, code: 'SIZE' });
    return;
  }
  next();
}, assetBody, async (req: Request, res: Response) => {
  const slot = req.params['slot'] as BrandingAssetSlot;
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  let asset;
  try {
    asset = validateAsset(slot, req.get('content-type'), body);
  } catch (err) {
    if (err instanceof AssetError) { res.status(400).json({ error: err.message, code: err.code }); return; }
    throw err;
  }
  const sha = createHash('sha256').update(asset.data).digest('hex');
  const key = `${BRANDING_KEY_PREFIX}${sha}.${asset.ext}`;
  const valid = asset;
  await underAssetLock(res, async () => {
    await getObjectStore().put(key, valid.data, { contentType: valid.contentType });
    const before = await loadBrandingRow();
    const oldKey = before?.[KEY_FIELD(slot)] ?? null;
    const row = await writeBranding({ [KEY_FIELD(slot)]: key, [TYPE_FIELD(slot)]: valid.contentType });
    if (oldKey && oldKey !== key) await deleteUnreferenced([oldKey], row);
    const pub = afterChange(req, row, { [slot]: { from: oldKey, to: key, contentType: valid.contentType, bytes: valid.data.length } });
    log.info({ slot, key, bytes: valid.data.length }, 'Branding asset uploaded');
    res.json(adminView(pub, row));
  });
});

adminBrandingRouter.delete('/assets/:slot', async (req: Request, res: Response) => {
  const slot = slotOr400(req, res);
  if (!slot) return;
  await underAssetLock(res, async () => {
    const before = await loadBrandingRow();
    const oldKey = before?.[KEY_FIELD(slot)] ?? null;
    const row = await writeBranding({ [KEY_FIELD(slot)]: null, [TYPE_FIELD(slot)]: null });
    if (oldKey) await deleteUnreferenced([oldKey], row);
    res.json(adminView(afterChange(req, row, { [slot]: { from: oldKey, to: null } }), row));
  });
});

// ── POST /reset ───────────────────────────────────────────────────────────────
adminBrandingRouter.post('/reset', async (req: Request, res: Response) => {
  await underAssetLock(res, async () => {
    const before = await loadBrandingRow();
    const assetsNull = Object.fromEntries(BRANDING_ASSET_SLOTS.flatMap((s) => [[KEY_FIELD(s), null], [TYPE_FIELD(s), null]]));
    const row = await writeBranding({
      productName: null, primaryColor: null, headerColor: null,
      loginText: '', footerLinks: [],
      allowUserAccent: true, showPoweredBy: true, defaultBackground: 'none',
      ...assetsNull,
    });
    await deleteUnreferenced(referencedKeys(before), row);
    log.info({ version: row.version }, 'Branding reset to defaults');
    res.json(adminView(afterChange(req, row, { reset: true }), row));
  });
});
