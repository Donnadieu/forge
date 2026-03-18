import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { request, type Server } from "node:http";
import { createForgeHttpServer } from "../../../src/server/router.js";
import type { HttpServerDeps } from "../../../src/server/types.js";
import type { StateSnapshot, RunningSessionSnapshot } from "../../../src/observability/types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeRunningSession(
  overrides: Partial<RunningSessionSnapshot> = {},
): RunningSessionSnapshot {
  return {
    issueId: "issue-1",
    identifier: "PROJ-123",
    state: "In Progress",
    sessionId: "sess-abc",
    turnCount: 3,
    lastEvent: "tool_use",
    lastMessage: "Running tests...",
    startedAt: "2025-01-15T10:00:00.000Z",
    lastEventAt: "2025-01-15T10:05:00.000Z",
    tokens: { input: 1000, output: 500, total: 1500 },
    workspacePath: "/tmp/ws",
    attempt: 1,
    host: null,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    generatedAt: "2025-01-15T10:05:30.000Z",
    counts: { running: 1, retrying: 0 },
    running: [makeRunningSession()],
    retrying: [],
    codexTotals: {
      inputTokens: 5000,
      outputTokens: 2500,
      totalTokens: 7500,
      secondsRunning: 120,
    },
    rateLimits: null,
    ...overrides,
  };
}

function createMockDeps(overrides: Partial<HttpServerDeps> = {}): HttpServerDeps {
  return {
    getSnapshot: () => makeSnapshot(),
    getIssueSnapshot: (identifier: string) => {
      if (identifier === "PROJ-123") return makeRunningSession();
      return null;
    },
    triggerPoll: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function httpRequest(
  port: number,
  method: string,
  path: string,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, method, path }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body,
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Forge HTTP server", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const deps = createMockDeps();
    server = createForgeHttpServer(deps);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("unexpected address type");
    port = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET / returns HTML dashboard with 200", async () => {
    const res = await httpRequest(port, "GET", "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<!DOCTYPE html>");
    expect(res.body).toContain("Forge");
    expect(res.body).toContain("PROJ-123");
  });

  it("GET /api/v1/state returns valid JSON with correct snake_case shape", async () => {
    const res = await httpRequest(port, "GET", "/api/v1/state");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("generated_at");
    expect(body).toHaveProperty("counts");
    expect(body.counts).toEqual({ running: 1, retrying: 0 });
    expect(body).toHaveProperty("running");
    expect(body).toHaveProperty("retrying");
    expect(body).toHaveProperty("codex_totals");
    expect(body).toHaveProperty("rate_limits", null);

    // Check running session snake_case keys
    const session = body.running[0];
    expect(session).toHaveProperty("issue_id", "issue-1");
    expect(session).toHaveProperty("issue_identifier", "PROJ-123");
    expect(session).toHaveProperty("session_id", "sess-abc");
    expect(session).toHaveProperty("turn_count", 3);
    expect(session).toHaveProperty("last_event", "tool_use");
    expect(session).toHaveProperty("last_message", "Running tests...");
    expect(session).toHaveProperty("started_at");
    expect(session).toHaveProperty("last_event_at");
    expect(session.tokens).toEqual({
      input_tokens: 1000,
      output_tokens: 500,
      total_tokens: 1500,
    });

    // Check codex_totals snake_case keys
    expect(body.codex_totals).toEqual({
      input_tokens: 5000,
      output_tokens: 2500,
      total_tokens: 7500,
      seconds_running: 120,
    });
  });

  it("GET /api/v1/PROJ-123 returns issue detail for known identifier", async () => {
    const res = await httpRequest(port, "GET", "/api/v1/PROJ-123");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("issue_id", "issue-1");
    expect(body).toHaveProperty("issue_identifier", "PROJ-123");
    expect(body).toHaveProperty("turn_count", 3);
    expect(body.tokens).toHaveProperty("input_tokens", 1000);
  });

  it("GET /api/v1/UNKNOWN returns 404 with error JSON", async () => {
    const res = await httpRequest(port, "GET", "/api/v1/UNKNOWN");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body.error).toHaveProperty("code", "issue_not_found");
    expect(body.error.message).toContain("UNKNOWN");
  });

  it("POST /api/v1/refresh returns 202 with queued response", async () => {
    const res = await httpRequest(port, "POST", "/api/v1/refresh");
    expect(res.status).toBe(202);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("queued", true);
    expect(body).toHaveProperty("coalesced", false);
    expect(body).toHaveProperty("requested_at");
    expect(body.operations).toEqual(["poll", "reconcile"]);
  });

  it("DELETE /api/v1/state returns 405 method not allowed", async () => {
    const res = await httpRequest(port, "DELETE", "/api/v1/state");
    expect(res.status).toBe(405);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body.error).toHaveProperty("code", "method_not_allowed");
    expect(body.error.message).toContain("DELETE");
  });

  it("GET /unknown returns 404", async () => {
    const res = await httpRequest(port, "GET", "/unknown");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body.error).toHaveProperty("code", "not_found");
  });

  it("sets CORS headers on all responses", async () => {
    const res = await httpRequest(port, "GET", "/api/v1/state");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("OPTIONS requests return 204", async () => {
    const res = await httpRequest(port, "OPTIONS", "/api/v1/state");
    expect(res.status).toBe(204);
  });

  it("calls triggerPoll when POST /api/v1/refresh is hit", async () => {
    let pollTriggered = false;
    const deps = createMockDeps({
      triggerPoll: () => {
        pollTriggered = true;
      },
    });

    const testServer = createForgeHttpServer(deps);
    await new Promise<void>((resolve) => {
      testServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = testServer.address();
    if (addr === null || typeof addr === "string") throw new Error("bad addr");
    const testPort = addr.port;

    await httpRequest(testPort, "POST", "/api/v1/refresh");
    expect(pollTriggered).toBe(true);

    await new Promise<void>((resolve, reject) => {
      testServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 400 for malformed percent-encoded URLs", async () => {
    const res = await httpRequest(port, "GET", "/api/v1/%ZZ");
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body.error).toHaveProperty("code", "bad_request");
  });

  it("strips query strings before routing", async () => {
    const res = await httpRequest(port, "GET", "/api/v1/state?ts=123");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("generated_at");
  });

  it("handles URL-encoded identifiers", async () => {
    const encodedId = encodeURIComponent("PROJ-123");
    const res = await httpRequest(port, "GET", `/api/v1/${encodedId}`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("issue_identifier", "PROJ-123");
  });

  it("returns retrying entries in snake_case format", async () => {
    const deps = createMockDeps({
      getSnapshot: () =>
        makeSnapshot({
          counts: { running: 0, retrying: 1 },
          running: [],
          retrying: [
            {
              issueId: "issue-2",
              identifier: "PROJ-456",
              attempt: 2,
              dueAt: "2025-01-15T10:10:00.000Z",
              error: "timeout",
            },
          ],
        }),
    });

    const testServer = createForgeHttpServer(deps);
    await new Promise<void>((resolve) => {
      testServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = testServer.address();
    if (addr === null || typeof addr === "string") throw new Error("bad addr");
    const testPort = addr.port;

    const res = await httpRequest(testPort, "GET", "/api/v1/state");
    const body = JSON.parse(res.body);

    expect(body.retrying).toHaveLength(1);
    expect(body.retrying[0]).toEqual({
      issue_id: "issue-2",
      issue_identifier: "PROJ-456",
      attempt: 2,
      due_at: "2025-01-15T10:10:00.000Z",
      error: "timeout",
    });

    await new Promise<void>((resolve, reject) => {
      testServer.close((err) => (err ? reject(err) : resolve()));
    });
  });
});
