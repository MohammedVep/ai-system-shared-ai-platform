export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds = 60,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

type WindowState = {
  count: number;
  startedAt: number;
};

export type RateLimitResult = {
  remaining: number;
  resetAtEpochMs: number;
};

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, WindowState>();

  constructor(private readonly defaultLimitPerMinute: number) {}

  check(identity: string, options?: { bucket?: string; limitPerMinute?: number }): RateLimitResult {
    const now = Date.now();
    const limit = options?.limitPerMinute ?? this.defaultLimitPerMinute;
    const bucket = options?.bucket ?? "default";
    const windowKey = `${bucket}:${identity}`;

    const state = this.windows.get(windowKey);
    if (!state || now - state.startedAt > 60_000) {
      this.windows.set(windowKey, {
        count: 1,
        startedAt: now
      });
      return {
        remaining: Math.max(limit - 1, 0),
        resetAtEpochMs: now + 60_000
      };
    }

    if (state.count >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((60_000 - (now - state.startedAt)) / 1_000));
      throw new RateLimitError("Rate limit exceeded", retryAfterSeconds);
    }

    state.count += 1;
    this.windows.set(windowKey, state);
    return {
      remaining: Math.max(limit - state.count, 0),
      resetAtEpochMs: state.startedAt + 60_000
    };
  }
}
