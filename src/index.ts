#!/usr/bin/env node

import { Command } from "commander";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkflowStore } from "./config/watcher.js";
import { parseWorkflowFile } from "./config/loader.js";
import { WorkflowConfigSchema } from "./config/schema.js";
import { createTracker } from "./tracker/index.js";
import { createAgent } from "./agent/index.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createLogger } from "./observability/logger.js";
import { loadSkillsManifest } from "./worker/prompt-renderer.js";

const program = new Command()
  .name("forge")
  .description("Forge — Model-agnostic agent orchestration platform")
  .version("0.1.0")
  .argument("[workflow]", "Path to WORKFLOW.md", "WORKFLOW.md")
  .option("--logs-root <path>", "Directory for log files")
  .option("--port <number>", "HTTP server port", parseInt)
  .option("--log-level <level>", "Log level", "info")
  .option("--dry-run", "Show what would be dispatched without spawning agents")
  .action(async (workflowPath: string, options: Record<string, unknown>) => {
    const resolvedPath = resolve(workflowPath);

    if (!existsSync(resolvedPath)) {
      console.error(`Error: Workflow file not found: ${resolvedPath}`);
      process.exit(1);
    }

    // Parse and validate config
    const store = new WorkflowStore(resolvedPath);
    const { config, promptTemplate } = store.current();

    // Set up logger
    const logFile = options.logsRoot ? resolve(options.logsRoot as string, "forge.log") : undefined;

    const logger = createLogger({
      level: (options.logLevel as string) ?? "info",
      logFile,
    });

    logger.info({ workflowPath: resolvedPath }, "Starting Forge");
    logger.info(
      {
        tracker: config.tracker.kind,
        project: config.tracker.project_slug,
        maxAgents: config.agent.max_concurrent_agents,
        maxTurns: config.agent.max_turns,
      },
      "Configuration loaded",
    );

    // Create tracker with API key from environment
    const tracker = createTracker(config.tracker.kind, {
      apiKey: process.env.LINEAR_API_KEY,
    });

    const trackerConfig = {
      kind: config.tracker.kind,
      project_slug: config.tracker.project_slug,
      active_states: config.tracker.active_states,
      terminal_states: config.tracker.terminal_states,
    };

    // Dry-run: fetch candidates and show what would be dispatched, then exit
    if (options.dryRun) {
      try {
        const candidates = await tracker.fetchCandidates(trackerConfig);
        logger.info({ count: candidates.length }, "Dry-run: fetched candidates");
        for (const issue of candidates) {
          logger.info(
            { identifier: issue.identifier, priority: issue.priority, state: issue.state },
            `  ${issue.identifier}: ${issue.title}`,
          );
        }
        logger.info("Dry-run complete — no agents spawned");
        process.exit(0);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ error: msg }, "Dry-run failed");
        process.exit(1);
      }
    }

    // Create agent adapter
    const agent = createAgent(config.agent.kind);

    // Resolve skills directory relative to workflow file
    const workflowDir = dirname(resolvedPath);
    const skillsDir = config.workspace.skills_dir
      ? resolve(workflowDir, config.workspace.skills_dir)
      : undefined;
    const skillsManifest = skillsDir ? loadSkillsManifest(skillsDir) : undefined;

    // Build MCP servers config for agents (Linear tracker gets an MCP server)
    let mcpServers: Record<string, unknown> | undefined;
    if (config.tracker.kind === "linear") {
      const mcpServerPath = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "mcp",
        "linear-graphql-server.js",
      );
      mcpServers = {
        "forge-linear": {
          command: "node",
          args: [mcpServerPath],
          env: {
            LINEAR_API_KEY: process.env.LINEAR_API_KEY ?? "",
            LINEAR_ENDPOINT: "https://api.linear.app/graphql",
          },
        },
      };
    }

    // Create workspace manager
    const workspace = new WorkspaceManager({
      root: config.workspace.root,
      hooks: config.workspace.hooks,
      hookTimeoutMs: config.workspace.hooks.timeout_ms,
      skillsDir,
    });

    // Create and start orchestrator
    const orchestrator = new Orchestrator(
      tracker,
      agent,
      workspace,
      {
        pollIntervalMs: config.agent.poll_interval_seconds * 1000,
        maxConcurrentAgents: config.agent.max_concurrent_agents,
        maxTurns: config.agent.max_turns,
        stallTimeoutSeconds: config.agent.stall_timeout_seconds,
        maxRetryAttempts: config.retry.max_attempts,
        maxRetryDelayMs: config.retry.max_delay_seconds * 1000,
        trackerConfig,
        promptTemplate,
        mcpServers,
        skillsManifest,
      },
      {
        onDispatch: (issue) => {
          logger.info(
            { issueId: issue.id, identifier: issue.identifier },
            `Dispatching ${issue.identifier}: ${issue.title}`,
          );
        },
        onComplete: (issueId, result) => {
          logger.info(
            { issueId, turns: result.turns, tokens: result.tokens },
            `Completed ${issueId}`,
          );
        },
        onError: (issueId, error) => {
          logger.error({ issueId, error: error.message }, `Worker error for ${issueId}`);
        },
        onPollError: (error) => {
          logger.error({ error: error.message }, "Poll cycle error");
        },
      },
    );

    // Graceful shutdown
    const shutdown = async () => {
      logger.info("Shutting down...");
      await orchestrator.stop();
      logger.info("Forge stopped");
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    logger.info("Forge started — polling for issues");
    orchestrator.start();
  });

program
  .command("validate [workflow]")
  .description("Parse and validate WORKFLOW.md, report errors, then exit")
  .action((workflowPath = "WORKFLOW.md") => {
    const resolvedPath = resolve(workflowPath);

    if (!existsSync(resolvedPath)) {
      console.error(`Error: Workflow file not found: ${resolvedPath}`);
      process.exit(1);
    }

    try {
      const { config, promptTemplate } = parseWorkflowFile(resolvedPath);
      WorkflowConfigSchema.parse(config);
      if (!promptTemplate.trim()) {
        console.error("Warning: prompt template body is empty");
      }
      console.log(`Valid: ${resolvedPath}`);
      process.exit(0);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Invalid: ${msg}`);
      process.exit(1);
    }
  });

program.parse();
