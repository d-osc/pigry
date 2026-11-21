/** Cooperative pause switch for an agent turn. The turn runner awaits `wait()`
 * before each step (model request / tool call), so pausing lets the step in
 * flight finish and holds the next one until `resume()` — or an abort. */
export class PauseGate {
  private paused = false;
  private waiters: Array<() => void> = [];

  get isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  /** Resolves immediately unless paused; rejects with the signal's reason on abort. */
  wait(signal?: AbortSignal): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let wake: () => void = () => undefined;
      const onAbort = () => {
        this.waiters = this.waiters.filter((entry) => entry !== wake);
        reject(signal?.reason);
      };
      wake = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.push(wake);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
