/**
 * Tokens-per-minute throttle.
 *
 * The binding constraint on Groq's free tier is **TPM (8,000), not RPM (30)** —
 * at 30 requests a minute you would average ~267 tokens each, so request
 * serialisation alone does not keep you under the limit. This throttles on the
 * dimension that actually runs out.
 *
 * Harmless on a paid key: raise `GROQ_TOKENS_PER_MINUTE` and it effectively
 * stops applying. That asymmetry is why it is built now — a throttle on a fast
 * account costs nothing, while no throttle on a free account stalls the
 * pipeline in 429s.
 *
 * In-process only. Multiple `extract` replicas would each get their own budget;
 * with EXTRACT_CONCURRENCY defaulting to 2 and one replica that is fine, and a
 * shared limiter would want Redis.
 */
export class TokenBucket {
  private spentInWindow = 0;
  private windowStart = Date.now();

  constructor(private readonly tokensPerMinute: number) {}

  /** Resolves once `tokens` can be spent without exceeding the budget. */
  async take(tokens: number): Promise<void> {
    for (;;) {
      const elapsed = Date.now() - this.windowStart;

      if (elapsed >= 60_000) {
        this.windowStart = Date.now();
        this.spentInWindow = 0;
      }

      if (this.spentInWindow + tokens <= this.tokensPerMinute) {
        this.spentInWindow += tokens;
        return;
      }

      // A single request larger than the whole budget would wait forever.
      // Let it through and let the API be the authority on whether it fits.
      if (tokens > this.tokensPerMinute && this.spentInWindow === 0) {
        this.spentInWindow += tokens;
        return;
      }

      await sleep(60_000 - elapsed + 50);
    }
  }

  /**
   * Corrects the window with the real usage the API reported. The estimate
   * that `take()` reserved is derived from character count and will drift.
   */
  reconcile(estimated: number, actual: number): void {
    this.spentInWindow = Math.max(0, this.spentInWindow - estimated + actual);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
