import type { RunEvent } from "../../domain/types.js";

export class NetPulseService {
  private delivered = 0;
  private failed = 0;

  constructor(private readonly endpoint?: string) {}

  async publish(event: RunEvent): Promise<void> {
    if (!this.endpoint) {
      return;
    }

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(event)
      });
      if (!response.ok) {
        this.failed += 1;
        return;
      }
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
