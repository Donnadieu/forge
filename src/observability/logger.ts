import pino from "pino";

export type Logger = pino.Logger;

export interface LoggerOptions {
  level?: string;
  logFile?: string;
  pretty?: boolean;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? "info";

  if (opts.logFile) {
    // Write structured JSON to file, pretty to console
    return pino({
      level,
      transport: {
        targets: [
          {
            target: "pino-pretty",
            level,
            options: { colorize: true },
          },
          {
            target: "pino/file",
            level: "debug",
            options: { destination: opts.logFile, mkdir: true },
          },
        ],
      },
    });
  }

  if (opts.pretty !== false) {
    return pino({
      level,
      transport: {
        target: "pino-pretty",
        options: { colorize: true },
      },
    });
  }

  return pino({ level });
}

/**
 * Create a child logger with issue context.
 */
export function issueLogger(
  logger: Logger,
  issueId: string,
  identifier: string
): Logger {
  return logger.child({ issueId, identifier });
}

/**
 * Create a child logger with session context.
 */
export function sessionLogger(
  logger: Logger,
  sessionId: string,
  workspace: string
): Logger {
  return logger.child({ sessionId, workspace });
}
