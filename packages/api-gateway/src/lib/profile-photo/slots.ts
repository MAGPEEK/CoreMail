/**
 * A counting semaphore for async tasks (pure, no I/O): at most `capacity` tasks
 * run at once, the others wait in arrival order. A slot is handed straight to
 * the next waiting task when one finishes — also when it failed.
 */
export interface Slots {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Tasks running now. */
  readonly active: number;
  /** Tasks waiting for a slot. */
  readonly waiting: number;
}

export function createSlots(capacity: number): Slots {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
  let active = 0;
  const queue: Array<() => void> = [];
  const release = (): void => {
    const next = queue.shift();
    if (next) next(); // the slot passes on; `active` stays the same
    else active--;
  };
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active < capacity) active++;
      else await new Promise<void>((resolve) => queue.push(resolve));
      try {
        return await task();
      } finally {
        release();
      }
    },
    get active() { return active; },
    get waiting() { return queue.length; },
  };
}
