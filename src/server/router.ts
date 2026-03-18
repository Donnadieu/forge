/**
 * HTTP server for the Forge orchestrator REST API.
 * Uses only node:http — zero external dependencies.
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import type { StateSnapshot, RunningSessionSnapshot } from "../observability/types.js";
import { renderDashboardHtml } from "./html.js";
import type { HttpServerDeps } from "./types.js";

// ---------------------------------------------------------------------------
// JSON helper
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Snapshot → snake_case transformers (SPEC 13.7.2)
// ---------------------------------------------------------------------------

function toRunningJson(s: RunningSessionSnapshot): Record<string, unknown> {
  return {
    issue_id: s.issueId,
    issue_identifier: s.identifier,
    state: s.state,
    session_id: s.sessionId,
    turn_count: s.turnCount,
    last_event: s.lastEvent,
    last_message: s.lastMessage,
    started_at: s.startedAt,
    last_event_at: s.lastEventAt,
    tokens: {
      input_tokens: s.tokens.input,
      output_tokens: s.tokens.output,
      total_tokens: s.tokens.total,
    },
    workspace_path: s.workspacePath,
    attempt: s.attempt,
    host: s.host,
  };
}

function toRetryJson(r: {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAt: string;
  error: string | null;
}): Record<string, unknown> {
  return {
    issue_id: r.issueId,
    issue_identifier: r.identifier,
    attempt: r.attempt,
    due_at: r.dueAt,
    error: r.error,
  };
}

function toStateJson(snap: StateSnapshot): Record<string, unknown> {
  return {
    generated_at: snap.generatedAt,
    counts: { running: snap.counts.running, retrying: snap.counts.retrying },
    running: snap.running.map(toRunningJson),
    retrying: snap.retrying.map(toRetryJson),
    codex_totals: {
      input_tokens: snap.codexTotals.inputTokens,
      output_tokens: snap.codexTotals.outputTokens,
      total_tokens: snap.codexTotals.totalTokens,
      seconds_running: snap.codexTotals.secondsRunning,
    },
    rate_limits: snap.rateLimits,
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleDashboard(deps: HttpServerDeps, res: ServerResponse): void {
  const snapshot = deps.getSnapshot();
  html(res, 200, renderDashboardHtml(snapshot));
}

function handleState(deps: HttpServerDeps, res: ServerResponse): void {
  const snapshot = deps.getSnapshot();
  json(res, 200, toStateJson(snapshot));
}

function handleIssue(deps: HttpServerDeps, identifier: string, res: ServerResponse): void {
  const snapshot = deps.getIssueSnapshot(identifier);
  if (snapshot === null) {
    json(res, 404, {
      error: {
        code: "issue_not_found",
        message: `No running session for identifier "${identifier}"`,
      },
    });
    return;
  }
  json(res, 200, toRunningJson(snapshot));
}

function handleRefresh(deps: HttpServerDeps, res: ServerResponse): void {
  deps.triggerPoll();
  json(res, 202, {
    queued: true,
    coalesced: false,
    requested_at: new Date().toISOString(),
    operations: ["poll", "reconcile"],
  });
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createForgeHttpServer(deps: HttpServerDeps): Server {
  return createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    const method = req.method ?? "GET";
    const url = rawUrl.split("?")[0];

    // CORS headers for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === "GET" && url === "/") {
      handleDashboard(deps, res);
    } else if (method === "GET" && url === "/api/v1/state") {
      handleState(deps, res);
    } else if (url === "/api/v1/refresh" && method === "POST") {
      handleRefresh(deps, res);
    } else if (url === "/api/v1/refresh") {
      json(res, 405, { error: { code: "method_not_allowed", message: `${method} not allowed` } });
    } else if (method === "GET" && url.startsWith("/api/v1/")) {
      let identifier: string;
      try {
        identifier = decodeURIComponent(url.slice("/api/v1/".length));
      } catch {
        json(res, 400, { error: { code: "bad_request", message: "Malformed URL encoding" } });
        return;
      }
      if (identifier.length === 0) {
        json(res, 404, { error: { code: "not_found", message: "Route not found" } });
      } else {
        handleIssue(deps, identifier, res);
      }
    } else if (url === "/api/v1/state" || url === "/api/v1/refresh" || url.startsWith("/api/v1/")) {
      json(res, 405, {
        error: {
          code: "method_not_allowed",
          message: `${method} not allowed`,
        },
      });
    } else {
      json(res, 404, { error: { code: "not_found", message: "Route not found" } });
    }
  });
}
