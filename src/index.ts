#!/usr/bin/env node

import { Command } from "commander";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { parseWorkflowFile } from "./config/loader.js";
import { resolveConfig } from "./config/resolver.js";
import { WorkflowStore } from "./config/watcher.js";
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
    const logFile = options.logsRoot
      ? resolve(options.logsRoot as string, "forge.log")
      : undefined;

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
      "Configuration loaded"
    );

    // Create tracker
    const tracker = createTracker(config.tracker.kind, {
      endpoint: undefined, // LinearTracker uses config
      apiKey: undefined,
    });

    // Create agent adapter
    const agent = createAgent(config.agent.kind);

    // Resolve skills directory relative to workflow file
    const workflowDir = dirname(resolvedPath);
    const skillsDir = config.workspace.skills_dir
      ? resolve(workflowDir, config.workspace.skills_dir)
      : undefined;
    const skillsManifest = skillsDir
      ? loadSkillsManifest(skillsDir)
      : undefined;

    // Create workspace manager
    const workspace = new WorkspaceManager({
      root: config.workspace.root,
      hooks: config.workspace.hooks,
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
        trackerConfig: {
          kind: config.tracker.kind,
          project_slug: config.tracker.project_slug,
          active_states: config.tracker.active_states,
          terminal_states: config.tracker.terminal_states,
        },
        promptTemplate,
        skillsManifest,
      },
      {
        onDispatch: (issue) => {
          logger.info(
            { issueId: issue.id, identifier: issue.identifier },
            `Dispatching ${issue.identifier}: ${issue.title}`
          );
        },
        onComplete: (issueId, result) => {
          logger.info(
            { issueId, turns: result.turns, tokens: result.tokens },
            `Completed ${issueId}`
          );
        },
        onError: (issueId, error) => {
          logger.error(
            { issueId, error: error.message },
            `Worker error for ${issueId}`
          );
        },
      }
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

program.parse();
