// Spawning the Claude Code CLI ourselves so an abort can terminate the WHOLE process tree
// (CLI + the stdio MCP server it spawned) immediately. The SDK's own abort signal only
// kills the CLI after stdin EOF plus a ~2s grace period, and in live call 01a0eece… the result
// still arrived 4.8s after our abort (D28).

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface CliSpawnOptions {
  command: string;
  args: string[];
  cwd?: string | undefined;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

/** Spawns the CLI in its own process group (POSIX) so the whole tree can be signalled. */
export function spawnCli(o: CliSpawnOptions, onSpawn: (child: ChildProcessWithoutNullStreams) => void): ChildProcessWithoutNullStreams {
  const child = spawn(o.command, o.args, {
    cwd: o.cwd,
    env: o.env as NodeJS.ProcessEnv,
    signal: o.signal,
    stdio: "pipe",
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  onSpawn(child);
  return child;
}

/**
 * Terminates the process tree rooted at pid. Returns the pids that were terminated
 * (Windows: parsed from taskkill; POSIX: the group leader, since the group is signalled).
 */
export function killTree(pid: number): Promise<number[]> {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (_err, stdout) => {
        const pids = [...String(stdout).matchAll(/PID (\d+)/g)].map((m) => Number(m[1])).filter((p, i, all) => all.indexOf(p) === i && p !== 0);
        // taskkill lists "PID <child> (child process of PID <parent>)": keep only terminated ones.
        const killed = [...String(stdout).matchAll(/process with PID (\d+)/g)].map((m) => Number(m[1]));
        resolve(killed.length ? killed : pids.filter((p) => p === pid));
      });
    });
  }
  try {
    process.kill(-pid, "SIGKILL"); // negative pid = the whole process group
    return Promise.resolve([pid]);
  } catch {
    return Promise.resolve([]);
  }
}

/** True if a process with this pid still exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
