import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function findGrokBin() {
  const candidates = [
    process.env.GROK_BIN,
    path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok"),
    "grok",
  ].filter(Boolean);

  for (const c of candidates) {
    if (c === "grok") return c;
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function runCommand(bin, args, { cwd, timeoutMs = 60_000, allowFail = false, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: env || process.env,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out: ${bin} ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const combined = `${stdout}${stderr}`;
      if (code !== 0 && !allowFail) {
        const err = new Error(stderr.trim() || stdout.trim() || `Exit ${code}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ code, stdout, stderr, combined });
    });
  });
}

export function parseModels(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let defaultModel = null;
  const models = [];

  for (const line of lines) {
    const def = line.match(/^Default model:\s*(.+)$/i);
    if (def) {
      defaultModel = def[1].trim();
      continue;
    }
    const star = line.match(/^\*\s+(.+?)(?:\s+\(default\))?$/i);
    if (star) {
      const id = star[1].replace(/\s+\(default\)$/i, "").trim();
      models.push({ id, name: id, default: /\(default\)/i.test(line) || id === defaultModel });
      continue;
    }
    // bare id lines under Available models
    if (/^grok[\w.\-]*/i.test(line) && !line.includes(":")) {
      models.push({ id: line, name: line, default: line === defaultModel });
    }
  }

  const unique = [];
  const seen = new Set();
  for (const m of models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    unique.push(m);
  }

  if (defaultModel && !seen.has(defaultModel)) {
    unique.unshift({ id: defaultModel, name: defaultModel, default: true });
  }

  return { defaultModel, models: unique, raw: text };
}

export function parseSessions(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());

  const sessions = [];
  for (const line of lines) {
    if (/^SESSION ID\b/i.test(line) || /^\(no label\)/i.test(line)) continue;
    // Table row: UUID  dates  status  summary
    const m = line.match(
      /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/i,
    );
    if (m) {
      sessions.push({
        id: m[1],
        created: m[2],
        updated: m[3],
        status: m[4],
        title: (m[5] || "").trim() || m[1],
        raw: line,
      });
      continue;
    }
    const loose = line.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*(.*)$/i,
    );
    if (loose) {
      sessions.push({ id: loose[1], title: (loose[2] || "").trim() || loose[1], raw: line });
    }
  }
  return sessions;
}
