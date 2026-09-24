/** Token bucket: `capacity` tokens refilled continuously over one minute (Webflow allows 60 req/min). */
export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();
  private blockedUntil = 0;

  constructor(private readonly capacity = 60, private readonly perMinute = 60) {
    this.tokens = capacity;
  }

  private refill(now: number): void {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.lastRefill) / 60_000) * this.perMinute);
    this.lastRefill = now;
  }

  /** Resolves once a request may be sent. */
  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now < this.blockedUntil) {
        await sleep(this.blockedUntil - now);
        continue;
      }
      this.refill(now);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.perMinute) * 60_000));
    }
  }

  /** Called on a 429: pause every caller sharing this bucket and drain it. */
  penalize(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + ms);
    this.tokens = 0;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
