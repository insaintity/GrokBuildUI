import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/**
 * Minimal ACP terminal pool — runs shell commands for the agent.
 */
export function createTerminalPool({ cwd, log = () => {} }) {
  const terminals = new Map();

  function create(params = {}) {
    const terminalId = randomUUID();
    const command = String(params.command || "");
    const envList = Array.isArray(params.env) ? params.env : [];
    const env = { ...process.env };
    for (const e of envList) {
      if (e?.name) env[e.name] = String(e.value ?? "");
    }
    const runCwd = params.cwd || cwd;
    const outputByteLimit = Number(params.outputByteLimit) || 200_000;

    log(`[terminal] create ${terminalId}: ${command}`);

    const child = spawn(command, {
      cwd: runCwd,
      env,
      shell: true,
      windowsHide: true,
    });

    let output = "";
    let truncated = false;
    let exitCode = null;
    let exited = false;
    const waiters = [];

    const append = (chunk) => {
      const next = chunk.toString();
      if (output.length + next.length > outputByteLimit) {
        truncated = true;
        output += next.slice(0, Math.max(0, outputByteLimit - output.length));
      } else {
        output += next;
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("close", (code) => {
      exited = true;
      exitCode = typeof code === "number" ? code : 1;
      for (const w of waiters.splice(0)) w({ exitCode });
    });
    child.on("error", (err) => {
      append(String(err.message || err));
      exited = true;
      exitCode = 1;
      for (const w of waiters.splice(0)) w({ exitCode });
    });

    terminals.set(terminalId, {
      child,
      command,
      get output() {
        return output;
      },
      get truncated() {
        return truncated;
      },
      get exitCode() {
        return exitCode;
      },
      get exited() {
        return exited;
      },
      waiters,
    });

    return { terminalId };
  }

  function output(terminalId) {
    const t = terminals.get(terminalId);
    if (!t) return { output: "", exitStatus: null, truncated: false };
    return {
      output: t.output,
      exitStatus: t.exited ? { exitCode: t.exitCode ?? 1 } : null,
      truncated: t.truncated,
    };
  }

  function waitForExit(terminalId) {
    const t = terminals.get(terminalId);
    if (!t) return Promise.resolve({ exitCode: 1 });
    if (t.exited) return Promise.resolve({ exitCode: t.exitCode ?? 1 });
    return new Promise((resolve) => {
      t.waiters.push(resolve);
    });
  }

  function kill(terminalId) {
    const t = terminals.get(terminalId);
    if (!t) return;
    try {
      if (process.platform === "win32" && t.child.pid) {
        spawn("taskkill", ["/PID", String(t.child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        t.child.kill();
      }
    } catch {
      try {
        t.child.kill();
      } catch {
        /* ignore */
      }
    }
  }

  function release(terminalId) {
    kill(terminalId);
    terminals.delete(terminalId);
  }

  function disposeAll() {
    for (const id of [...terminals.keys()]) release(id);
  }

  return { create, output, waitForExit, kill, release, disposeAll };
}
