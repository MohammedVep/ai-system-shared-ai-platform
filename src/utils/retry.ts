export const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export type RetryConfig = {
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
};

const normalizeConfig = (input: number | RetryConfig): Required<RetryConfig> => {
  if (typeof input === "number") {
    return {
      retries: input,
      baseDelayMs: 200,
      maxDelayMs: 5_000,
      jitterRatio: 0.2
    };
  }
  return {
    retries: input.retries,
    baseDelayMs: input.baseDelayMs ?? 200,
    maxDelayMs: input.maxDelayMs ?? 5_000,
    jitterRatio: input.jitterRatio ?? 0.2
  };
};

export const retryTransient = async <T>(
  fn: () => Promise<T>,
  retryConfig: number | RetryConfig,
  isTransient: (error: unknown) => boolean,
): Promise<T> => {
  const config = normalizeConfig(retryConfig);
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= config.retries || !isTransient(error)) {
        throw error;
      }
      const rawDelay = Math.min(config.baseDelayMs * 2 ** attempt, config.maxDelayMs);
      const jitterMax = rawDelay * config.jitterRatio;
      const jitter = Math.random() * jitterMax;
      const backoffMs = Math.floor(rawDelay + jitter);
      await sleep(backoffMs);
      attempt += 1;
    }
  }
};
