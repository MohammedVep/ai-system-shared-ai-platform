export const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const retryTransient = async <T>(
  fn: () => Promise<T>,
  retries: number,
  isTransient: (error: unknown) => boolean,
): Promise<T> => {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries || !isTransient(error)) {
        throw error;
      }
      const backoffMs = 200 * 2 ** attempt;
      await sleep(backoffMs);
      attempt += 1;
    }
  }
};
