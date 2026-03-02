export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

type WindowState = {
  count: number;
  startedAt: number;
};

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, WindowState>();

  constructor(private readonly limitPerMinute: number) {}

  check(identity: string): void {
    const now = Date.now();
    const state = this.windows.get(identity);

    if (!state || now - state.startedAt > 60_000) {
      this.windows.set(identity, {
        count: 1,
        startedAt: now
      });
      return;
    }

    if (state.count >= this.limitPerMinute) {
      throw new RateLimitError("Rate limit exceeded");
    }

    state.count += 1;
    this.windows.set(identity, state);
  }
}
