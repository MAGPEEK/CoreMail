/**
 * 9.4: this tab's role in the live-connection election (lib/tabLeader.ts) for
 * features that must run in ONE tab per browser — task reminders (toast and
 * reminder mail). hooks/useRealtime.ts attaches the running election; other
 * hooks ask `isLeader()`, listen for role changes and exchange application
 * messages with the other tabs. No imports — unit-tested with `node --test`.
 *
 * Without an attached election (logged out, or before the first one) this tab
 * is no leader and broadcasts go nowhere.
 */

/** Application message between tabs (lib/tabLeader.ts AppMessage). */
export interface TabMessage { t: string; [key: string]: unknown }

export interface TabElection {
  broadcast(message: TabMessage): void;
}

export interface TabRole {
  isLeader(): boolean;
  /** Sends a message to every other tab (dropped when no election is attached). */
  broadcast(message: TabMessage): void;
  /** Called when this tab becomes / stops being the leader; returns the unsubscribe. */
  onLeaderChange(fn: (isLeader: boolean) => void): () => void;
  /** Called for every message another tab broadcast; returns the unsubscribe. */
  onMessage(fn: (message: TabMessage) => void): () => void;
  /** useRealtime: the election of this tab (null when it ends — the tab is no leader then). */
  attach(election: TabElection | null): void;
  /** useRealtime: forwards the election's events (may come before attach). */
  leaderChanged(isLeader: boolean): void;
  received(message: TabMessage): void;
}

export function createTabRole(): TabRole {
  let election: TabElection | null = null;
  let leader = false;
  const leaderListeners = new Set<(isLeader: boolean) => void>();
  const messageListeners = new Set<(message: TabMessage) => void>();
  const each = <T>(set: Set<(v: T) => void>, v: T) => {
    for (const fn of [...set]) {
      try { fn(v); } catch (err) { console.error('tab role listener failed', err); }
    }
  };
  return {
    isLeader: () => leader,
    broadcast: (message) => election?.broadcast(message),
    onLeaderChange(fn) { leaderListeners.add(fn); return () => { leaderListeners.delete(fn); }; },
    onMessage(fn) { messageListeners.add(fn); return () => { messageListeners.delete(fn); }; },
    attach(next) {
      election = next;
      if (!next && leader) { leader = false; each(leaderListeners, false); }
    },
    leaderChanged(isLeader) {
      if (leader === isLeader) return;
      leader = isLeader;
      each(leaderListeners, isLeader);
    },
    received: (message) => each(messageListeners, message),
  };
}

/** The tab role of this page. */
export const tabRole: TabRole = createTabRole();
