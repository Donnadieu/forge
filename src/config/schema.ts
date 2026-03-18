import { z } from "zod";

export const WorkflowConfigSchema = z.object({
  tracker: z.object({
    kind: z.enum(["linear", "github", "jira"]),
    project_slug: z.string(),
    endpoint: z.string().optional(),
    api_key: z.string().optional(),
    active_states: z.array(z.string()).default(["Todo", "In Progress"]),
    terminal_states: z.array(z.string()).default(["Done", "Closed", "Cancelled"]),
  }),
  workspace: z
    .object({
      root: z.string().default("~/forge-workspaces"),
      hooks: z
        .object({
          after_create: z.string().optional(),
          before_run: z.string().optional(),
          after_run: z.string().optional(),
          before_remove: z.string().optional(),
          timeout_ms: z.number().default(60000),
        })
        .default({}),
      skills_dir: z.string().optional(),
    })
    .default({}),
  agent: z
    .object({
      kind: z.enum(["claude", "codex", "custom"]).default("claude"),
      command: z.string().optional(),
      max_concurrent_agents: z.number().default(10),
      max_concurrent_agents_by_state: z.record(z.string(), z.number()).default({}),
      max_turns: z.number().default(20),
      turn_timeout_ms: z.number().default(3_600_000),
      read_timeout_ms: z.number().default(5_000),
      stall_timeout_seconds: z.number().default(300),
      approval_policy: z.string().default("on-request"),
      max_retry_backoff_ms: z.number().default(300_000),
    })
    .default({}),
  polling: z
    .object({
      interval_ms: z.number().default(30_000),
    })
    .default({}),
  retry: z
    .object({
      max_attempts: z.number().default(5),
      base_delay_seconds: z.number().default(10),
      max_delay_seconds: z.number().default(300),
    })
    .default({}),
});

export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;
