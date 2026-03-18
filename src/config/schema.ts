import { z } from "zod";

export const WorkflowConfigSchema = z.object({
  tracker: z.object({
    kind: z.enum(["linear", "github", "jira"]),
    project_slug: z.string(),
    active_states: z.array(z.string()),
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
        })
        .default({}),
    })
    .default({}),
  agent: z
    .object({
      kind: z.enum(["claude", "codex", "custom"]).default("claude"),
      max_concurrent_agents: z.number().default(10),
      max_turns: z.number().default(20),
      poll_interval_seconds: z.number().default(30),
      stall_timeout_seconds: z.number().default(300),
      approval_policy: z.string().default("on-request"),
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
