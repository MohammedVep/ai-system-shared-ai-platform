import type { JSONSchema, ToolAdapter, ToolContext, ToolResult } from "../../contracts/sdk.js";

export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolValidationError";
  }
}

export class ToolExecutionError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

export class ToolBroker {
  private readonly registry = new Map<string, Map<string, ToolAdapter>>();

  registerTool(projectId: string, adapter: ToolAdapter): void {
    const projectTools = this.registry.get(projectId) ?? new Map<string, ToolAdapter>();
    projectTools.set(adapter.toolId, adapter);
    this.registry.set(projectId, projectTools);
  }

  listTools(projectId: string): ToolAdapter[] {
    const scoped = this.registry.get(projectId);
    if (scoped && scoped.size > 0) {
      return [...scoped.values()];
    }
    return [...(this.registry.get("default")?.values() ?? [])];
  }

  getTool(projectId: string, toolId: string): ToolAdapter | undefined {
    return this.registry.get(projectId)?.get(toolId) ?? this.registry.get("default")?.get(toolId);
  }

  async executeTool(projectId: string, toolId: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const adapter = this.getTool(projectId, toolId);
    if (!adapter) {
      throw new ToolExecutionError(`Tool not found: ${toolId}`, false);
    }

    const inputValidation = validateSchema(adapter.inputSchema, input);
    if (!inputValidation.valid) {
      throw new ToolValidationError(`Invalid tool input for ${toolId}: ${inputValidation.errors.join("; ")}`);
    }

    const result = await this.runWithTimeout(() => adapter.execute(input, ctx), adapter.timeoutMs);

    const outputValidation = validateSchema(adapter.outputSchema, result.output);
    if (!outputValidation.valid) {
      throw new ToolValidationError(`Invalid tool output for ${toolId}: ${outputValidation.errors.join("; ")}`);
    }

    return result;
  }

  private async runWithTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<T>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new ToolExecutionError(`Tool execution timeout after ${timeoutMs}ms`, true));
          }, timeoutMs);
        })
      ]);
    } catch (error) {
      if (error instanceof ToolExecutionError || error instanceof ToolValidationError) {
        throw error;
      }
      throw new ToolExecutionError(
        error instanceof Error ? error.message : "Unknown tool error",
        true,
      );
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}

type ValidationResult = {
  valid: boolean;
  errors: string[];
};

const validateSchema = (schema: JSONSchema, value: unknown, path = "$"): ValidationResult => {
  const errors: string[] = [];
  const type = schema.type as string | undefined;

  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { valid: false, errors: [`${path} must be object`] };
    }

    const obj = value as Record<string, unknown>;
    const properties = (schema.properties as Record<string, JSONSchema> | undefined) ?? {};
    const required = (schema.required as string[] | undefined) ?? [];

    for (const key of required) {
      if (!(key in obj)) {
        errors.push(`${path}.${key} is required`);
      }
    }

    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in obj) {
        const child = validateSchema(propSchema, obj[key], `${path}.${key}`);
        if (!child.valid) {
          errors.push(...child.errors);
        }
      }
    }

    const additionalProperties = schema.additionalProperties as boolean | undefined;
    if (additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) {
          errors.push(`${path}.${key} is not allowed`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  if (type === "array") {
    if (!Array.isArray(value)) {
      return { valid: false, errors: [`${path} must be array`] };
    }
    const itemSchema = schema.items as JSONSchema | undefined;
    if (itemSchema) {
      value.forEach((item, idx) => {
        const child = validateSchema(itemSchema, item, `${path}[${idx}]`);
        if (!child.valid) {
          errors.push(...child.errors);
        }
      });
    }
    return { valid: errors.length === 0, errors };
  }

  if (type === "string" && typeof value !== "string") {
    return { valid: false, errors: [`${path} must be string`] };
  }

  if (type === "number" && typeof value !== "number") {
    return { valid: false, errors: [`${path} must be number`] };
  }

  if (type === "boolean" && typeof value !== "boolean") {
    return { valid: false, errors: [`${path} must be boolean`] };
  }

  return { valid: true, errors: [] };
};
