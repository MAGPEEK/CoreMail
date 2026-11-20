import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Palette, Save, RotateCcw, Upload, Trash2, Plus, X, AlertTriangle, Mail, Loader2, Image as ImageIcon, ChevronDown,
} from 'lucide-react';
import { api, apiFetch } from '../api/client.js';
import { ApiError } from '../lib/errors.js';
import { Toggle } from '../components/Toggle.js';
import { WriteGuard } from '../components/Can.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { setBranding } from '../hooks/useBranding.js';
import {
  ASSET_ERROR_TEXT, ASSET_MAX_BYTES, ASSET_TYPES, FOOTER_LINK_ERROR_TEXT, FOOTER_LABEL_MAX, FOOTER_LINKS_MAX,
  LOGIN_TEXT_MAX, PRODUCT_NAME_MAX, checkAssetFile, normalizeHex, validateFooterLink,
  type AssetErrorCode, type AssetSlot, type BrandingAssets, type FooterLink,
} from '../lib/branding.js';
import {
  advancedHasOverride, applyDefault, applySuggestion, changeCount, dirtyStatusText, draftFrom, editDraft,
  effectiveAssets, parseAdminBranding, parseFieldError, parseWarnings, releasedPreviewUrls, savePlan, saveSummary,
  validateDraft, withAssetRemoved, withAssetUpload,
  type AdminBranding, type AssetChange, type AssetChanges, type BrandingDraft, type BrandingWarning, type DefaultField,
  type DraftField, type StepResult,
} from '../lib/brandingForm.js';
import { PREVIEW_THEME_VARS, previewLogo, previewStyle } from '../lib/brandingPreview.js';
import { BUILTIN_BACKGROUND_IDS, BUILTIN_BACKGROUND_LABELS, builtinBackgroundUrl, isBuiltinBackground, parseDefaultBackground } from '../lib/backgroundPrefs.js';

// 9.3 — BCP → Organisation → Branding. API contract: docs/plans/branding-9.3.md.
// Layout: form cards on the left (Identität, Farben, Webmail, Anmeldeseite,
// Erweitert), the preview on the right (below the form under xl), one sticky
// action bar. Image changes are part of the draft (lib/brandingForm.ts).

const QUERY_KEY = ['admin-branding'] as const;

/** Updates the page data and the running app (title, favicon, colours) at once. */
function useBrandingWriter() {
  const qc = useQueryClient();
  return (raw: unknown) => {
    const a = parseAdminBranding(raw);
    qc.setQueryData(QUERY_KEY, a);
    setBranding(a.branding);
    void qc.invalidateQueries({ queryKey: QUERY_KEY });
    return a;
  };
}

/** Browser warning when the page (tab) is left with unsaved changes. */
function useUnsavedChangesWarning(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [active]);
}

/** Readable text of a failed image request (contract codes TYPE, SIZE, DIMENSIONS, SVG_UNSAFE). */
function requestErrorText(err: unknown, fallback: string): string {
  const code = err instanceof ApiError ? err.code : undefined;
  if (code && code in ASSET_ERROR_TEXT) return ASSET_ERROR_TEXT[code as AssetErrorCode];
  return err instanceof Error && err.message ? err.message : fallback;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function BrandingPage() {
  const { can } = usePermissions();
  const canWrite = can('organisation', 'write');
  const writeBranding = useBrandingWriter();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => parseAdminBranding(await api.get<unknown>('/admin/branding')),
    meta: { silentError: true },
  });

  const [draft, setDraft] = useState<BrandingDraft | null>(null);
  const [changes, setChanges] = useState<AssetChanges>({});
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<DraftField, string>>>({});
  const [assetErrors, setAssetErrors] = useState<Partial<Record<AssetSlot, string>>>({});
  const [formError, setFormError] = useState('');
  const [warnings, setWarnings] = useState<BrandingWarning[]>([]);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  /** null = not toggled yet: open when an override is stored */
  const [advancedOpen, setAdvancedOpen] = useState<boolean | null>(null);
  const [previewApp, setPreviewApp] = useState<'webmail' | 'login'>('webmail');
  const [previewTheme, setPreviewTheme] = useState<'light' | 'dark'>('light');

  // The draft is taken from the server once; later refetches (saves,
  // invalidation) do not overwrite unsaved edits.
  useEffect(() => { if (data && !draft) setDraft(draftFrom(data)); }, [data, draft]);

  // Object URLs of chosen files are released when the page goes away.
  const changesRef = useRef(changes);
  changesRef.current = changes;
  useEffect(() => () => { for (const url of releasedPreviewUrls(changesRef.current, {})) URL.revokeObjectURL(url); }, []);

  const count = data && draft ? changeCount(draft, data, changes) : 0;
  useUnsavedChangesWarning(count > 0);

  if (isLoading || (data && !draft)) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-fg-subtle" role="status">
        <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Branding wird geladen…
      </div>
    );
  }
  if (isError || !data || !draft) {
    return (
      <div className="p-6 max-w-3xl">
        <PageHeader />
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger-line bg-danger-bg px-4 py-3 text-sm text-danger-fg">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>Branding konnte nicht geladen werden{error instanceof Error && error.message ? `: ${error.message}` : '.'}</span>
        </div>
      </div>
    );
  }

  const localErrors = validateDraft(draft);
  const errors: Partial<Record<DraftField, string>> = { ...fieldErrors, ...localErrors };
  const savedAssets = data.branding.assets;
  const assets = effectiveAssets(savedAssets, changes);
  const showAdvanced = advancedOpen ?? advancedHasOverride(savedAssets);

  /** Replaces the pending image changes and releases object URLs nobody shows any more. */
  const replaceChanges = (next: AssetChanges) => {
    for (const url of releasedPreviewUrls(changes, next)) URL.revokeObjectURL(url);
    setChanges(next);
  };

  const update = <K extends keyof Omit<BrandingDraft, 'useDefault'>>(key: K, value: BrandingDraft[K]) => {
    setDraft((d) => (d ? editDraft(d, key, value) : d));
    setFieldErrors((e) => { const n = { ...e }; delete n[key as DraftField]; return n; });
    setFormError('');
  };

  // "Standard verwenden": back to the server default (BRANDING_NAME / BRANDING_COLOR, else the built-in one).
  const toDefault = (field: DefaultField) => {
    setDraft((d) => (d ? applyDefault(d, field, data) : d));
    setFieldErrors((e) => { const n = { ...e }; delete n[field]; return n; });
    setFormError('');
  };

  const setAssetError = (slot: AssetSlot, message: string | null) => setAssetErrors((e) => {
    const n = { ...e };
    if (message) n[slot] = message; else delete n[slot];
    return n;
  });

  const pickFile = (slot: AssetSlot, file: File) => {
    const pre = checkAssetFile(slot, file);
    if (pre) {
      setAssetError(slot, `${ASSET_ERROR_TEXT[pre]} ${pre === 'SIZE' ? `Erlaubt: max. ${Math.round(ASSET_MAX_BYTES[slot] / 1024)} KB.` : ''}`.trim());
      return;
    }
    setAssetError(slot, null);
    setFormError('');
    replaceChanges(withAssetUpload(changes, slot, file, URL.createObjectURL(file)));
  };

  const removeAsset = (slot: AssetSlot) => {
    setAssetError(slot, null);
    setFormError('');
    replaceChanges(withAssetRemoved(changes, slot, savedAssets));
  };

  const discard = () => {
    replaceChanges({});
    setDraft(draftFrom(data));
    setFieldErrors({});
    setAssetErrors({});
    setFormError('');
  };

  // Images first, then the settings (the API has no request for both); every failed part is reported.
  const save = async () => {
    if (Object.keys(localErrors).length > 0) {
      setFormError('Bitte zuerst die markierten Felder korrigieren.');
      return;
    }
    const plan = savePlan(draft, data, changes);
    if (plan.length === 0) return;
    setSaving(true);
    setFormError('');
    try {
      await runSave(plan);
    } finally {
      setSaving(false);
    }
  };

  const runSave = async (plan: ReturnType<typeof savePlan>) => {
    const results: StepResult[] = [];
    let settingsAnswer: AdminBranding | null = null;
    let nextWarnings: BrandingWarning[] = [];
    for (const step of plan) {
      try {
        if (step.kind === 'upload') {
          writeBranding(await api.postFile<unknown>(`/admin/branding/assets/${step.slot}`, step.file, step.file.type));
        } else if (step.kind === 'remove') {
          writeBranding(await api.delete<unknown>(`/admin/branding/assets/${step.slot}`));
        } else {
          const res = await apiFetch('/admin/branding', { method: 'PUT', body: JSON.stringify(step.body) });
          const body: unknown = await res.json().catch(() => null);
          if (!res.ok) {
            const { field, message } = parseFieldError(body, `HTTP ${res.status}`);
            if (field) setFieldErrors({ [field]: message });
            results.push({ step, error: message });
            continue;
          }
          settingsAnswer = writeBranding(body);
          nextWarnings = parseWarnings(body);
        }
        results.push({ step, error: null });
      } catch (err) {
        results.push({ step, error: requestErrorText(err, 'Anfrage fehlgeschlagen') });
      }
    }
    const summary = saveSummary(results);
    // Failed image changes stay in the draft (retry or discard); saved ones are done.
    const kept: AssetChanges = {};
    for (const slot of summary.failedSlots) {
      const c: AssetChange | undefined = changes[slot];
      if (c) kept[slot] = c;
    }
    replaceChanges(kept);
    setAssetErrors(Object.fromEntries(results.flatMap((r) => (r.error && r.step.kind !== 'settings' ? [[r.step.slot, r.error]] : []))));
    if (summary.failedSlots.some((s) => s === 'logoDark' || s === 'favicon')) setAdvancedOpen(true);
    if (settingsAnswer) {
      setDraft(draftFrom(settingsAnswer));
      setFieldErrors({});
    }
    setWarnings(nextWarnings);
    if (summary.ok) toast.success(nextWarnings.length ? 'Branding gespeichert — bitte die Hinweise prüfen' : 'Branding gespeichert');
    else setFormError(summary.message ?? 'Speichern fehlgeschlagen');
  };

  const reset = async () => {
    if (!window.confirm('Branding auf die Standardwerte zurücksetzen? Produktname, Farben, Texte, Links und alle hochgeladenen Bilder werden zurückgesetzt; ungespeicherte Änderungen gehen verloren.')) return;
    setResetting(true);
    try {
      const saved = writeBranding(await api.post<unknown>('/admin/branding/reset', {}));
      replaceChanges({});
      setDraft(draftFrom(saved));
      setFieldErrors({});
      setAssetErrors({});
      setFormError('');
      setWarnings([]);
      toast.success('Branding auf Standard zurückgesetzt');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Zurücksetzen fehlgeschlagen');
    } finally {
      setResetting(false);
    }
  };

  const takeSuggestion = (w: BrandingWarning) => {
    setDraft((d) => (d ? applySuggestion(d, w) : d));
    setWarnings((ws) => ws.filter((x) => x !== w));
  };

  const assetProps = (slot: AssetSlot) => ({
    slot,
    url: assets[slot],
    pending: changes[slot],
    error: assetErrors[slot],
    canWrite: canWrite && !saving,
    onPick: (file: File) => pickFile(slot, file),
    onRemove: () => removeAsset(slot),
  });

  return (
    <div className="px-6 pt-6 max-w-7xl">
      <PageHeader />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <WriteGuard area="organisation" className="space-y-6">
          {warnings.length > 0 && <WarningsBox warnings={warnings} onUse={takeSuggestion} />}

          <section className="card space-y-5" aria-labelledby="branding-identity">
            <h2 id="branding-identity" className="text-sm font-semibold text-fg">Identität</h2>
            <TextField id="branding-name" label="Produktname" value={draft.productName} maxLength={PRODUCT_NAME_MAX}
              onChange={(v) => update('productName', v)} error={errors.productName}
              hint={<>Erscheint im Browser-Tab, in der Kopfzeile und auf den Anmeldeseiten.{draft.useDefault.productName ? ' Aktuell: Standardwert.' : ''}</>}
              {...(draft.useDefault.productName ? {} : { onUseDefault: () => toDefault('productName') })} />
            <AssetField {...assetProps('logoLight')} label="Logo"
              hint={<>PNG, WebP oder SVG, max. 512 KB. Das Favicon wird automatisch aus dem Logo erzeugt.</>}
              emptyText="Standard" />
          </section>

          <section className="card space-y-5" aria-labelledby="branding-colors">
            <h2 id="branding-colors" className="text-sm font-semibold text-fg">Farben</h2>
            <ColorField id="branding-primary" label="Primärfarbe" value={draft.primaryColor}
              onChange={(v) => update('primaryColor', v)} error={errors.primaryColor}
              hint={<>Akzentfarbe für Schaltflächen, Links und Markierungen in Webmail und BCP.{draft.useDefault.primaryColor ? ' Aktuell: Standardwert.' : ''}</>}
              {...(draft.useDefault.primaryColor ? {} : { onUseDefault: () => toDefault('primaryColor') })} />
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Toggle active={draft.headerColor !== null} label="Eigene Farbe für die Kopfzeile"
                  onToggle={() => update('headerColor', draft.headerColor === null ? (normalizeHex(draft.primaryColor) ?? '#0078d4') : null)} />
                <span className="text-sm text-fg">Eigene Farbe für die Kopfzeile</span>
              </div>
              {draft.headerColor === null ? (
                <p className="text-xs text-fg-subtle">Die Kopfzeile der Webmail verwendet die Primärfarbe.</p>
              ) : (
                <ColorField id="branding-header" label="Kopfzeilenfarbe" value={draft.headerColor}
                  onChange={(v) => update('headerColor', v)} error={errors.headerColor}
                  hint="Text und Symbole der Kopfzeile werden automatisch weiß oder schwarz gesetzt (Kontrast ≥ 4,5:1)." />
              )}
            </div>
            <SwitchRow label="Benutzer dürfen eigene Akzentfarbe wählen" checked={draft.allowUserAccent}
              onChange={(v) => update('allowUserAccent', v)}
              hint="Aus: alle sehen die Primärfarbe, die Auswahl in den Webmail-Einstellungen ist gesperrt." />
          </section>

          <section className="card space-y-5" aria-labelledby="branding-webmail">
            <h2 id="branding-webmail" className="text-sm font-semibold text-fg">Webmail</h2>
            <DefaultBackgroundPicker value={draft.defaultBackground} onChange={(v) => update('defaultBackground', v)} />
          </section>

          <section className="card space-y-5" aria-labelledby="branding-login">
            <h2 id="branding-login" className="text-sm font-semibold text-fg">Anmeldeseite</h2>
            <AssetField {...assetProps('loginBackground')} label="Hintergrundbild"
              hint="PNG, JPEG, WebP oder SVG, max. 2 MB. Ohne Bild wird ein Verlauf in der Primärfarbe gezeigt." emptyText="Kein Bild" />
            <TextAreaField id="branding-login-text" label="Begrüßungstext" value={draft.loginText} maxLength={LOGIN_TEXT_MAX}
              onChange={(v) => update('loginText', v)} error={errors.loginText}
              hint="Reiner Text unter dem Titel der Anmeldeseite (kein HTML)." />
            <FooterLinksEditor links={draft.footerLinks} onChange={(l) => update('footerLinks', l)} error={errors.footerLinks} />
            <SwitchRow label="„Powered by CoreMail“ anzeigen" checked={draft.showPoweredBy}
              onChange={(v) => update('showPoweredBy', v)} hint="Dezenter Hinweis in der Fußzeile der Anmeldeseiten." />
          </section>

          <AdvancedSection open={showAdvanced} onToggle={() => setAdvancedOpen(!showAdvanced)}>
            <AssetField {...assetProps('logoDark')} label="Eigenes Logo für den dunklen Modus (optional)"
              hint="Ohne eigenes Logo wird im dunklen Modus das Logo verwendet. PNG, WebP oder SVG, max. 512 KB."
              emptyText={assets.logoLight ? 'Wie das Logo' : 'Standard'} darkSurface />
            <AssetField {...assetProps('favicon')} label="Eigenes Favicon (optional)"
              hint="Ersetzt das aus dem Logo erzeugte Favicon. Quadratisch, höchstens 1024 × 1024 px. PNG, WebP oder SVG, max. 512 KB."
              emptyText={assets.logoLight ? 'Aus dem Logo erzeugt' : 'Standard'} />
          </AdvancedSection>
        </WriteGuard>

        <PreviewPanel draft={draft} assets={assets} app={previewApp} theme={previewTheme}
          onApp={setPreviewApp} onTheme={setPreviewTheme} />
      </div>

      <ActionBar count={count} canWrite={canWrite} saving={saving} resetting={resetting} formError={formError}
        onSave={() => void save()} onDiscard={discard} onReset={() => void reset()} />
    </div>
  );
}

function PageHeader() {
  return (
    <div className="flex items-center gap-3 mb-6">
      <Palette size={20} className="text-accent-fg" aria-hidden="true" />
      <div>
        <h1 className="text-xl font-semibold text-fg">Branding</h1>
        <p className="text-xs text-fg-subtle">Produktname, Farben, Logo und Anmeldeseite für Webmail und BCP</p>
      </div>
    </div>
  );
}

/** Sticky bar at the bottom of the page: change status and the page actions. */
function ActionBar({ count, canWrite, saving, resetting, formError, onSave, onDiscard, onReset }: {
  count: number; canWrite: boolean; saving: boolean; resetting: boolean; formError: string;
  onSave: () => void; onDiscard: () => void; onReset: () => void;
}) {
  const busy = saving || resetting;
  return (
    <div className="sticky bottom-0 z-10 -mx-6 mt-6 border-t border-line bg-surface px-6 py-3">
      {formError && <p role="alert" className="mb-2 text-sm text-danger-fg">{formError}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className={`text-sm ${count > 0 ? 'font-medium text-fg' : 'text-fg-muted'}`}>{dirtyStatusText(count)}</p>
        <span className="flex-1" />
        <button type="button" className="btn-secondary" onClick={onReset} disabled={!canWrite || busy}>
          {resetting ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
          Auf Standard zurücksetzen
        </button>
        <button type="button" className="btn-secondary" onClick={onDiscard} disabled={!canWrite || busy || count === 0}>
          Änderungen verwerfen
        </button>
        <button type="button" className="btn-primary" onClick={onSave} disabled={!canWrite || busy || count === 0}>
          {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
          Speichern
        </button>
      </div>
    </div>
  );
}

/** "Erweitert": a card whose content is shown by a disclosure button. */
function AdvancedSection({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  const contentId = useId();
  return (
    <section className="card" aria-labelledby={`${contentId}-heading`}>
      <h2 id={`${contentId}-heading`} className="text-sm font-semibold text-fg">
        <button type="button" className="flex w-full items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg"
          aria-expanded={open} aria-controls={contentId} onClick={onToggle}>
          <ChevronDown size={16} aria-hidden="true" className={`shrink-0 text-fg-muted transition-transform ${open ? '' : '-rotate-90'}`} />
          Erweitert
        </button>
      </h2>
      <div id={contentId} hidden={!open} className="mt-5 space-y-5">
        {children}
      </div>
    </section>
  );
}

// ── Form fields ───────────────────────────────────────────────────────────────

function FieldMessages({ id, hint, error }: { id: string; hint?: ReactNode; error?: string | undefined }) {
  return (
    <>
      {hint && <p id={`${id}-hint`} className="text-xs text-fg-subtle mt-1">{hint}</p>}
      {error && <p id={`${id}-error`} className="text-xs text-danger-fg mt-1">{error}</p>}
    </>
  );
}

const describedBy = (id: string, hint: unknown, error: unknown) =>
  [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;

/** "Standard verwenden" next to a field whose value is stored (or edited). */
function UseDefaultButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="btn-ghost shrink-0" onClick={onClick} aria-label={`${label}: Standard verwenden`}>
      <RotateCcw size={14} aria-hidden="true" /> Standard verwenden
    </button>
  );
}

function TextField({ id, label, value, onChange, maxLength, hint, error, onUseDefault }: {
  id: string; label: string; value: string; onChange: (v: string) => void; maxLength: number; hint?: ReactNode; error?: string | undefined;
  onUseDefault?: () => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="field-label">{label}</label>
      <div className="flex flex-wrap items-center gap-2">
        <input id={id} className="input max-w-md" value={value} maxLength={maxLength} onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!error} aria-describedby={describedBy(id, hint, error)} />
        {onUseDefault && <UseDefaultButton label={label} onClick={onUseDefault} />}
      </div>
      <FieldMessages id={id} hint={hint} error={error} />
    </div>
  );
}

function TextAreaField({ id, label, value, onChange, maxLength, hint, error }: {
  id: string; label: string; value: string; onChange: (v: string) => void; maxLength: number; hint?: ReactNode; error?: string | undefined;
}) {
  const count = [...value].length;
  return (
    <div>
      <label htmlFor={id} className="field-label">{label}</label>
      <textarea id={id} className="input min-h-[5rem]" value={value} maxLength={maxLength} rows={3}
        onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} aria-describedby={describedBy(id, hint, error)} />
      <div className="flex justify-between gap-2">
        <FieldMessages id={id} hint={hint} error={error} />
        <span className="text-xs text-fg-subtle mt-1 shrink-0" aria-live="polite">{count}/{maxLength}</span>
      </div>
    </div>
  );
}

function ColorField({ id, label, value, onChange, hint, error, onUseDefault }: {
  id: string; label: string; value: string; onChange: (v: string) => void; hint?: ReactNode; error?: string | undefined;
  onUseDefault?: () => void;
}) {
  const normalized = normalizeHex(value);
  return (
    <div>
      <label htmlFor={id} className="field-label">{label} (Hex)</label>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={`${label}: Farbwähler`} value={normalized ?? '#000000'}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-12 shrink-0 cursor-pointer rounded border border-line-strong bg-surface p-0.5" />
        <input id={id} className="input w-32 font-mono" value={value} maxLength={7} spellCheck={false} autoComplete="off"
          placeholder="#0078d4" onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!error} aria-describedby={describedBy(id, hint, error)} />
        {onUseDefault && <UseDefaultButton label={label} onClick={onUseDefault} />}
      </div>
      <FieldMessages id={id} hint={hint} error={error} />
    </div>
  );
}

/**
 * 10.1: "Standard-Hintergrund" — the webmail background of users without an own
 * choice: Keiner or one of the built-in pictures (the webmail serves them at
 * /backgrounds/…; the same set as Einstellungen → Darstellung).
 */
function DefaultBackgroundPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const current = parseDefaultBackground(value);
  const options: { value: string; label: string; src: string | null }[] = [
    { value: 'none', label: 'Keiner', src: null },
    ...BUILTIN_BACKGROUND_IDS.map((id) => ({ value: `builtin:${id}`, label: BUILTIN_BACKGROUND_LABELS[id], src: builtinBackgroundUrl(id, false) })),
  ];
  return (
    <fieldset className="min-w-0 border-0 p-0 m-0 space-y-2">
      <legend className="field-label">Standard-Hintergrund der Webmail</legend>
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
        {options.map((o) => (
          <label key={o.value} className="group flex flex-col gap-1 cursor-pointer">
            <input type="radio" name="branding-default-background" value={o.value} checked={current === o.value}
              onChange={() => onChange(o.value)} className="peer sr-only" />
            <span className={`block aspect-[16/10] rounded-md overflow-hidden border-2 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-fg ${
              current === o.value ? 'border-accent' : 'border-line group-hover:border-line-strong'
            }`}>
              {o.src ? <img src={o.src} alt="" className="w-full h-full object-cover" loading="lazy" /> : <span className="block w-full h-full bg-surface-2" />}
            </span>
            <span className={`text-xs leading-tight ${current === o.value ? 'text-accent-fg font-semibold' : 'text-fg-muted'}`}>{o.label}</span>
          </label>
        ))}
      </div>
      <p className="text-xs text-fg-subtle">Gilt für alle, die in den Einstellungen keinen eigenen Hintergrund gewählt haben.</p>
    </fieldset>
  );
}

function SwitchRow({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <div className="flex items-start gap-3">
      <Toggle active={checked} onToggle={() => onChange(!checked)} label={label} />
      <div>
        <p className="text-sm text-fg">{label}</p>
        {hint && <p className="text-xs text-fg-subtle mt-0.5">{hint}</p>}
      </div>
    </div>
  );
}

function FooterLinksEditor({ links, onChange, error }: { links: FooterLink[]; onChange: (l: FooterLink[]) => void; error?: string | undefined }) {
  const baseId = useId();
  const set = (i: number, patch: Partial<FooterLink>) => onChange(links.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <fieldset className="min-w-0 border-0 p-0 m-0 space-y-2">
      <legend className="field-label">Links in der Fußzeile (max. {FOOTER_LINKS_MAX}, z. B. Impressum, Datenschutz)</legend>
      {links.length === 0 && <p className="text-xs text-fg-subtle">Keine Links.</p>}
      {links.map((l, i) => {
        const err = validateFooterLink(l);
        const errId = `${baseId}-${i}-error`;
        return (
          <div key={i} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <input className="input w-40" value={l.label} maxLength={FOOTER_LABEL_MAX} placeholder="Bezeichnung"
                aria-label={`Link ${i + 1}: Bezeichnung`} aria-invalid={err === 'LABEL_EMPTY' || err === 'LABEL_TOO_LONG'}
                {...(err ? { 'aria-describedby': errId } : {})}
                onChange={(e) => set(i, { label: e.target.value })} />
              <input className="input flex-1 min-w-[12rem]" value={l.url} placeholder="https://… oder mailto:…" type="text" inputMode="url"
                aria-label={`Link ${i + 1}: Adresse`} aria-invalid={!!err && err.startsWith('URL')}
                {...(err ? { 'aria-describedby': errId } : {})}
                onChange={(e) => set(i, { url: e.target.value })} />
              <button type="button" className="btn-ghost" aria-label={`Link ${i + 1} entfernen`}
                onClick={() => onChange(links.filter((_, j) => j !== i))}>
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            {err && <p id={errId} className="text-xs text-danger-fg">{FOOTER_LINK_ERROR_TEXT[err]}</p>}
          </div>
        );
      })}
      <button type="button" className="btn-secondary" disabled={links.length >= FOOTER_LINKS_MAX}
        onClick={() => onChange([...links, { label: '', url: 'https://' }])}>
        <Plus size={14} aria-hidden="true" /> Link hinzufügen
      </button>
      {error && !links.some((l) => validateFooterLink(l)) && <p className="text-xs text-danger-fg">{error}</p>}
    </fieldset>
  );
}

function WarningsBox({ warnings, onUse }: { warnings: BrandingWarning[]; onUse: (w: BrandingWarning) => void }) {
  return (
    <div role="status" className="rounded-lg border border-warning-line bg-warning-bg px-4 py-3 space-y-2">
      <p className="flex items-center gap-2 text-sm font-semibold text-warning-fg">
        <AlertTriangle size={15} aria-hidden="true" /> Hinweise zur Lesbarkeit
      </p>
      <ul className="space-y-2">
        {warnings.map((w, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 text-sm text-fg">
            <span>{w.field === 'headerColor' ? 'Kopfzeilenfarbe' : w.field === 'primaryColor' ? 'Primärfarbe' : w.field}: {w.message}</span>
            {w.suggestion && (w.field === 'primaryColor' || w.field === 'headerColor') && (
              <button type="button" className="btn-secondary" onClick={() => onUse(w)}>
                <span aria-hidden="true" className="inline-block h-3.5 w-3.5 rounded-sm border border-line-strong" style={{ backgroundColor: w.suggestion }} />
                Vorschlag übernehmen ({w.suggestion})
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-fg-muted">Ein übernommener Vorschlag wird erst mit „Speichern“ wirksam.</p>
    </div>
  );
}

// ── Images ────────────────────────────────────────────────────────────────────

/**
 * One image slot of the draft: the current or chosen image, "Datei wählen" or
 * drag & drop, "Entfernen". Nothing is uploaded here — the page saves pending
 * changes with "Speichern".
 */
function AssetField({ slot, label, hint, url, pending, error, emptyText, canWrite, darkSurface = false, onPick, onRemove }: {
  slot: AssetSlot; label: string; hint: ReactNode; url: string | null; pending: AssetChange | undefined;
  error: string | undefined; emptyText: string; canWrite: boolean; darkSurface?: boolean;
  onPick: (file: File) => void; onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const [dragOver, setDragOver] = useState(false);
  const status = pending?.kind === 'upload' ? 'Neue Datei — wird beim Speichern hochgeladen.'
    : pending?.kind === 'remove' ? 'Wird beim Speichern entfernt.' : null;
  const describedIds = [`${baseId}-hint`, status ? `${baseId}-status` : '', error ? `${baseId}-error` : ''].filter(Boolean).join(' ');

  // The dark-mode logo is shown on the dark surface, everything else on the light one.
  const thumbStyle = Object.fromEntries(
    Object.entries(PREVIEW_THEME_VARS[darkSurface ? 'dark' : 'light']).map(([k, v]) => [`--${k}`, v]),
  ) as CSSProperties;

  return (
    <div className="space-y-2" role="group" aria-labelledby={`${baseId}-label`}>
      <div>
        <p id={`${baseId}-label`} className="text-sm font-medium text-fg">{label}</p>
        <p id={`${baseId}-hint`} className="text-xs text-fg-subtle mt-0.5">{hint}</p>
      </div>
      <div className="flex flex-wrap items-stretch gap-3">
        <div style={thumbStyle} className="flex h-20 w-40 max-w-full shrink-0 items-center justify-center rounded border border-line-strong bg-surface-2 p-2">
          {url
            ? <img src={url} alt={`${label}: ${pending?.kind === 'upload' ? 'neue Datei' : 'aktuell'}`} className="max-h-16 max-w-full object-contain" />
            : <span className="flex items-center gap-1.5 text-xs text-fg-muted"><ImageIcon size={14} aria-hidden="true" /> {emptyText}</span>}
        </div>
        <div
          onDragOver={(e) => { if (!canWrite) return; e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (!canWrite) return;
            const file = e.dataTransfer.files[0];
            if (file) onPick(file);
          }}
          className={`flex min-w-0 flex-1 basis-56 flex-wrap items-center gap-2 rounded border-2 border-dashed px-3 py-2 text-xs text-fg-muted ${
            dragOver ? 'border-accent-fg bg-accent/5' : 'border-line-strong'
          }`}
        >
          <button type="button" className="btn-secondary" disabled={!canWrite} onClick={() => inputRef.current?.click()}
            aria-describedby={describedIds}>
            <Upload size={14} aria-hidden="true" /> Datei wählen
          </button>
          <span>oder hierher ziehen</span>
          <input ref={inputRef} type="file" className="hidden" tabIndex={-1} aria-hidden="true" accept={ASSET_TYPES[slot].join(',')}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ''; }} />
          {url && (
            <button type="button" className="btn-ghost ml-auto" disabled={!canWrite} onClick={onRemove}
              aria-label={`${label}: entfernen`}>
              <Trash2 size={14} aria-hidden="true" /> Entfernen
            </button>
          )}
        </div>
      </div>
      {status && <p id={`${baseId}-status`} className="text-xs text-fg-muted">{status}</p>}
      {error && <p id={`${baseId}-error`} role="alert" className="text-xs text-danger-fg">{error}</p>}
    </div>
  );
}

// ── Live preview ──────────────────────────────────────────────────────────────

/** Two to three options as native radio buttons (arrow keys move the choice). */
function Segmented<T extends string>({ name, legend, value, options, onChange }: {
  name: string; legend: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="sr-only">{legend}</legend>
      <div className="inline-flex rounded border border-line-strong bg-surface p-0.5">
        {options.map((o) => (
          <label key={o.value} className="cursor-pointer">
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)}
              className="peer sr-only" />
            <span className={`block rounded px-2.5 py-1 text-xs font-medium peer-focus-visible:ring-2 peer-focus-visible:ring-accent-fg ${
              value === o.value ? 'bg-accent text-white' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
            }`}>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function PreviewPanel({ draft, assets, app, theme, onApp, onTheme }: {
  draft: BrandingDraft; assets: BrandingAssets; app: 'webmail' | 'login'; theme: 'light' | 'dark';
  onApp: (v: 'webmail' | 'login') => void; onTheme: (v: 'light' | 'dark') => void;
}) {
  return (
    <aside className="min-w-0 space-y-3 xl:sticky xl:top-4 self-start" aria-labelledby="branding-preview">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="branding-preview" className="mr-auto text-sm font-semibold text-fg">Vorschau</h2>
        <Segmented name="branding-preview-app" legend="Vorschau für" value={app} onChange={onApp}
          options={[{ value: 'webmail', label: 'Webmail' }, { value: 'login', label: 'Anmeldeseite' }]} />
        <Segmented name="branding-preview-theme" legend="Farbschema der Vorschau" value={theme} onChange={onTheme}
          options={[{ value: 'light', label: 'hell' }, { value: 'dark', label: 'dunkel' }]} />
      </div>
      {app === 'webmail'
        ? <WebmailPreview draft={draft} assets={assets} dark={theme === 'dark'} />
        : <LoginPreview draft={draft} assets={assets} dark={theme === 'dark'} />}
      <p className="text-xs text-fg-subtle">Die Vorschau zeigt auch ungespeicherte Änderungen.</p>
    </aside>
  );
}

/**
 * Webmail with the unsaved values: top bar and the default background, in the
 * light or dark look (token variables set on the container,
 * lib/brandingPreview.ts). Decorative copy of the real UI: nothing in it is focusable.
 */
function WebmailPreview({ draft, assets, dark }: { draft: BrandingDraft; assets: BrandingAssets; dark: boolean }) {
  const name = draft.productName.trim() || 'CoreMail';
  const logo = previewLogo(assets, dark);
  const bg = parseDefaultBackground(draft.defaultBackground);
  const bgId = bg.startsWith('builtin:') ? bg.slice('builtin:'.length) : '';
  const bgUrl = isBuiltinBackground(bgId) ? builtinBackgroundUrl(bgId, dark) : null;
  return (
    <figure style={previewStyle(draft, dark) as CSSProperties} className="m-0 overflow-hidden rounded-lg border border-line-strong bg-canvas text-fg"
      aria-label={`Vorschau Webmail, ${dark ? 'dunkel' : 'hell'}`}>
      <div className="flex h-10 items-center gap-3 bg-header px-3 text-header-fg">
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          {logo ? <img src={logo} alt="" className="max-h-6 max-w-[5rem] w-auto object-contain" /> : <Mail size={15} aria-hidden="true" />}
          <span className="truncate">{name}</span>
        </span>
        <span className="rounded bg-header-overlay/25 px-2 py-0.5 text-xs font-semibold shadow-[inset_0_-2px_0_currentColor]">Mail</span>
        <span className="px-2 py-0.5 text-xs">Kalender</span>
      </div>
      <div className="relative flex gap-2 p-3">
        {bgUrl && <div aria-hidden="true" className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${bgUrl}")` }} />}
        <div className="relative w-1/3 space-y-1.5 rounded bg-surface p-2">
          <div className="rounded bg-accent py-1 text-center text-[11px] font-medium text-white">Neue E-Mail</div>
          <div className="h-2 rounded bg-surface-3" />
          <div className="h-2 w-3/4 rounded bg-surface-3" />
          <div className="h-2 w-2/3 rounded bg-surface-3" />
        </div>
        <div className="relative flex-1 space-y-2 rounded bg-surface p-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className={`space-y-1 rounded border-l-2 px-1.5 py-1 ${i === 0 ? 'border-accent bg-accent/10' : 'border-transparent'}`}>
              <div className="h-2 w-1/2 rounded bg-line-strong" />
              <div className="h-2 w-5/6 rounded bg-surface-3" />
            </div>
          ))}
        </div>
      </div>
    </figure>
  );
}

/**
 * Login page with the unsaved values: background image, logo, product name,
 * welcome text, footer links. Decorative copy of the real UI: nothing in it is focusable.
 */
function LoginPreview({ draft, assets, dark }: { draft: BrandingDraft; assets: BrandingAssets; dark: boolean }) {
  const name = draft.productName.trim() || 'CoreMail';
  const logo = previewLogo(assets, dark);
  const bg = assets.loginBackground;
  const links = draft.footerLinks.filter((l) => validateFooterLink(l) === null).slice(0, FOOTER_LINKS_MAX);
  return (
    <figure style={previewStyle(draft, dark) as CSSProperties} className="m-0 overflow-hidden rounded-lg border border-line-strong bg-canvas text-fg"
      aria-label={`Vorschau Anmeldeseite, ${dark ? 'dunkel' : 'hell'}`}>
      <div className="relative flex min-h-[16rem] flex-col items-center justify-center gap-2 bg-accent px-4 py-6">
        {bg ? (
          <>
            <div aria-hidden="true" className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${bg}")` }} />
            <div aria-hidden="true" className="absolute inset-0 bg-scrim/40" />
          </>
        ) : (
          <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-br from-transparent to-scrim/40" />
        )}
        <div className="relative w-full max-w-[15rem] rounded-lg bg-surface p-4 shadow-xl">
          <div className="flex items-center justify-center gap-2">
            {logo
              ? <img src={logo} alt="" className="max-h-8 max-w-[5rem] w-auto object-contain" />
              : <span className="flex h-7 w-7 items-center justify-center rounded bg-accent"><Mail size={14} className="text-white" aria-hidden="true" /></span>}
            <span className="min-w-0 break-words text-sm font-bold text-fg">{name}</span>
          </div>
          {draft.loginText.trim() && (
            <p className="mt-2 whitespace-pre-line break-words text-center text-xs text-fg-muted">{draft.loginText}</p>
          )}
          <div className="mt-3 h-6 rounded border border-line-strong bg-surface" />
          <div className="mt-2 h-6 rounded border border-line-strong bg-surface" />
          <div className="mt-2 rounded bg-accent py-1 text-center text-xs font-medium text-white">Anmelden</div>
          <p className="mt-2 text-center text-[11px] text-accent-fg underline">Passwort vergessen?</p>
        </div>
        {(links.length > 0 || draft.showPoweredBy) && (
          <div className="relative flex max-w-[15rem] flex-wrap justify-center gap-x-2 rounded bg-surface px-2 py-1 text-[11px] text-fg-muted">
            {links.map((l, i) => <span key={i} className="text-accent-fg underline">{l.label}</span>)}
            {draft.showPoweredBy && <span>Powered by CoreMail</span>}
          </div>
        )}
      </div>
    </figure>
  );
}
