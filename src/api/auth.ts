import type { Env } from "../config/env.js";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class AuthService {
  constructor(private readonly env: Env) {}

  authorize(requestedProjectId: string, apiKey?: string): string {
    if (!this.env.requireApiKey) {
      return requestedProjectId;
    }

    if (!apiKey) {
      throw new AuthError("Missing API key");
    }

    const mappedProject = this.env.apiKeys[apiKey];
    if (!mappedProject) {
      throw new AuthError("Invalid API key");
    }

    if (mappedProject !== requestedProjectId) {
      throw new AuthError("Project mismatch for API key");
    }

    return mappedProject;
  }
}
