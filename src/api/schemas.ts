import { z } from "zod";

export const createSessionSchema = z.object({
  project_id: z.string().min(1),
  user_id: z.string().min(1),
  channel: z.string().min(1),
  metadata: z.record(z.string()).optional()
});

export const postMessageSchema = z.object({
  message: z.string().min(1),
  context_refs: z.array(z.string()).optional(),
  tool_mode: z.enum(["auto", "required", "none"]).default("auto"),
  response_mode: z.enum(["stream", "sync"]).default("stream")
});

export const feedbackSchema = z.object({
  run_id: z.string().min(1),
  project_id: z.string().min(1),
  rating: z.enum(["up", "down"]),
  labels: z.array(z.string()).default([]),
  note: z.string().max(1000).optional()
});

export const canaryConfigSchema = z.object({
  enabled: z.boolean().optional(),
  traffic_percent: z.number().int().min(0).max(100).optional(),
  candidate_model: z.string().min(1).optional(),
  rollback_thresholds: z.object({
    max_error_rate_delta: z.number().positive().optional(),
    max_latency_multiplier: z.number().positive().optional(),
    min_samples: z.number().int().positive().optional()
  }).optional()
});

export const onboardingProjectSchema = z.object({
  project_id: z.string().min(1),
  legacy_endpoint: z.string().min(1),
  adapter_tools: z.array(z.string()).default([]),
  status: z.enum(["registered", "migrating", "pilot_live"]).optional()
});

export const legacyMessageSchema = z.object({
  user_id: z.string().min(1),
  message: z.string().min(1),
  context_refs: z.array(z.string()).optional(),
  tool_mode: z.enum(["auto", "required", "none"]).default("auto"),
  response_mode: z.enum(["stream", "sync"]).default("stream")
});
