/**
 * useInactivityLogout — MWA (Web Client)
 *
 * Reads inactivityTimeoutMinutes from the public config endpoint and logs
 * the user out automatically after X minutes without mouse/keyboard input.
 *
 * - 0 = disabled (no auto-logout)
 * - Warns 60 seconds before logout via toast
 * - Events that reset the timer: mousemove, mousedown, keydown, touchstart, scroll
 */

import { useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { useAuthStore } from '../store/auth.js';

const WARN_BEFORE_MS = 60_000; // 1 minute advance warning

export function useInactivityLogout() {
  const logout         = useAuthStore((s) => s.logout);
  const timeoutRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warnTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warnToastId    = useRef<string | null>(null);
  const limitMsRef     = useRef<number>(0); // 0 = disabled

  useEffect(() => {
    // 1. Load global setting
    // 2. Load personal user setting (overrides global if set)
    void Promise.all([
      fetch('/api/v1/admin/settings/public')
        .then((r) => r.ok ? r.json() as Promise<{ inactivityTimeoutMinutes?: number }> : null)
        .catch(() => null),
      fetch('/api/v1/user/preferences', {
        headers: { Authorization: `Bearer ${useAuthStore.getState().accessToken ?? ''}` },
      })
        .then((r) => r.ok ? r.json() as Promise<{ inactivityTimeoutMinutes: number | null; inactivityTimeoutMinutesGlobal: number }> : null)
        .catch(() => null),
    ]).then(([globalCfg, userPrefs]) => {
      let minutes: number;
      if (userPrefs?.inactivityTimeoutMinutes !== null && userPrefs?.inactivityTimeoutMinutes !== undefined) {
        // The user's personal setting takes precedence
        minutes = userPrefs.inactivityTimeoutMinutes;
      } else {
        // Global fallback
        minutes = globalCfg?.inactivityTimeoutMinutes ?? userPrefs?.inactivityTimeoutMinutesGlobal ?? 0;
      }
      limitMsRef.current = minutes > 0 ? minutes * 60_000 : 0;
      if (limitMsRef.current > 0) scheduleLogout();
    });
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

    // Advance warning (only if timeout is long enough)
    if (limit > WARN_BEFORE_MS * 2) {
      warnTimeoutRef.current = setTimeout(() => {
        const mins = Math.round(WARN_BEFORE_MS / 60_000);
        warnToastId.current = toast(
          `⚠ Automatischer Logout in ${mins} Minute${mins !== 1 ? 'n' : ''} — bewege die Maus oder drücke eine Taste`,
          { duration: WARN_BEFORE_MS, icon: '🔒', style: { maxWidth: 400 } },
        );
      }, limit - WARN_BEFORE_MS);
    }

    // Actual logout
    timeoutRef.current = setTimeout(() => {
      if (warnToastId.current) toast.dismiss(warnToastId.current);
      toast('Sitzung abgelaufen — du wurdest automatisch abgemeldet.', { icon: '🔒', duration: 5000 });
      logout();
      setTimeout(() => { window.location.href = '/login'; }, 800);
    }, limit);
  }
}
