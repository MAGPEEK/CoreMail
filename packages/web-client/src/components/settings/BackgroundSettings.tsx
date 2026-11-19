/**
 * 10.1: Einstellungen → Darstellung → Hintergrund — thumbnails "Keiner", the
 * eight built-in pictures (lib/backgroundPrefs.ts), the uploaded picture (with
 * "Entfernen") and "Eigenes Bild hochladen…" (JPEG / PNG ≤ 5 MB; the server
 * re-encodes it). A radio group: hovering or focusing a tile previews it live
 * behind the settings (useUiStore.backgroundPreview), choosing it saves the
 * roaming preference `appearance.background`. Without an own choice the
 * organisation default applies.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Check, ImagePlus, Trash2 } from 'lucide-react';
import { api, apiFetch } from '../../api/client.js';
import { usePreferences } from '../../store/preferences.js';
import { useUiStore, useThemeStore, resolveIsDark } from '../../store/ui.js';
import { useBranding } from '../../hooks/useBranding.js';
import { BACKGROUND_INFO_KEY, useUploadedBackground, useUploadedBackgroundUrl } from '../../hooks/useAppBackground.js';
import {
  BACKGROUND_FILE_TYPES, BUILTIN_BACKGROUND_IDS, BUILTIN_BACKGROUND_LABELS, backgroundFileError, builtinBackgroundUrl,
  parseBackgroundChoice, parseDefaultBackground, type BackgroundChoice,
} from '../../lib/backgroundPrefs.js';

async function uploadBackground(file: File): Promise<void> {
  const res = await apiFetch('/user/background', { method: 'PUT', body: file }, file.type);
  if (res.ok) return;
  const body = await res.json().catch(() => null) as { error?: string } | null;
  throw new Error(body?.error ?? `Bild konnte nicht gespeichert werden (HTTP ${res.status})`);
}

interface TileProps {
  choice: BackgroundChoice;
  label: string;
  checked: boolean;
  onChoose: (c: BackgroundChoice) => void;
  children: ReactNode;
}

/** One thumbnail: a native radio (keyboard: arrow keys in the group) with a live preview on hover / focus. */
function Tile({ choice, label, checked, onChoose, children }: TileProps) {
  const setPreview = useUiStore((s) => s.setBackgroundPreview);
  return (
    <label
      className="group relative flex flex-col gap-1.5 cursor-pointer"
      onMouseEnter={() => setPreview(choice)}
      onMouseLeave={() => setPreview(null)}
    >
      <input
        type="radio"
        name="webmail-background"
        value={choice}
        checked={checked}
        onChange={() => onChoose(choice)}
        onFocus={() => setPreview(choice)}
        onBlur={() => setPreview(null)}
        className="peer sr-only"
      />
      <span className={`relative block aspect-[16/10] rounded-lg overflow-hidden border-2 transition-all peer-focus-visible:ring-2 peer-focus-visible:ring-accent-fg peer-focus-visible:ring-offset-2 ${
        checked ? 'border-accent' : 'border-line group-hover:border-line-strong'
      }`}>
        {children}
        {checked && (
          <span className="absolute top-1.5 right-1.5 w-5 h-5 bg-accent rounded-full flex items-center justify-center shadow">
            <Check size={11} className="text-white" strokeWidth={3} aria-hidden="true" />
          </span>
        )}
      </span>
      <span className={`text-xs leading-tight ${checked ? 'text-accent-fg font-semibold' : 'text-fg-muted'}`}>{label}</span>
    </label>
  );
}

export function BackgroundSettings() {
  const qc = useQueryClient();
  const pref = usePreferences((s) => s.prefs.appearance.background);
  const update = usePreferences((s) => s.update);
  const setPreview = useUiStore((s) => s.setBackgroundPreview);
  const theme = useThemeStore((s) => s.theme);
  const dark = resolveIsDark(theme);
  const { defaultBackground } = useBranding();
  const { info } = useUploadedBackground();
  const customUrl = useUploadedBackgroundUrl(info?.version ?? null);
  const fileRef = useRef<HTMLInputElement>(null);

  // leaving the page ends a preview
  useEffect(() => () => setPreview(null), [setPreview]);

  const own = parseBackgroundChoice(pref);
  const current: BackgroundChoice = own ?? parseDefaultBackground(defaultBackground);
  const choose = (c: BackgroundChoice) => { setPreview(null); update({ appearance: { background: c } }); };
  const refresh = () => qc.invalidateQueries({ queryKey: BACKGROUND_INFO_KEY });

  const upload = useMutation({
    mutationFn: uploadBackground,
    onSuccess: async () => { await refresh(); choose('custom'); toast.success('Hintergrundbild gespeichert'); },
    onError: (err: Error) => toast.error(err.message),
  });
  const remove = useMutation({
    mutationFn: () => api.delete('/user/background'),
    onSuccess: async () => {
      if (own === 'custom') update({ appearance: { background: null } });
      await refresh();
      toast.success('Hintergrundbild entfernt');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const error = backgroundFileError(file);
    if (error) { toast.error(error); return; }
    upload.mutate(file);
  };

  return (
    <div className="space-y-3">
      <div>
        <p id="bg-heading" className="text-sm font-medium text-fg-muted">Hintergrund</p>
        <p className="text-xs text-fg-subtle mt-0.5">
          Bild hinter den Bereichen der Ansicht. Ohne eigene Auswahl gilt der Standard Ihrer Organisation.
        </p>
      </div>
      <div role="radiogroup" aria-labelledby="bg-heading" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <Tile choice="none" label="Keiner" checked={current === 'none'} onChoose={choose}>
          <span className="absolute inset-0 bg-canvas" />
        </Tile>
        {BUILTIN_BACKGROUND_IDS.map((id) => (
          <Tile key={id} choice={`builtin:${id}`} label={BUILTIN_BACKGROUND_LABELS[id]} checked={current === `builtin:${id}`} onChoose={choose}>
            <img src={builtinBackgroundUrl(id, dark)} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
          </Tile>
        ))}
        {info && (
          <div className="relative">
            <Tile choice="custom" label="Eigenes Bild" checked={current === 'custom'} onChoose={choose}>
              {customUrl
                ? <img src={customUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
                : <span className="absolute inset-0 bg-surface-2" />}
            </Tile>
            <button
              type="button"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="mt-1 inline-flex items-center gap-1 text-xs text-danger-fg hover:underline disabled:opacity-60"
            >
              <Trash2 size={12} aria-hidden="true" /> Entfernen
            </button>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={upload.isPending}
            className="aspect-[16/10] rounded-lg border-2 border-dashed border-line-strong text-fg-muted hover:text-fg hover:bg-surface-2 flex flex-col items-center justify-center gap-1 text-xs disabled:opacity-60"
          >
            <ImagePlus size={18} aria-hidden="true" />
            {upload.isPending ? 'Wird hochgeladen …' : 'Eigenes Bild hochladen…'}
          </button>
          <span className="text-xs text-fg-subtle">JPEG oder PNG, höchstens 5 MB</span>
        </div>
      </div>
      {own !== null && (
        <button type="button" onClick={() => update({ appearance: { background: null } })} className="text-xs text-accent-fg hover:underline">
          Standard der Organisation verwenden
        </button>
      )}
      <input ref={fileRef} type="file" accept={BACKGROUND_FILE_TYPES.join(',')} hidden onChange={onPick} />
    </div>
  );
}
