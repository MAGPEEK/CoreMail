import type { ReactNode } from 'react';
import { useBranding } from '../hooks/useBranding.js';
import { BrandLogo } from './BrandLogo.js';

/**
 * Page frame of the public pages (login, password reset): branded background
 * (login background image with a scrim, else the accent colour), the card, and
 * the footer with the branding links and "Powered by CoreMail".
 */
export function AuthShell({ children, className = '' }: { children: ReactNode; className?: string }) {
  const { assets } = useBranding();
  const bg = assets.loginBackground;
  return (
    <div className={`relative min-h-screen flex flex-col items-center justify-center p-4 bg-accent ${className}`}>
      {bg ? (
        <>
          <div aria-hidden="true" className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${bg}")` }} />
          {/* scrim: keeps the footer and the card edge readable on any photo */}
          <div aria-hidden="true" className="absolute inset-0 bg-scrim/40" />
        </>
      ) : (
        <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-br from-transparent to-scrim/40" />
      )}
      <div className="relative w-full flex flex-col items-center">
        {children}
        <AuthFooter />
      </div>
    </div>
  );
}

/** Footer links + "Powered by CoreMail" on a solid surface (text >= 4.5:1 on any background). */
export function AuthFooter() {
  const { footerLinks, showPoweredBy } = useBranding();
  if (footerLinks.length === 0 && !showPoweredBy) return null;
  return (
    <footer className="mt-4 max-w-sm w-full flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-md bg-surface px-3 py-1.5 text-xs text-fg-muted">
      {footerLinks.length > 0 && (
        <nav aria-label="Rechtliche Hinweise" className="flex flex-wrap justify-center gap-x-3 gap-y-1">
          {footerLinks.map((l) => (
            <a key={`${l.label}|${l.url}`} href={l.url} target="_blank" rel="noopener noreferrer"
              className="text-accent-fg underline-offset-2 hover:underline focus-visible:underline">
              {l.label}
            </a>
          ))}
        </nav>
      )}
      {showPoweredBy && <span>Powered by CoreMail</span>}
    </footer>
  );
}

/**
 * Brand block at the top of an auth card: the uploaded logo (or `icon`), the
 * product name, a subtitle and — when `withLoginText` — the login text of the
 * branding (plain text, rendered as a text node).
 */
export function AuthBrandHeader({ icon, subtitle, withLoginText = false }: {
  icon: ReactNode;
  subtitle: ReactNode;
  withLoginText?: boolean;
}) {
  const { productName, loginText } = useBranding();
  return (
    <div className="mb-6">
      <div className="flex items-center justify-center gap-2">
        <BrandLogo className="max-h-10 max-w-[8rem]" fallback={icon} />
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-fg break-words">{productName}</h1>
          <p className="text-xs text-fg-subtle">{subtitle}</p>
        </div>
      </div>
      {withLoginText && loginText.trim() && (
        <p className="mt-3 text-sm text-fg-muted text-center whitespace-pre-line break-words">{loginText}</p>
      )}
    </div>
  );
}
