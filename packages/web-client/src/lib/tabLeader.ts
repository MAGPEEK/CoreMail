/**
 * 9.4: one live connection per browser — leader election between the open
 * webmail tabs over a BroadcastChannel. No imports — unit-tested with
 * `node --test` against an in-memory channel and a fake clock.
 *
 *   - A starting tab says `hello` and listens for a short election window. A
 *     leader answers every `hello` with a heartbeat, so the newcomer follows.
 *     Nobody answering → the tab claims leadership.
 *   - The leader sends a heartbeat every `heartbeatMs`; a follower that hears
 *     none for `timeoutMs` (leader tab crashed / frozen) starts an election.
 *   - Two tabs claiming at once: the one with the lower id keeps it, the
 *     other steps down when it hears the heartbeat.
 *   - A closing leader says `resign`, followers elect a new one at once.
 *   - No BroadcastChannel (old browser, some private modes) → every tab is
 *     its own leader (one connection per tab, as before 9.4).
 *
 * Application messages (`event`, `logout`, …) travel over the same channel and
 * are handed to `onMessage` in every OTHER tab.
 */

export interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close(): void;
}

/** Message between tabs that is not part of the election. */
export interface AppMessage { t: string; [key: string]: unknown }

type ElectionMessage =
  | { t: 'hello'; id: string }
  | { t: 'leader'; id: string }
  | { t: 'resign'; id: string };

export interface TabLeaderOptions {
  id: string;
  /** null = no BroadcastChannel → this tab leads alone. */
  channel: ChannelLike | null;
  onLeaderChange(isLeader: boolean): void;
  onMessage?(message: AppMessage): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  electionMs?: number;
  heartbeatMs?: number;
  timeoutMs?: number;
}

export interface TabLeader {
  isLeader(): boolean;
  /** Sends an application message to every other tab. */
  broadcast(message: AppMessage): void;
  /** Leaves the election (a leader resigns). */
  stop(): void;
}

const ELECTION_TYPES = new Set(['hello', 'leader', 'resign']);

function isElection(m: unknown): m is ElectionMessage {
  return !!m && typeof m === 'object' && ELECTION_TYPES.has((m as { t?: unknown }).t as string)
    && typeof (m as { id?: unknown }).id === 'string';
}

function isApp(m: unknown): m is AppMessage {
  return !!m && typeof m === 'object' && typeof (m as { t?: unknown }).t === 'string' && !isElection(m);
}

export function startTabLeader(opts: TabLeaderOptions): TabLeader {
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const electionMs = opts.electionMs ?? 400;
  const heartbeatMs = opts.heartbeatMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const channel = opts.channel;

  let leader = false;
  let stopped = false;
  let timer: unknown = null;

  const setLeader = (next: boolean) => {
    if (leader === next) return;
    leader = next;
    opts.onLeaderChange(next);
  };
  const schedule = (fn: () => void, ms: number) => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { timer = null; fn(); }, ms);
  };
  const post = (m: ElectionMessage | AppMessage) => { try { channel?.postMessage(m); } catch { /* channel closed */ } };

  const heartbeat = () => {
    if (stopped || !leader) return;
    post({ t: 'leader', id: opts.id });
    schedule(heartbeat, heartbeatMs);
  };
  const claim = () => {
    if (stopped) return;
    setLeader(true);
    heartbeat();
  };
  const follow = () => {
    setLeader(false);
    schedule(elect, timeoutMs); // no heartbeat for that long → the leader is gone
  };
  function elect() {
    if (stopped) return;
    schedule(claim, electionMs); // before posting: an answer may arrive synchronously
    post({ t: 'hello', id: opts.id });
  }

  const onElection = (m: ElectionMessage) => {
    if (m.id === opts.id) return;
    if (m.t === 'hello') {
      if (leader) post({ t: 'leader', id: opts.id }); // the newcomer follows us
    } else if (m.t === 'leader') {
      if (leader && opts.id < m.id) post({ t: 'leader', id: opts.id }); // we keep it, tell them
      else follow();
    } else if (!leader) {
      schedule(elect, 0); // resign
    }
  };

  if (!channel) {
    claim();
  } else {
    channel.onmessage = (ev) => {
      if (stopped) return;
      if (isElection(ev.data)) onElection(ev.data);
      else if (isApp(ev.data)) opts.onMessage?.(ev.data);
    };
    elect();
  }

  return {
    isLeader: () => leader,
    broadcast: (message) => { if (!stopped) post(message); },
    stop: () => {
      if (stopped) return;
      if (leader) post({ t: 'resign', id: opts.id });
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (channel) { channel.onmessage = null; try { channel.close(); } catch { /* already closed */ } }
      setLeader(false);
    },
  };
}
