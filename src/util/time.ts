/** Thrown by `sleep` when the abort signal fires before the delay elapses. */
export class AbortError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

/** Resolves after `ms`, or rejects with AbortError as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Rejects with `Error(label)` if `promise` has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Capped exponential backoff: initial, 2x, 4x, ... up to max. `attempt` starts at 0. */
export function backoffMs(attempt: number, initialMs: number, maxMs: number): number {
  const exp = Math.min(Math.max(0, attempt), 30);
  return Math.min(maxMs, initialMs * 2 ** exp);
}

/** Integer in [min, max], using `rng` (a function returning [0, 1)). */
export function randomInt(min: number, max: number, rng: () => number): number {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Local wall-clock time as HH:MM:SS, for terminal output. */
export function clock(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}
