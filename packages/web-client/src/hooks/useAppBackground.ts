/**
 * 10.1: the background picture behind the panes (Einstellungen → Darstellung →
 * Hintergrund). Resolves the roaming preference `appearance.background` against
 * the organisation default (branding) and the uploaded image, and yields what
 * the app body paints: nothing, a built-in SVG (light / dark variant) or the
 * uploaded JPEG as a blob: URL (fetched with the Authorization header — never a
 * token in a URL). A hovered / focused tile in the settings shows as a live
 * preview (`useUiStore.backgroundPreview`).
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, fetchBlob } from '../api/client.js';
import { useBranding } from './useBranding.js';
import { usePreferences } from '../store/preferences.js';
import { useUiStore, useThemeStore, resolveIsDark } from '../store/ui.js';
import { builtinBackgroundUrl, resolveBackground, type ResolvedBackground } from '../lib/backgroundPrefs.js';
import { rasterImageType } from '../lib/imageTypes.js';

export const BACKGROUND_INFO_KEY = ['user-background'] as const;

export interface UserBackgroundInfo { version: string; updatedAt: string | null }

/** GET /user/background/info — the uploaded image's version, or null. */
export function useUploadedBackground(): { info: UserBackgroundInfo | null; loaded: boolean } {
  const { data, isSuccess } = useQuery({
    queryKey: BACKGROUND_INFO_KEY,
    queryFn: () => api.get<{ background: UserBackgroundInfo | null }>('/user/background/info'),
    staleTime: 5 * 60_000,
  });
  return { info: data?.background ?? null, loaded: isSuccess };
}

/** blob: URL of the uploaded image (one per version; revoked when the version changes). */
export function useUploadedBackgroundUrl(version: string | null): string | null {
  const { data: blob } = useQuery({
    queryKey: [...BACKGROUND_INFO_KEY, 'image', version ?? ''],
    queryFn: async () => {
      const b = await fetchBlob('/user/background');
      return rasterImageType(b.type) === 'image/jpeg' ? b : null;
    },
    enabled: !!version,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) { setUrl(null); return; }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return version ? url : null;
}

export interface AppBackground {
  resolved: ResolvedBackground;
  /** CSS url of the picture, null without one. */
  imageUrl: string | null;
}

/** Whether the app is dark right now (follows the system while the theme is "system"). */
function useIsDark(): boolean {
  const theme = useThemeStore((s) => s.theme);
  const [dark, setDark] = useState(() => resolveIsDark(theme));
  useEffect(() => {
    setDark(resolveIsDark(theme));
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setDark(resolveIsDark(theme));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);
  return dark;
}

export function useAppBackground(): AppBackground {
  const pref = usePreferences((s) => s.prefs.appearance.background);
  const preview = useUiStore((s) => s.backgroundPreview);
  const { defaultBackground } = useBranding();
  const { info } = useUploadedBackground();
  const customUrl = useUploadedBackgroundUrl(info?.version ?? null);
  const dark = useIsDark();
  const resolved = resolveBackground(preview ?? pref, defaultBackground, !!info);
  const imageUrl = resolved.kind === 'builtin' ? builtinBackgroundUrl(resolved.id, dark)
    : resolved.kind === 'custom' ? customUrl : null;
  return { resolved: imageUrl ? resolved : { kind: 'none' }, imageUrl };
}
