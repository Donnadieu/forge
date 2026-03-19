import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface SshRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Escape a string for safe inclusion in a single-quoted shell argument.
 */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build SSH args array from host string.
 * Supports: "user@host", "host", "host:port"
 */
export function buildSshArgs(host: string, sshConfigPath?: string): string[] {
  const args = ["-T"]; // non-interactive

  if (sshConfigPath) args.push("-F", sshConfigPath);

  // Handle host:port format
  const colonIdx = host.lastIndexOf(":");
  if (colonIdx > 0) {
    const maybePort = host.slice(colonIdx + 1);
    if (/^\d+$/.test(maybePort)) {
      args.push("-p", maybePort);
      args.push(host.slice(0, colonIdx));
      return args;
    }
  }

  args.push(host);
  return args;
}

/**
 * Spawn an SSH process for streaming communication (like agent stdio).
 * Returns a ChildProcess with stdin/stdout/stderr pipes.
 */
export function spawnSshProcess(
  host: string,
  command: string,
  opts?: { env?: Record<string, string>; signal?: AbortSignal; sshConfigPath?: string },
): ChildProcess {
  const sshArgs = buildSshArgs(host, opts?.sshConfigPath);
  // Wrap command in bash -lc for proper env (login shell)
  sshArgs.push(`bash -lc ${shellEscape(command)}`);

  const spawnOpts: SpawnOptions = {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...opts?.env },
  };

  const child = spawn("ssh", sshArgs, spawnOpts);

  // Handle abort by killing the process instead of using signal option
  // (signal option throws unhandled AbortError)
  if (opts?.signal) {
    opts.signal.addEventListener("abort", () => {
      if (!child.killed) child.kill("SIGTERM");
    });
  }

  // Suppress unhandled error events from the child process
  child.on("error", () => {});

  return child;
}

/**
 * Run a command on a remote host and wait for completion.
 * Returns stdout, stderr, and exit code.
 */
export async function runSshCommand(
  host: string,
  command: string,
  opts?: { timeoutMs?: number; sshConfigPath?: string },
): Promise<SshRunResult> {
  return new Promise((resolve, reject) => {
    const sshArgs = buildSshArgs(host, opts?.sshConfigPath);
    sshArgs.push(`bash -lc ${shellEscape(command)}`);

    const proc = spawn("ssh", sshArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let settled = false;
    let hasExited = false;
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    if (opts?.timeoutMs) {
      timer = setTimeout(() => {
        if (settled) return;
        proc.kill("SIGTERM");
        // Escalate to SIGKILL if process hasn't exited after SIGTERM
        killTimer = setTimeout(() => {
          if (!hasExited) {
            try {
              proc.kill("SIGKILL");
            } catch {}
          }
        }, 5000);
        if (killTimer.unref) killTimer.unref();
        settled = true;
        reject(new Error(`SSH command timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }

    proc.on("close", (code) => {
      hasExited = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      reject(err);
    });

    proc.stdin?.end();
  });
}
