import { useEffect, useState, type ReactNode } from 'react';
import { useThemeStore, resolveIsDark } from '../store/theme.js';
import { useBranding } from '../hooks/useBranding.js';
import { logoFor } from '../lib/branding.js';

/** Dark mode of the BCP (follows the system preference live in 'system' mode). */
export function useIsDark(): boolean {
  const theme = useThemeStore((s) => s.theme);
  const [isDark, setIsDark] = useState(() => resolveIsDark(theme));
  useEffect(() => {
    setIsDark(resolveIsDark(theme));
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setIsDark(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);
  return isDark;
}

/**
 * The uploaded brand logo (dark variant in dark mode when set) as <img alt={productName}>,
 * or `fallback` (the built-in icon) when no logo is uploaded or it fails to load.
 */
export function BrandLogo({ fallback, className = 'max-h-8 max-w-[10rem]', dark }: {
  fallback: ReactNode;
  className?: string;
  /** Force the light (false) or dark (true) logo instead of following the theme. */
  dark?: boolean;
}) {
  const { productName, assets } = useBranding();
  const themeDark = useIsDark();
  const src = logoFor(assets, dark ?? themeDark);
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return <>{fallback}</>;
  return <img src={src} alt={productName} className={`w-auto object-contain ${className}`} onError={() => setFailed(src)} />;
}
