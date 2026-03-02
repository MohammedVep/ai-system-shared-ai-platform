import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyOptions } from "jose";
import type { Env } from "../config/env.js";
import { retryTransient } from "../utils/retry.js";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export type AuthContext = {
  projectId: string;
  userId: string;
  scopes: string[];
  authType: "anonymous" | "api_key" | "jwt";
  subject?: string;
};

const asStringClaim = (payload: JWTPayload, claimName: string): string | undefined => {
  const value = payload[claimName as keyof JWTPayload];
  return typeof value === "string" ? value : undefined;
};

const parseScopes = (payload: JWTPayload): string[] => {
  const scopeValue = payload.scope;
  const scopes = typeof scopeValue === "string" ? scopeValue.split(" ").filter(Boolean) : [];
  const groups = payload["cognito:groups"];
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (typeof group === "string") {
        scopes.push(group);
      }
    }
  }
  return [...new Set(scopes)];
};

export class AuthService {
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;
  private readonly jwtVerifyOptions: JWTVerifyOptions;

  constructor(private readonly env: Env) {
    if (env.cognitoRegion && env.cognitoUserPoolId) {
      const issuer = env.jwtIssuer ?? `https://cognito-idp.${env.cognitoRegion}.amazonaws.com/${env.cognitoUserPoolId}`;
      this.jwtVerifyOptions = {
        issuer,
        audience: env.jwtAudience
      };
      this.jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
      return;
    }

    this.jwtVerifyOptions = {
      issuer: env.jwtIssuer,
      audience: env.jwtAudience
    };
  }

  async authorize(input: {
    requestedProjectId?: string;
    apiKey?: string;
    authorizationHeader?: string;
    fallbackUserId?: string;
  }): Promise<AuthContext> {
    const strategy = this.resolveStrategy();

    const apiProject = this.authorizeApiKey(input.apiKey);
    const jwtContext = await this.authorizeJwt(input.authorizationHeader, input.requestedProjectId);

    if (strategy === "api_key" && !apiProject) {
      throw new AuthError("Missing or invalid API key");
    }
    if (strategy === "jwt" && !jwtContext) {
      throw new AuthError("Missing or invalid JWT bearer token");
    }
    if (strategy === "hybrid" && !apiProject && !jwtContext) {
      throw new AuthError("Authentication required (API key or JWT)");
    }

    const projectId = jwtContext?.projectId ?? apiProject ?? input.requestedProjectId ?? "unscoped";
    if (input.requestedProjectId && projectId !== input.requestedProjectId) {
      throw new AuthError("Project mismatch for authenticated identity");
    }

    if (jwtContext) {
      return jwtContext;
    }

    return {
      projectId,
      userId: input.fallbackUserId ?? "anonymous",
      scopes: [],
      authType: apiProject ? "api_key" : "anonymous"
    };
  }

  private resolveStrategy(): "none" | "api_key" | "jwt" | "hybrid" {
    if (this.env.requireApiKey && this.env.authMode === "none") {
      return "api_key";
    }
    return this.env.authMode;
  }

  private authorizeApiKey(apiKey?: string): string | undefined {
    if (!apiKey) {
      return undefined;
    }
    const mappedProject = this.env.apiKeys[apiKey];
    if (!mappedProject) {
      throw new AuthError("Invalid API key");
    }
    return mappedProject;
  }

  private async authorizeJwt(
    authorizationHeader: string | undefined,
    requestedProjectId?: string,
  ): Promise<AuthContext | undefined> {
    if (!authorizationHeader) {
      return undefined;
    }

    const [scheme, token] = authorizationHeader.split(" ");
    if (!scheme || scheme.toLowerCase() !== "bearer" || !token) {
      throw new AuthError("Malformed Authorization header");
    }

    if (!this.jwks && !this.env.jwtSharedSecret) {
      throw new AuthError("JWT authentication is not configured");
    }

    const payload = await this.verifyJwtPayload(token);
    const tokenProject = asStringClaim(payload, this.env.jwtProjectClaim) ?? requestedProjectId ?? "unscoped";
    const tokenUser = asStringClaim(payload, this.env.jwtUserClaim) ?? payload.sub;

    if (!tokenUser) {
      throw new AuthError("JWT missing user claim");
    }

    return {
      projectId: tokenProject,
      userId: tokenUser,
      scopes: parseScopes(payload),
      authType: "jwt",
      subject: payload.sub
    };
  }

  private async verifyJwtPayload(token: string): Promise<JWTPayload> {
    const verify = async (): Promise<JWTPayload> => {
      if (this.jwks) {
        const verified = await jwtVerify(token, this.jwks, this.jwtVerifyOptions);
        return verified.payload;
      }

      const secret = this.env.jwtSharedSecret;
      if (!secret) {
        throw new AuthError("JWT secret is not configured");
      }
      const key = new TextEncoder().encode(secret);
      const verified = await jwtVerify(token, key, this.jwtVerifyOptions);
      return verified.payload;
    };

    try {
      return await retryTransient(
        verify,
        {
          retries: this.env.retryTransient,
          baseDelayMs: this.env.retryBaseDelayMs,
          maxDelayMs: this.env.retryMaxDelayMs
        },
        (error) => {
          if (!(error instanceof Error)) {
            return false;
          }
          const message = error.message.toLowerCase();
          return message.includes("fetch") || message.includes("network") || message.includes("timeout");
        },
      );
    } catch (error) {
      throw new AuthError(error instanceof Error ? error.message : "JWT validation failed");
    }
  }
}
