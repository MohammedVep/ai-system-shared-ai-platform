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
