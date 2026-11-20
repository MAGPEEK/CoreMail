/**
 * Server → Health & Status: "CoreMail neu starten" (10.4.2).
 *
 * POST /api/v1/admin/servers/restart stops every CoreMail service; the
 * container's restart policy starts it again. The confirmation needs the
 * typed word (NEUSTART / RESTART) or the public host name; afterwards an
 * overlay polls GET /healthz every 2 s and reloads the page once CoreMail is
 * back (the session survives — the refresh cookie and the session row live in
 * PostgreSQL; a lost session ends on the login page via the normal guard).
 * Logic: lib/serverRestart.ts.
 */
import { useEffect, useId, useState } from 'react';
import { AlertTriangle, Loader2, Power, RefreshCw, X } from 'lucide-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { ApiError, errorMessage } from '../lib/errors.js';
import {
  RESTART_POLL_MS, healthResultOf, initialRestartState, nextRestartState, restartConfirmed, restartPolling,
  type HealthResult, type RestartPollState,
} from '../lib/serverRestart.js';
import { Can } from './Can.js';
import { Modal } from './Modal.js';
import { useT } from '../i18n/useT.js';

interface RestartInfo {
  available: boolean;
  reason?: string;
  expectedDowntimeSeconds: number;
  cooldownSeconds: number;
}

const HEALTH_TIMEOUT_MS = 5_000;

async function pollHealth(): Promise<HealthResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch('/healthz', { cache: 'no-store', signal: ctrl.signal });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not JSON (proxy error page) */ }
    return healthResultOf(res.status, body);
  } catch {
    return healthResultOf(null, null);
  } finally {
    clearTimeout(timer);
  }
}

export function ServerRestartCard({ publicHostname }: { publicHostname?: string | null }) {
  const t = useT();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restartStartedAt, setRestartStartedAt] = useState<number | null>(null);

  const info = useQuery<RestartInfo>({
    queryKey: ['server-restart-info'],
    queryFn: () => api.get<RestartInfo>('/admin/servers/restart'),
    staleTime: 60_000,
  });
  const unavailable = info.data ? !info.data.available : false;

  return (
    <div className="card space-y-3 border border-danger-line">
      <div className="flex items-center gap-2">
        <Power size={18} className="text-danger-fg shrink-0" />
        <h2 className="font-semibold text-fg">{t('srv_restart_title')}</h2>
      </div>
      <p className="text-sm text-fg-muted">{t('srv_restart_desc')}</p>
      <p className="text-xs text-fg-subtle">{t('srv_restart_policy_note')}</p>
      {unavailable && (
        <p role="status" className="text-xs text-warning-fg">{t('srv_restart_unavailable')}</p>
      )}
      <div>
        <Can area="servers" access="write">
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={unavailable || info.isLoading}
            className="btn-danger flex items-center gap-1.5 text-sm disabled:opacity-50"
          >
            <Power size={14} /> {t('srv_restart_button')}
          </button>
        </Can>
      </div>
      {confirmOpen && (
        <RestartConfirmDialog
          publicHostname={publicHostname ?? null}
          onClose={() => setConfirmOpen(false)}
          onStarted={() => { setConfirmOpen(false); setRestartStartedAt(Date.now()); }}
        />
      )}
      {restartStartedAt !== null && <RestartOverlay startedAt={restartStartedAt} />}
    </div>
  );
}

function RestartConfirmDialog({ publicHostname, onClose, onStarted }: {
  publicHostname: string | null;
  onClose: () => void;
  onStarted: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const inputId = useId();
  const hintId = useId();
  const [typed, setTyped] = useState('');
  const word = t('srv_restart_confirm_word');
  const confirmed = restartConfirmed(typed, word, publicHostname);

  const restart = useMutation({
    mutationFn: () => api.post<{ restarting: boolean; expectedDowntimeSeconds: number }>('/admin/servers/restart', {}),
    onSuccess: () => onStarted(),
  });
  const error = restart.error
    ? (restart.error instanceof ApiError && restart.error.status === 429 ? t('srv_restart_rate_limited') : errorMessage(restart.error))
    : null;

  const hint = publicHostname
    ? t('srv_restart_confirm_hint').replace('{word}', word).replace('{host}', publicHostname)
    : t('srv_restart_confirm_hint_word').replace('{word}', word);

  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      closeOnBackdrop={false}
      overlayClassName="fixed inset-0 bg-scrim/40 flex items-center justify-center z-50 p-4"
      className="bg-surface rounded-lg shadow-2xl w-full max-w-md p-6"
    >
      <div className="flex items-center justify-between mb-4">
        <h2 id={titleId} className="text-base font-semibold text-fg flex items-center gap-2">
          <AlertTriangle size={18} className="text-danger-fg" /> {t('srv_restart_confirm_title')}
        </h2>
        <button type="button" onClick={onClose} aria-label={t('action_close')} className="p-1 text-fg-subtle hover:text-fg-muted rounded">
          <X size={16} />
        </button>
      </div>
      <p className="text-sm text-fg-muted mb-4">{t('srv_restart_desc')}</p>
      <label htmlFor={inputId} className="block text-xs font-medium text-fg-muted mb-1">{t('srv_restart_confirm_label')}</label>
      <input
        id={inputId}
        aria-describedby={hintId}
        className="input w-full font-mono"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && confirmed && !restart.isPending) restart.mutate(); }}
        autoComplete="off"
        spellCheck={false}
        autoFocus
      />
      <p id={hintId} className="text-xs text-fg-subtle mt-1">{hint}</p>
      {error && (
        <p role="alert" className="text-xs text-danger-fg mt-3">{t('srv_restart_failed')}: {error}</p>
      )}
      <div className="flex justify-end gap-2 mt-5">
        <button type="button" onClick={onClose} className="btn-secondary text-sm">{t('action_cancel')}</button>
        <button
          type="button"
          onClick={() => restart.mutate()}
          disabled={!confirmed || restart.isPending}
          className="btn-danger flex items-center gap-1.5 text-sm disabled:opacity-50"
        >
          {restart.isPending ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
          {t('srv_restart_confirm_action')}
        </button>
      </div>
    </Modal>
  );
}

function RestartOverlay({ startedAt }: { startedAt: number }) {
  const t = useT();
  const titleId = useId();
  const [state, setState] = useState<RestartPollState>(() => initialRestartState(startedAt));
  const [now, setNow] = useState(() => Date.now());

  // elapsed-time display
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // sequential polling: the next request starts RESTART_POLL_MS after the previous answer
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current = initialRestartState(startedAt);
    const tick = async () => {
      const result = await pollHealth();
      if (stopped) return;
      current = nextRestartState(current, result, Date.now());
      setState(current);
      if (restartPolling(current)) timer = setTimeout(() => { void tick(); }, RESTART_POLL_MS);
    };
    timer = setTimeout(() => { void tick(); }, RESTART_POLL_MS);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [startedAt]);

  useEffect(() => {
    if (state.phase === 'done') window.location.reload();
  }, [state.phase]);

  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const status = state.phase === 'stopping' ? t('srv_restart_overlay_stopping')
    : state.phase === 'starting' ? t('srv_restart_overlay_starting')
    : state.phase === 'done' ? t('srv_restart_overlay_done')
    : t('srv_restart_timeout');

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim/70 p-4"
    >
      <div className="bg-surface rounded-lg shadow-2xl w-full max-w-md p-6 space-y-3 text-center">
        {state.phase === 'timeout'
          ? <AlertTriangle size={28} className="mx-auto text-danger-fg" />
          : <Loader2 size={28} className="mx-auto animate-spin text-accent-fg" />}
        <h2 id={titleId} className="text-base font-semibold text-fg">{t('srv_restart_overlay_title')}</h2>
        <p className={`text-sm ${state.phase === 'timeout' ? 'text-danger-fg' : 'text-fg-muted'}`} aria-live="polite">{status}</p>
        <p className="text-xs text-fg-subtle font-mono">{t('srv_restart_overlay_elapsed').replace('{s}', String(elapsed))}</p>
        {state.phase === 'timeout' && (
          <button type="button" onClick={() => window.location.reload()} className="btn-secondary inline-flex items-center gap-1.5 text-sm" autoFocus>
            <RefreshCw size={14} /> {t('srv_restart_reload')}
          </button>
        )}
      </div>
    </div>
  );
}
