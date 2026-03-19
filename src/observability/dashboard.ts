/**
 * TUI status dashboard using ANSI escape codes.
 * Layer 0 — only imports from ./types.js (intra-module).
 * No new npm dependencies. No console.log.
 */

import type { StateSnapshot } from "./types.js";

export class Dashboard {
  private output: NodeJS.WritableStream;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { output: NodeJS.WritableStream }) {
    this.output = opts.output;
  }

  start(
    intervalMs: number,
    snapshotFn: () => StateSnapshot,
    httpPort?: number,
    logFile?: string,
  ): void {
    this.render(snapshotFn(), httpPort, logFile);
    this.intervalId = setInterval(() => this.render(snapshotFn(), httpPort, logFile), intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  render(snapshot: StateSnapshot, httpPort?: number, logFile?: string): void {
    const lines: string[] = [];
    lines.push("\x1b[2J\x1b[H"); // clear screen + cursor home

    // Header
    lines.push(
      bold(cyan("Forge v0.1.0")) +
        dim(` — ${snapshot.counts.running} running, ${snapshot.counts.retrying} retrying`),
    );
    lines.push("");

    // Running sessions table
    if (snapshot.running.length > 0) {
      lines.push(bold("Running Sessions"));
      lines.push(dim("  Issue         State          Age      Tokens In/Out     Turn  Last Event"));
      lines.push(
        dim("  ─────────────────────────────────────────────────────────────────────────"),
      );
      for (const s of snapshot.running) {
        const age = formatAge(s.startedAt);
        const tokens = `${formatNumber(s.tokens.input)}/${formatNumber(s.tokens.output)}`;
        lines.push(
          `  ${pad(s.identifier, 13)} ${pad(s.state, 14)} ${pad(age, 8)} ${pad(tokens, 17)} ${pad(String(s.turnCount), 5)} ${s.lastEvent}`,
        );
      }
      lines.push("");
    } else {
      lines.push(dim("  No running sessions"));
      lines.push("");
    }

    // Retry queue
    if (snapshot.retrying.length > 0) {
      lines.push(bold("Retry Queue"));
      lines.push(dim("  Issue         Attempt  Due In    Error"));
      lines.push(dim("  ──────────────────────────────────────────────────────"));
      for (const r of snapshot.retrying) {
        const dueIn = formatAge(r.dueAt);
        const error = r.error ? r.error.slice(0, 40) : "";
        lines.push(
          `  ${pad(r.identifier, 13)} ${pad(String(r.attempt), 8)} ${pad(dueIn, 9)} ${error}`,
        );
      }
      lines.push("");
    }

    // Token totals
    lines.push(bold("Totals"));
    const t = snapshot.codexTotals;
    lines.push(
      `  Tokens: ${formatNumber(t.inputTokens)} in / ${formatNumber(t.outputTokens)} out / ${formatNumber(t.totalTokens)} total`,
    );
    lines.push(`  Runtime: ${formatDuration(t.secondsRunning)}`);

    // Dashboard URL
    if (httpPort) {
      lines.push("");
      lines.push(dim(`  Dashboard: http://127.0.0.1:${httpPort}/`));
    }

    // Log file path
    if (logFile) {
      lines.push("");
      lines.push(dim(`  Logs: ${logFile}`));
    }

    // Timestamp
    lines.push("");
    lines.push(dim(`  Updated: ${snapshot.generatedAt}`));

    this.output.write(lines.join("\n") + "\n");
  }
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}
function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
function cyan(s: string): string {
  return `\x1b[36m${s}\x1b[0m`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatAge(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const absDiff = Math.abs(diffMs);
  const seconds = Math.floor(absDiff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m${secs.toFixed(0)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}
