#!/usr/bin/env node

import "dotenv/config";
import { Command } from "commander";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { validateRequiredEnv } from "./config/env-validator.js";

const program = new Command()
  .name("forge")
  .description("Forge — Model-agnostic agent orchestration platform")
  .version("0.1.0")
  .argument("[workflow]", "Path to WORKFLOW.md", "WORKFLOW.md")
  .option("--logs-root <path>", "Directory for log files")
  .option("--port <number>", "HTTP server port", parseInt)
  .option("--log-level <level>", "Log level", "info")
  .option("--dry-run", "Show what would be dispatched without spawning agents")
  .option("--accept-risk", "Acknowledge unguarded agent execution")
  .action(async (workflowPath: string, options: Record<string, unknown>) => {
    const resolvedPath = resolve(workflowPath);

    if (!existsSync(resolvedPath)) {
      console.error(`Error: Workflow file not found: ${resolvedPath}`);
      process.exit(1);
    }

    // Parse and validate config
    const store = new WorkflowStore(resolvedPath);
    const { config, promptTemplate } = store.current();

    // Fail fast: verify all required env vars before doing anything else
    try {
      validateRequiredEnv(config);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`❌ ${msg}`);
      process.exit(1);
    }

    // Set up logger — when the TUI dashboard is active, redirect logs to file
    // so the dashboard and logger don't both write to stdout.
    const dashboardEnabled = config.observability.dashboard_enabled !== false;
    const explicitLogFile = options.logsRoot
      ? resolve(options.logsRoot as string, "forge.log")
      : undefined;
    const logFile =
      explicitLogFile ?? (dashboardEnabled ? resolve(tmpdir(), "forge.log") : undefined);

    const logger = createLogger({
      level: (options.logLevel as string) ?? "info",
      logFile,
      fileOnly: dashboardEnabled,
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

    if (!options.acceptRisk && !options.dryRun) {
      logger.error(
        "You must pass --accept-risk to acknowledge unguarded agent execution. Use --dry-run to preview without spawning agents.",
      );
      process.exit(1);
    }

    // Create agent adapter
    const agent = createAgent(config.agent.kind, { command: config.agent.command });

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
      sshConfigPath: config.workspace.ssh_config_path,
    });

    // Clean up workspaces for terminal issues before starting
    try {
      const terminalIssues = await tracker.fetchTerminalIssues(trackerConfig);
      for (const issue of terminalIssues) {
        const safeId = workspace.toSafeId(issue.identifier);
        const wsPath = resolve(config.workspace.root, safeId);
        if (existsSync(wsPath)) {
          logger.info(
            { identifier: issue.identifier, path: wsPath },
            "Cleaning up terminal workspace",
          );
          await workspace.removeWorkspace(wsPath);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn({ error: msg }, "Terminal workspace cleanup failed — continuing");
    }

    // Create and start orchestrator
    const orchestrator = new Orchestrator(
      tracker,
      agent,
      workspace,
      {
        pollIntervalMs: config.polling.interval_ms,
        maxConcurrentAgents: config.agent.max_concurrent_agents,
        maxTurns: config.agent.max_turns,
        turnTimeoutMs: config.agent.turn_timeout_ms,
        readTimeoutMs: config.agent.read_timeout_ms,
        approvalPolicy: config.agent.approval_policy,
        stallTimeoutSeconds: config.agent.stall_timeout_seconds,
        maxRetryAttempts: config.retry.max_attempts,
        maxRetryDelayMs: config.agent.max_retry_backoff_ms,
        retryBaseDelayMs: config.retry.base_delay_seconds * 1000,
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
        onEvent: (issueId, event) => {
          if (event.type === "tool_use") {
            logger.info({ issueId, tool: event.tool }, `Tool: ${event.tool}`);
          } else if (event.type === "usage") {
            logger.info(
              { issueId, input: event.inputTokens, output: event.outputTokens },
              `Tokens: ${event.inputTokens} in / ${event.outputTokens} out`,
            );
          }
        },
        onError: (issueId, error) => {
          logger.error({ issueId, error: error.message }, `Worker error for ${issueId}`);
        },
        onPollError: (error) => {
          logger.error({ error: error.message }, "Poll cycle error");
        },
      },
    );

    // HTTP Server
    let httpServer: import("node:http").Server | undefined;
    const port = (options.port as number | undefined) ?? config.server?.port;
    if (port !== undefined) {
      const { createForgeHttpServer } = await import("./server/index.js");
      httpServer = createForgeHttpServer({
        getSnapshot: () => orchestrator.getSnapshot(),
        getIssueSnapshot: (id) => orchestrator.getIssueSnapshot(id),
        triggerPoll: () => orchestrator.triggerPoll(),
      });
      const host = config.server?.host ?? "127.0.0.1";
      httpServer.on("error", (err) => {
        logger.error({ port, host, error: err.message }, "HTTP server failed to start");
        process.exit(1);
      });
      httpServer.listen(port, host);
      logger.info({ port, host }, `HTTP server listening on http://${host}:${port}`);
    }

    // TUI Dashboard
    let dashboard: { stop(): void } | undefined;
    if (config.observability.dashboard_enabled !== false) {
      const { Dashboard } = await import("./observability/dashboard.js");
      const dash = new Dashboard({ output: process.stdout });
      dash.start(config.observability.refresh_ms, () => orchestrator.getSnapshot(), port, logFile);
      dashboard = dash;
    }

    // Graceful shutdown
    const shutdown = async () => {
      dashboard?.stop();
      httpServer?.close();
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
