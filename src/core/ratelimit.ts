import { sleep } from './util.ts';

interface Lane {
  tail: Promise<unknown>;
  last: number;
}

export class RateLimiter {
  private lanes = new Map<string, Lane>();
  readonly minIntervalMs: number;
  constructor(minIntervalMs: number) {
    this.minIntervalMs = minIntervalMs;
  }
  schedule<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { tail: Promise.resolve(), last: 0 };
      this.lanes.set(key, lane);
    }
    const current = lane;
    const run = async () => {
      const wait = current.last + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        current.last = Date.now();
      }
    };
    const result = current.tail.then(run, run);
    current.tail = result.catch(() => {});
    return result;
  }
}
