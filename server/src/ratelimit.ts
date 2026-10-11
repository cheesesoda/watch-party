/**
 * Counts failed attempts per key (client IP) in a sliding window. Used to slow
 * down password guessing on /api/login.
 */
export class FailureLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    private maxFailures = 10,
    private windowMs = 15 * 60_000,
    private now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  /** Seconds until the key may try again, or 0 if it isn't blocked. */
  blockedFor(key: string): number {
    const list = this.recent(key);
    if (list.length < this.maxFailures) return 0;
    return Math.ceil((list[0] + this.windowMs - this.now()) / 1000);
  }

  fail(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.failures.set(key, list);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
