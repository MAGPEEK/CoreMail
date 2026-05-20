/**
 * useInactivityLogout — MWA (Web Client)
 *
 * Liest inactivityTimeoutMinutes aus dem Public-Config-Endpoint und meldet
 * den Benutzer nach X Minuten ohne Maus-/Tastatureingabe automatisch ab.
 *
 * - 0 = deaktiviert (kein auto-logout)
 * - Warnt 60 Sekunden vor dem Logout via Toast
 * - Events die den Timer zurücksetzen: mousemove, mousedown, keydown, touchstart, scroll
 */

import { useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { useAuthStore } from '../store/auth.js';

const WARN_BEFORE_MS = 60_000; // 1 Minute Vorwarnung

export function useInactivityLogout() {
  const logout         = useAuthStore((s) => s.logout);
  const timeoutRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warnTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warnToastId    = useRef<string | null>(null);
  const limitMsRef     = useRef<number>(0); // 0 = deaktiviert

  useEffect(() => {
    // Public-Config laden (kein Auth nötig)
    void fetch('/api/v1/admin/settings/public')
      .then((r) => r.ok ? r.json() as Promise<{ inactivityTimeoutMinutes?: number }> : null)
      .then((cfg) => {
        const minutes = cfg?.inactivityTimeoutMinutes ?? 0;
        limitMsRef.current = minutes > 0 ? minutes * 60_000 : 0;
        if (limitMsRef.current > 0) scheduleLogout();
      })
      .catch(() => { /* Fehler ignorieren — kein auto-logout */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const reset = () => {
      if (limitMsRef.current === 0) return;
      if (warnToastId.current) {
        toast.dismiss(warnToastId.current);
        warnToastId.current = null;
      }
      scheduleLogout();
    };

    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    document.addEventListener('visibilitychange', reset);

    return () => {
      events.forEach((e) => window.removeEventListener(e, reset));
      document.removeEventListener('visibilitychange', reset);
      clearTimeouts();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearTimeouts() {
    if (timeoutRef.current)     clearTimeout(timeoutRef.current);
    if (warnTimeoutRef.current) clearTimeout(warnTimeoutRef.current);
  }

  function scheduleLogout() {
    clearTimeouts();
    const limit = limitMsRef.current;
    if (limit === 0) return;

    // Vorwarnung (nur wenn Timeout ausreichend lang)
    if (limit > WARN_BEFORE_MS * 2) {
      warnTimeoutRef.current = setTimeout(() => {
        const mins = Math.round(WARN_BEFORE_MS / 60_000);
        warnToastId.current = toast(
          `⚠ Automatischer Logout in ${mins} Minute${mins !== 1 ? 'n' : ''} — bewege die Maus oder drücke eine Taste`,
          { duration: WARN_BEFORE_MS, icon: '🔒', style: { maxWidth: 400 } },
        );
      }, limit - WARN_BEFORE_MS);
    }

    // Eigentlicher Logout
    timeoutRef.current = setTimeout(() => {
      if (warnToastId.current) toast.dismiss(warnToastId.current);
      toast('Sitzung abgelaufen — du wurdest automatisch abgemeldet.', { icon: '🔒', duration: 5000 });
      logout();
      setTimeout(() => { window.location.href = '/login'; }, 800);
    }, limit);
  }
}
