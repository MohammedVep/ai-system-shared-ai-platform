export type TelecomDispatchRequest = {
  channel: "sms" | "voice" | "whatsapp";
  to: string;
  message: string;
};

export type TelecomDispatchResult = {
  provider: string;
  messageId: string;
  accepted: boolean;
};

export interface TelecomProvider {
  providerId: string;
  send(request: TelecomDispatchRequest): Promise<TelecomDispatchResult>;
}

class MockTelecomProvider implements TelecomProvider {
  providerId = "mock-telecom";

  async send(request: TelecomDispatchRequest): Promise<TelecomDispatchResult> {
    const messageId = `msg_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
    return {
      provider: this.providerId,
      messageId,
      accepted: request.to.length > 0
    };
  }
}

export class TelecomService {
  constructor(private readonly provider: TelecomProvider = new MockTelecomProvider()) {}

  async dispatch(request: TelecomDispatchRequest): Promise<TelecomDispatchResult> {
    return this.provider.send(request);
  }

  providerName(): string {
    return this.provider.providerId;
  }
}
