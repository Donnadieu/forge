/**
 * Pure HTML renderer for the Forge dashboard.
 * No cross-module imports — receives data via parameters.
 */

import type {
  StateSnapshot,
  RunningSessionSnapshot,
  RetrySnapshot,
} from "../observability/types.js";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function renderRunningRow(s: RunningSessionSnapshot): string {
  const elapsed = (Date.now() - new Date(s.startedAt).getTime()) / 1000;
  return `<tr>
    <td>${escapeHtml(s.identifier)}</td>
    <td>${escapeHtml(s.state)}</td>
    <td>${s.turnCount}</td>
    <td>${escapeHtml(s.lastEvent || "-")}</td>
    <td title="${escapeHtml(s.lastMessage)}">${escapeHtml(s.lastMessage.slice(0, 60))}</td>
    <td>${formatTokens(s.tokens.total)}</td>
    <td>${formatDuration(elapsed)}</td>
    <td>${s.attempt}</td>
  </tr>`;
}

function renderRetryRow(r: RetrySnapshot): string {
  return `<tr>
    <td>${escapeHtml(r.identifier)}</td>
    <td>${r.attempt}</td>
    <td>${escapeHtml(r.dueAt)}</td>
    <td>${escapeHtml(r.error ?? "-")}</td>
  </tr>`;
}

export function renderDashboardHtml(snapshot: StateSnapshot): string {
  const { counts, running, retrying, codexTotals } = snapshot;

  const runningRows = running.map(renderRunningRow).join("\n");
  const retryRows = retrying.map(renderRetryRow).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="5">
  <title>Forge Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: "SF Mono", "Menlo", "Consolas", monospace; background: #0d1117; color: #c9d1d9; padding: 24px; }
    h1 { font-size: 18px; color: #58a6ff; margin-bottom: 16px; }
    h2 { font-size: 14px; color: #8b949e; margin: 20px 0 8px; text-transform: uppercase; letter-spacing: 1px; }
    .stats { display: flex; gap: 24px; margin-bottom: 20px; }
    .stat { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px 20px; }
    .stat-value { font-size: 24px; font-weight: bold; color: #58a6ff; }
    .stat-label { font-size: 11px; color: #8b949e; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #21262d; font-size: 12px; }
    th { color: #8b949e; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid #30363d; }
    tr:hover { background: #161b22; }
    .empty { color: #484f58; font-style: italic; padding: 16px; }
    .footer { margin-top: 24px; font-size: 11px; color: #484f58; }
  </style>
</head>
<body>
  <h1>Forge Orchestrator</h1>

  <div class="stats">
    <div class="stat">
      <div class="stat-value">${counts.running}</div>
      <div class="stat-label">Running</div>
    </div>
    <div class="stat">
      <div class="stat-value">${counts.retrying}</div>
      <div class="stat-label">Retrying</div>
    </div>
    <div class="stat">
      <div class="stat-value">${formatTokens(codexTotals.totalTokens)}</div>
      <div class="stat-label">Total Tokens</div>
    </div>
    <div class="stat">
      <div class="stat-value">${formatDuration(codexTotals.secondsRunning)}</div>
      <div class="stat-label">Total Runtime</div>
    </div>
  </div>

  <h2>Running Sessions (${counts.running})</h2>
  ${
    running.length > 0
      ? `<table>
    <thead><tr>
      <th>Identifier</th><th>State</th><th>Turns</th><th>Last Event</th><th>Message</th><th>Tokens</th><th>Elapsed</th><th>Attempt</th>
    </tr></thead>
    <tbody>${runningRows}</tbody>
  </table>`
      : `<div class="empty">No running sessions</div>`
  }

  <h2>Retry Queue (${counts.retrying})</h2>
  ${
    retrying.length > 0
      ? `<table>
    <thead><tr>
      <th>Identifier</th><th>Attempt</th><th>Due At</th><th>Error</th>
    </tr></thead>
    <tbody>${retryRows}</tbody>
  </table>`
      : `<div class="empty">No pending retries</div>`
  }

  <div class="footer">
    Generated at ${escapeHtml(snapshot.generatedAt)} &middot; Auto-refreshes every 5s
    &middot; <a href="/api/v1/state" style="color:#58a6ff;">JSON API</a>
  </div>
</body>
</html>`;
}
