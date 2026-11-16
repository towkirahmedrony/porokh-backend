/**
 * Bounded concurrency guard for expensive external calls.
 *
 * Question extraction holds a 90-second Gemini request and a large base64 body
 * per call. Without a limit, a handful of concurrent importers can exhaust the
 * instance's memory and the provider's quota, and every queued request keeps
 * its parsed body alive while it waits.
 *
 * This is deliberately small: one counter, a FIFO of waiters, and a bounded
 * wait. It is process-local, which matches the rest of the in-process controls
 * in this backend (rate limiting, dashboard cache) and needs no new service.
 */
export class SemaphoreBusyError extends Error {
  constructor(message = 'Too many requests are already in progress') {
    super(message);
    this.name = 'SemaphoreBusyError';
  }
}

export type Semaphore = {
  /** Resolves with a release function, or rejects when the wait budget expires. */
  acquire: () => Promise<() => void>;
  /** Number of permits currently held. */
  inUse: () => number;
  /** Number of callers waiting for a permit. */
  waiting: () => number;
};

export const createSemaphore = (permits: number, maxWaitMs: number): Semaphore => {
  if (!Number.isInteger(permits) || permits <= 0) {
    throw new Error('createSemaphore requires a positive integer permit count');
  }

  let inUse = 0;
  const waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inUse -= 1;

      const next = waiters.shift();
      if (!next) return;

      clearTimeout(next.timer);
      inUse += 1;
      next.resolve(makeRelease());
    };
  };

  const acquire = (): Promise<() => void> => {
    if (inUse < permits) {
      inUse += 1;
      return Promise.resolve(makeRelease());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new SemaphoreBusyError());
        }, maxWaitMs),
      };

      waiters.push(waiter);
    });
  };

  return {
    acquire,
    inUse: () => inUse,
    waiting: () => waiters.length,
  };
};
