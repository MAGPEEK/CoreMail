/**
 * Container restart from the BCP (10.4.2) — pure logic of the "CoreMail neu
 * starten" card (components/ServerRestartCard.tsx): the typed confirmation and
 * the state machine of the overlay that polls GET /healthz until the restarted
 * container answers.
 */

/** Poll interval of the overlay. */
export const RESTART_POLL_MS = 2_000;
/** After this the overlay gives up and points to `docker compose ps`. */
export const RESTART_TIMEOUT_MS = 180_000;

/**
 * The confirm button enables only when the admin typed the confirmation word
 * (exact, surrounding blanks ignored) or the public host name (host names are
 * case-insensitive).
 */
export function restartConfirmed(input: string, word: string, publicHostname?: string | null): boolean {
  const typed = input.trim();
  if (typed === '') return false;
  if (typed === word) return true;
  const host = (publicHostname ?? '').trim().toLowerCase();
  return host !== '' && typed.toLowerCase() === host;
}

/**
 * stopping — the old container may still answer for a moment (the trigger
 *            follows the response after ~1 s), so a healthy answer here does
 *            NOT mean "back";
 * starting — at least one poll failed: the container is down / booting;
 * done     — healthy again after having been down → reload the page;
 * timeout  — not back within RESTART_TIMEOUT_MS.
 */
export type RestartPhase = 'stopping' | 'starting' | 'done' | 'timeout';

export interface RestartPollState {
  phase: RestartPhase;
  startedAt: number;
  /** Whole seconds since the restart was confirmed. */
  elapsedSec: number;
}

export type HealthResult = 'healthy' | 'unhealthy';

export function initialRestartState(now: number): RestartPollState {
  return { phase: 'stopping', startedAt: now, elapsedSec: 0 };
}

export function nextRestartState(
  state: RestartPollState, result: HealthResult, now: number, timeoutMs = RESTART_TIMEOUT_MS,
): RestartPollState {
  if (state.phase === 'done' || state.phase === 'timeout') return state;
  const elapsedSec = Math.max(0, Math.floor((now - state.startedAt) / 1000));
  if (result === 'healthy' && state.phase === 'starting') return { ...state, phase: 'done', elapsedSec };
  if (now - state.startedAt >= timeoutMs) return { ...state, phase: 'timeout', elapsedSec };
  if (result === 'unhealthy') return { ...state, phase: 'starting', elapsedSec };
  return { ...state, elapsedSec };
}

/** A poll counts as healthy only for a 2xx /healthz answer with `ok: true`. */
export function healthResultOf(status: number | null, body: unknown): HealthResult {
  if (status === null || status < 200 || status >= 300) return 'unhealthy';
  return typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true ? 'healthy' : 'unhealthy';
}

/** Should the overlay keep polling? */
export function restartPolling(state: RestartPollState): boolean {
  return state.phase === 'stopping' || state.phase === 'starting';
}
