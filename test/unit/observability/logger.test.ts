import { describe, it, expect } from "vitest";
import { createLogger, issueLogger, sessionLogger } from "../../../src/observability/logger.js";

describe("createLogger", () => {
  it("creates a logger with default settings", () => {
    const logger = createLogger({ pretty: false });
    expect(logger).toBeDefined();
    expect(logger.level).toBe("info");
  });

  it("creates a logger with custom level", () => {
    const logger = createLogger({ level: "debug", pretty: false });
    expect(logger.level).toBe("debug");
  });

  it("creates child loggers with context", () => {
    const logger = createLogger({ pretty: false });
    const child = issueLogger(logger, "issue-1", "MT-42");
    expect(child).toBeDefined();

    const session = sessionLogger(logger, "session-1", "/tmp/ws");
    expect(session).toBeDefined();
  });
});
