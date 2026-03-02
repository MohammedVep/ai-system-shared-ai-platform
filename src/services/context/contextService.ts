import type { ContextChunk, ContextProvider } from "../../contracts/sdk.js";
import { InMemoryStore } from "../../store/inMemoryStore.js";
import { newId } from "../../utils/id.js";
import { neutralizePromptInjection, redactPii } from "../policy/guardrails.js";

export class ContextService {
  private readonly providers = new Map<string, ContextProvider>();

  constructor(private readonly store: InMemoryStore) {}

  registerProvider(provider: ContextProvider): void {
    this.providers.set(provider.providerId, provider);
  }

  async buildContext(params: {
    sessionId: string;
    query: string;
    contextRefs?: string[];
    providerIds?: string[];
  }): Promise<ContextChunk[]> {
    const chunks: ContextChunk[] = [];

    const session = this.store.getSession(params.sessionId);
    if (session) {
      const latest = session.messages.slice(-6);
      for (const message of latest) {
        chunks.push({
          id: newId(),
          source: "session_history",
          content: this.sanitize(message.content),
          score: 0.8
        });
      }
    }

    for (const ref of params.contextRefs ?? []) {
      chunks.push({
        id: newId(),
        source: "context_ref",
        content: this.sanitize(ref),
        score: 0.7
      });
    }

    const activeProviders = params.providerIds
      ? params.providerIds.map((id) => this.providers.get(id)).filter(Boolean)
      : [...this.providers.values()];

    for (const provider of activeProviders) {
      if (!provider) {
        continue;
      }
      const providerChunks = await provider.fetch(params.sessionId, params.query, 4);
      for (const chunk of providerChunks) {
        chunks.push({
          ...chunk,
          content: this.sanitize(chunk.content)
        });
      }
    }

    return chunks.slice(0, 20);
  }

  private sanitize(content: string): string {
    return redactPii(neutralizePromptInjection(content));
  }
}
