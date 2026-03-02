import type { RunEvent } from "../../domain/types.js";
import { retryTransient } from "../../utils/retry.js";

export class NetPulseService {
  private delivered = 0;
  private failed = 0;

  constructor(
    private readonly endpoint?: string,
    private readonly retryConfig: { retries: number; baseDelayMs: number; maxDelayMs: number } = {
      retries: 2,
      baseDelayMs: 150,
      maxDelayMs: 1_000
    },
  ) {}

  async publish(event: RunEvent): Promise<void> {
    if (!this.endpoint) {
      return;
    }

    try {
      await retryTransient(
        async () => {
          const response = await fetch(this.endpoint!, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(event)
          });
          if (!response.ok) {
            throw new Error(`netpulse_http_${response.status}`);
          }
        },
        {
          retries: this.retryConfig.retries,
          baseDelayMs: this.retryConfig.baseDelayMs,
          maxDelayMs: this.retryConfig.maxDelayMs
        },
        (error) => {
          const message = error instanceof Error ? error.message : "";
          return message.includes("timeout") || message.includes("netpulse_http_5") || message.includes("fetch");
        },
      );
      this.delivered += 1;
    } catch {
      this.failed += 1;
    }
  }

  status(): { endpoint?: string; delivered: number; failed: number } {
    return {
      endpoint: this.endpoint,
      delivered: this.delivered,
      failed: this.failed
    };
  }
}
