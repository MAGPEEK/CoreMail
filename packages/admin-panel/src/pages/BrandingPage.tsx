import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Palette, Save, RotateCcw, Upload, Trash2, Plus, X, AlertTriangle, Mail, Loader2, Image as ImageIcon,
} from 'lucide-react';
import { api, apiFetch } from '../api/client.js';
import { ApiError } from '../lib/errors.js';
import { Toggle } from '../components/Toggle.js';
import { WriteGuard } from '../components/Can.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { setBranding } from '../hooks/useBranding.js';
import {
  ASSET_ERROR_TEXT, ASSET_MAX_BYTES, ASSET_TYPES, FOOTER_LINK_ERROR_TEXT, FOOTER_LABEL_MAX, FOOTER_LINKS_MAX,
  LOGIN_TEXT_MAX, PRODUCT_NAME_MAX, checkAssetFile, logoFor, normalizeHex, validateFooterLink,
  type AssetErrorCode, type AssetSlot, type BrandingAssets, type FooterLink,
} from '../lib/branding.js';
import {
  applyDefault, applySuggestion, draftFrom, draftToBody, editDraft, isDraftDirty, parseAdminBranding, parseFieldError,
  parseWarnings, validateDraft,
  type BrandingDraft, type BrandingWarning, type DefaultField, type DraftField,
} from '../lib/brandingForm.js';
import { PREVIEW_THEME_VARS, previewStyle } from '../lib/brandingPreview.js';

// 9.3 — BCP → Organisation → Branding. API contract: docs/plans/branding-9.3.md.

const QUERY_KEY = ['admin-branding'] as const;

const SLOT_META: Record<AssetSlot, { label: string; hint: string }> = {
  logoLight:       { label: 'Logo (hell)',         hint: 'Für helle Flächen. PNG, WebP oder SVG, max. 512 KB.' },
  logoDark:        { label: 'Logo (dunkel, optional)', hint: 'Wird im dunklen Modus verwendet. PNG, WebP oder SVG, max. 512 KB.' },
  favicon:         { label: 'Favicon',              hint: 'Quadratisch. PNG, WebP oder SVG, max. 512 KB. Ohne Favicon wird das Logo verwendet.' },
  loginBackground: { label: 'Login-Hintergrund',    hint: 'PNG, JPEG, WebP oder SVG, max. 2 MB.' },
};
const SLOTS: AssetSlot[] = ['logoLight', 'logoDark', 'favicon', 'loginBackground'];

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
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<DraftField, string>>>({});
  const [formError, setFormError] = useState('');
  const [warnings, setWarnings] = useState<BrandingWarning[]>([]);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  // The draft is taken from the server once; later refetches (asset uploads,
  // invalidation) do not overwrite unsaved edits.
  useEffect(() => { if (data && !draft) setDraft(draftFrom(data)); }, [data, draft]);

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
  const dirty = isDraftDirty(draft, data);

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

  const save = async () => {
    if (Object.keys(localErrors).length > 0) {
      setFormError('Bitte zuerst die markierten Felder korrigieren.');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const res = await apiFetch('/admin/branding', { method: 'PUT', body: JSON.stringify(draftToBody(draft, data)) });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const { field, message } = parseFieldError(body, `Speichern fehlgeschlagen (HTTP ${res.status})`);
        if (field) setFieldErrors({ [field]: message });
        else setFormError(message);
        return;
      }
      const saved = writeBranding(body);
      setDraft(draftFrom(saved));
      setFieldErrors({});
      const ws = parseWarnings(body);
      setWarnings(ws);
      toast.success(ws.length ? 'Branding gespeichert — bitte die Hinweise prüfen' : 'Branding gespeichert');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!window.confirm('Branding auf die Standardwerte zurücksetzen? Produktname, Farben, Texte, Links und alle hochgeladenen Bilder werden zurückgesetzt.')) return;
    setResetting(true);
    try {
      const saved = writeBranding(await api.post<unknown>('/admin/branding/reset', {}));
      setDraft(draftFrom(saved));
      setFieldErrors({});
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

  return (
    <div className="p-6 max-w-7xl">
      <PageHeader />
      <WriteGuard area="organisation">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <div className="space-y-6 min-w-0">
            {warnings.length > 0 && <WarningsBox warnings={warnings} onUse={takeSuggestion} />}

            <section className="card space-y-5" aria-labelledby="branding-general">
              <h2 id="branding-general" className="text-sm font-semibold text-fg">Name und Farben</h2>
              <TextField id="branding-name" label="Produktname" value={draft.productName} maxLength={PRODUCT_NAME_MAX}
                onChange={(v) => update('productName', v)} error={errors.productName}
                hint={<>Erscheint im Browser-Tab, in der Kopfzeile und auf den Anmeldeseiten.{draft.useDefault.productName ? ' Aktuell: Standardwert.' : ''}</>}
                {...(draft.useDefault.productName ? {} : { onUseDefault: () => toDefault('productName') })} />
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

            <section className="card space-y-5" aria-labelledby="branding-login">
              <h2 id="branding-login" className="text-sm font-semibold text-fg">Anmeldeseite</h2>
              <TextAreaField id="branding-login-text" label="Begrüßungstext" value={draft.loginText} maxLength={LOGIN_TEXT_MAX}
                onChange={(v) => update('loginText', v)} error={errors.loginText}
                hint="Reiner Text unter dem Titel der Anmeldeseite (kein HTML)." />
              <FooterLinksEditor links={draft.footerLinks} onChange={(l) => update('footerLinks', l)} error={errors.footerLinks} />
              <SwitchRow label="„Powered by CoreMail“ anzeigen" checked={draft.showPoweredBy}
                onChange={(v) => update('showPoweredBy', v)} hint="Dezenter Hinweis in der Fußzeile der Anmeldeseiten." />
            </section>

            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !dirty}>
                {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
                Speichern
              </button>
              <button type="button" className="btn-secondary" onClick={() => setDraft(draftFrom(data))} disabled={saving || !dirty}>
                Änderungen verwerfen
              </button>
              <span className="flex-1" />
              <button type="button" className="btn-secondary" onClick={() => void reset()} disabled={resetting || saving}>
                <RotateCcw size={14} aria-hidden="true" /> Auf Standard zurücksetzen
              </button>
            </div>
            {formError && (
              <p role="alert" className="rounded border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger-fg">{formError}</p>
            )}
            {dirty && !formError && <p className="text-xs text-fg-subtle" role="status">Ungespeicherte Änderungen — die Vorschau zeigt sie bereits.</p>}

            <section className="card space-y-4" aria-labelledby="branding-assets">
              <div>
                <h2 id="branding-assets" className="text-sm font-semibold text-fg">Bilder</h2>
                <p className="text-xs text-fg-subtle mt-0.5">Bilder werden sofort nach dem Hochladen gespeichert. SVG-Dateien werden serverseitig geprüft.</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {SLOTS.map((slot) => (
                  <AssetSlotCard key={slot} slot={slot} url={data.branding.assets[slot]} canWrite={canWrite} onSaved={writeBranding} />
                ))}
              </div>
            </section>
          </div>

          <aside className="min-w-0 space-y-4 xl:sticky xl:top-4 self-start" aria-labelledby="branding-preview">
            <h2 id="branding-preview" className="text-sm font-semibold text-fg">Vorschau</h2>
            <BrandPreview draft={draft} assets={data.branding.assets} dark={false} />
            <BrandPreview draft={draft} assets={data.branding.assets} dark />
          </aside>
        </div>
      </WriteGuard>
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

// ── Assets ────────────────────────────────────────────────────────────────────

function AssetSlotCard({ slot, url, canWrite, onSaved }: {
  slot: AssetSlot; url: string | null; canWrite: boolean; onSaved: (raw: unknown) => void;
}) {
  const meta = SLOT_META[slot];
  const inputRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const errorId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const upload = async (file: File) => {
    setError('');
    const pre = checkAssetFile(slot, file);
    if (pre) {
      setError(`${ASSET_ERROR_TEXT[pre]} ${pre === 'SIZE' ? `Erlaubt: max. ${Math.round(ASSET_MAX_BYTES[slot] / 1024)} KB.` : ''}`.trim());
      return;
    }
    setBusy(true);
    try {
      onSaved(await api.postFile<unknown>(`/admin/branding/assets/${slot}`, file, file.type));
      toast.success(`${meta.label} gespeichert`);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      setError(code && code in ASSET_ERROR_TEXT ? ASSET_ERROR_TEXT[code as AssetErrorCode] : err instanceof Error ? err.message : 'Hochladen fehlgeschlagen');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async () => {
    if (!window.confirm(`${meta.label} entfernen? Danach wird der Standard verwendet.`)) return;
    setError('');
    setBusy(true);
    try {
      onSaved(await api.delete<unknown>(`/admin/branding/assets/${slot}`));
      toast.success(`${meta.label} entfernt`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Entfernen fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  };

  // The dark logo is shown on the dark surface, everything else on the light one.
  const thumbStyle = Object.fromEntries(
    Object.entries(PREVIEW_THEME_VARS[slot === 'logoDark' ? 'dark' : 'light']).map(([k, v]) => [`--${k}`, v]),
  ) as CSSProperties;

  return (
    <div className="rounded-lg border border-line p-4 space-y-3" aria-labelledby={headingId}>
      <div>
        <h3 id={headingId} className="text-sm font-medium text-fg">{meta.label}</h3>
        <p className="text-xs text-fg-subtle mt-0.5">{meta.hint}</p>
      </div>
      <div style={thumbStyle} className="flex h-20 items-center justify-center rounded border border-line-strong bg-surface-2 p-2">
        {url
          ? <img src={url} alt={`${meta.label} (aktuell)`} className="max-h-16 max-w-full object-contain" />
          : <span className="flex items-center gap-1.5 text-xs text-fg-muted"><ImageIcon size={14} aria-hidden="true" /> Standard</span>}
      </div>
      <div
        onDragOver={(e) => { if (!canWrite || busy) return; e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!canWrite || busy) return;
          const file = e.dataTransfer.files[0];
          if (file) void upload(file);
        }}
        className={`flex flex-wrap items-center gap-2 rounded border-2 border-dashed px-3 py-2 text-xs text-fg-muted ${
          dragOver ? 'border-accent-fg bg-accent/5' : 'border-line-strong'
        }`}
      >
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => inputRef.current?.click()}
          {...(error ? { 'aria-describedby': errorId } : {})}>
          {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Upload size={14} aria-hidden="true" />}
          Datei wählen
        </button>
        <span>oder hierher ziehen</span>
        <input ref={inputRef} type="file" className="hidden" tabIndex={-1} aria-hidden="true" accept={ASSET_TYPES[slot].join(',')}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        {url && (
          <button type="button" className="btn-ghost ml-auto" disabled={busy} onClick={() => void remove()}>
            <Trash2 size={14} aria-hidden="true" /> Entfernen
          </button>
        )}
      </div>
      {error && <p id={errorId} role="alert" className="text-xs text-danger-fg">{error}</p>}
    </div>
  );
}

// ── Live preview ──────────────────────────────────────────────────────────────

/**
 * Top bar of the webmail and the login card with the unsaved values, in the
 * light or dark look (token variables set on the container, lib/brandingPreview.ts).
 * Decorative copy of the real UI: nothing in it is focusable.
 */
function BrandPreview({ draft, assets, dark }: { draft: BrandingDraft; assets: BrandingAssets; dark: boolean }) {
  const name = draft.productName.trim() || 'CoreMail';
  const logo = logoFor(assets, dark);
  const bg = assets.loginBackground;
  const links = draft.footerLinks.filter((l) => validateFooterLink(l) === null).slice(0, FOOTER_LINKS_MAX);
  const style = previewStyle(draft, dark) as CSSProperties;
  return (
    <figure style={style} className="overflow-hidden rounded-lg border border-line-strong bg-canvas text-fg" aria-label={`Vorschau ${dark ? 'dunkel' : 'hell'}`}>
      <figcaption className="bg-surface px-3 py-1.5 text-xs font-medium text-fg-muted border-b border-line">{dark ? 'Dunkler Modus' : 'Heller Modus'}</figcaption>
      {/* Webmail top bar */}
      <div className="flex h-10 items-center gap-3 bg-header px-3 text-header-fg">
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          {logo ? <img src={logo} alt="" className="max-h-6 max-w-[5rem] w-auto object-contain" /> : <Mail size={15} aria-hidden="true" />}
          <span className="truncate">{name}</span>
        </span>
        <span className="rounded bg-header-overlay/25 px-2 py-0.5 text-xs font-semibold shadow-[inset_0_-2px_0_currentColor]">Mail</span>
        <span className="px-2 py-0.5 text-xs">Kalender</span>
      </div>
      {/* Login page */}
      <div className="relative flex flex-col items-center gap-2 bg-accent px-4 py-5">
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

