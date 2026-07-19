import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { findGrokBin, runCommand, parseModels, parseSessions } from "./grok.js";
import { gitStatus, gitCommitAll, gitPush, createPullRequest } from "./github.js";
import { AcpEngine } from "./acp/engine.js";
import { loadSettings, saveSettings, settingsPath } from "./settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.GROK_UI_PORT || 3921);
const ROOT = path.resolve(__dirname, "..");

const saved = loadSettings();
const state = {
  projectPath: process.env.GROK_UI_PROJECT || saved.projectPath || ROOT,
  model: process.env.GROK_UI_MODEL || saved.model || "",
  alwaysApprove: saved.alwaysApprove !== false,
  sessionMode: saved.sessionMode || "continue",
  resumeSessionId: saved.resumeSessionId || "",
  effort: saved.effort || "",
  noAutoUpdate: saved.noAutoUpdate !== false,
  engine: process.env.GROK_UI_ENGINE || saved.engine || "acp",
  autoFallback: process.env.GROK_UI_AUTO_FALLBACK !== "0" && saved.autoFallback !== false,
  recentProjects: saved.recentProjects || [],
  activeRun: null,
};

function persistState() {
  const next = saveSettings({
    projectPath: state.projectPath,
    model: state.model,
    alwaysApprove: state.alwaysApprove,
    sessionMode: state.sessionMode,
    resumeSessionId: state.resumeSessionId,
    effort: state.effort,
    noAutoUpdate: state.noAutoUpdate,
    engine: state.engine,
    autoFallback: state.autoFallback,
    recentProjects: state.recentProjects,
  });
  state.recentProjects = next.recentProjects || [];
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const dist = path.join(ROOT, "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const sockets = new Set();

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(data);
  }
}

const acp = new AcpEngine({
  broadcast,
  getSettings: () => ({ ...state }),
  log: (msg) => console.log(msg),
});

function settingsPublic() {
  return {
    projectPath: state.projectPath,
    model: state.model || null,
    alwaysApprove: state.alwaysApprove,
    sessionMode: state.sessionMode,
    resumeSessionId: state.resumeSessionId || null,
    effort: state.effort || null,
    noAutoUpdate: state.noAutoUpdate,
    engine: state.engine,
    autoFallback: state.autoFallback,
    billingBlocked: acp.billingBlocked,
    recentProjects: state.recentProjects || [],
    settingsFile: settingsPath(),
    hasApiKey: Boolean(process.env.XAI_API_KEY),
    docs: {
      overview: "https://docs.x.ai/build/overview",
      headless: "https://docs.x.ai/build/cli/headless-scripting",
      reference: "https://docs.x.ai/build/cli/reference",
    },
  };
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    grok: findGrokBin(),
    acpReady: acp.ready,
    acpBusy: acp.busy,
    ...settingsPublic(),
  });
});

app.get("/api/status", async (_req, res) => {
  try {
    const grok = findGrokBin();
    if (!grok) {
      return res.status(500).json({ error: "grok CLI not found. Install Grok Build first." });
    }
    const version = await runCommand(grok, ["--version"], { cwd: state.projectPath });
    const modelsRaw = await runCommand(grok, ["models"], { cwd: state.projectPath });
    const models = parseModels(modelsRaw.stdout || modelsRaw.combined);
    if (!state.model && models.defaultModel) state.model = models.defaultModel;
    const sessionsRaw = await runCommand(grok, ["sessions", "list"], {
      cwd: state.projectPath,
      allowFail: true,
    });
    const sessions = parseSessions(sessionsRaw.stdout || sessionsRaw.combined);
    let git = null;
    try {
      git = await gitStatus(state.projectPath);
    } catch (err) {
      git = { error: err.message };
    }
    res.json({
      grok,
      version: (version.stdout || "").trim(),
      models,
      sessions,
      git,
      acpReady: acp.ready,
      acpBusy: acp.busy,
      acpSessionId: acp.client?.sessionId || null,
      acpModels: acp.client?.availableModels || [],
      running: Boolean(state.activeRun) || acp.busy,
      ...settingsPublic(),
      model: state.model || models.defaultModel || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/settings", async (req, res) => {
  const {
    projectPath,
    model,
    alwaysApprove,
    sessionMode,
    resumeSessionId,
    effort,
    noAutoUpdate,
    engine,
    autoFallback,
  } = req.body || {};

  let restartAcp = false;

  if (typeof projectPath === "string" && projectPath.trim()) {
    const next = path.resolve(projectPath.trim());
    if (!fs.existsSync(next)) {
      return res.status(400).json({ error: `Path does not exist: ${next}` });
    }
    if (next !== state.projectPath) {
      state.projectPath = next;
      restartAcp = true;
    }
  }
  if (typeof model === "string") state.model = model.trim();
  if (typeof alwaysApprove === "boolean") {
    state.alwaysApprove = alwaysApprove;
    acp.client?.setAlwaysApprove(alwaysApprove);
  }
  if (typeof noAutoUpdate === "boolean") state.noAutoUpdate = noAutoUpdate;
  if (typeof autoFallback === "boolean") state.autoFallback = autoFallback;
  if (typeof effort === "string" && effort !== state.effort) {
    state.effort = effort.trim();
    restartAcp = true;
  }
  if (typeof resumeSessionId === "string") state.resumeSessionId = resumeSessionId.trim();
  if (typeof sessionMode === "string") {
    const mode = sessionMode.trim();
    if (["continue", "resume", "fresh"].includes(mode)) {
      if (mode !== state.sessionMode) restartAcp = true;
      state.sessionMode = mode;
    }
  }
  if (typeof engine === "string" && ["acp", "headless"].includes(engine)) {
    state.engine = engine;
  }

  persistState();

  if (restartAcp && state.engine === "acp") {
    try {
      await acp.restart();
    } catch (err) {
      return res.status(500).json({ error: `ACP restart failed: ${err.message}`, ...settingsPublic() });
    }
  }

  res.json(settingsPublic());
});

app.post("/api/acp/ensure", async (_req, res) => {
  try {
    const client = await acp.ensure();
    res.json({
      ok: true,
      sessionId: client.sessionId,
      model: client.currentModelId,
      models: client.availableModels,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/acp/restart", async (_req, res) => {
  try {
    const client = await acp.restart();
    res.json({ ok: true, sessionId: client.sessionId, model: client.currentModelId });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/acp/new", async (_req, res) => {
  try {
    state.sessionMode = "fresh";
    state.resumeSessionId = "";
    acp.billingBlocked = false;
    persistState();
    const client = await acp.newChat();
    res.json({ ok: true, sessionId: client.sessionId, model: client.currentModelId });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/command", async (req, res) => {
  const { name, args = [] } = req.body || {};
  const grok = findGrokBin();
  if (!grok) return res.status(500).json({ error: "grok CLI not found" });

  const map = {
    login: ["login"],
    "login-device": ["login", "--device-auth"],
    logout: ["logout"],
    update: ["update"],
    inspect: ["inspect"],
    "inspect-json": ["inspect", "--json"],
    version: ["version"],
    "sessions-list": ["sessions", "list"],
    models: ["models"],
    "mcp-list": ["mcp", "list"],
  };

  let cmdArgs = map[name];
  if (!cmdArgs && name === "raw" && Array.isArray(args)) {
    cmdArgs = args.map(String);
  }
  if (!cmdArgs) {
    return res.status(400).json({ error: `Unknown command: ${name}` });
  }

  try {
    const result = await runCommand(grok, cmdArgs, {
      cwd: state.projectPath,
      timeoutMs: 120_000,
      allowFail: true,
    });
    res.json({
      ok: result.code === 0,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      combined: result.combined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/api/git", async (_req, res) => {
  try {
    res.json(await gitStatus(state.projectPath));
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/git/commit", async (req, res) => {
  try {
    const message = (req.body?.message || "chore: update from GrokBuildUI").trim();
    res.json(await gitCommitAll(state.projectPath, message));
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/git/push", async (req, res) => {
  try {
    res.json(await gitPush(state.projectPath, { setUpstream: Boolean(req.body?.setUpstream) }));
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/git/pr", async (req, res) => {
  try {
    res.json(
      await createPullRequest(state.projectPath, {
        title: req.body?.title,
        body: req.body?.body,
      }),
    );
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/run/cancel", (_req, res) => {
  acp.cancel();
  if (state.activeRun?.child) {
    try {
      state.activeRun.child.kill();
    } catch {
      /* ignore */
    }
    state.activeRun = null;
    broadcast({ type: "run", event: "cancelled" });
  }
  res.json({ ok: true });
});

app.post("/api/sessions/export", async (req, res) => {
  const grok = findGrokBin();
  if (!grok) return res.status(500).json({ error: "grok CLI not found" });
  const sessionId = String(
    req.body?.sessionId || state.resumeSessionId || acp.client?.sessionId || "",
  ).trim();
  const outPath = path.join(
    os.tmpdir(),
    `grok-session-${(sessionId || "latest").slice(0, 8)}-${Date.now()}.md`,
  );
  try {
    const args = sessionId ? ["export", sessionId, outPath] : ["export", outPath];
    const result = await runCommand(grok, args, {
      cwd: state.projectPath,
      allowFail: true,
      timeoutMs: 60_000,
    });
    if (result.code !== 0 && sessionId) {
      await runCommand(grok, ["export", outPath], {
        cwd: state.projectPath,
        allowFail: true,
        timeoutMs: 60_000,
      });
    }
    const markdown = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
    res.json({ ok: true, path: outPath, markdown, sessionId: sessionId || null });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/api/inspect", async (_req, res) => {
  const grok = findGrokBin();
  if (!grok) return res.status(500).json({ error: "grok CLI not found" });
  try {
    const result = await runCommand(grok, ["inspect", "--json"], {
      cwd: state.projectPath,
      allowFail: true,
    });
    let json = null;
    try {
      json = JSON.parse(result.stdout || result.combined);
    } catch {
      /* plain */
    }
    res.json({
      ok: result.code === 0,
      json,
      raw: result.stdout || result.combined,
      stderr: result.stderr,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

wss.on("connection", (ws) => {
  sockets.add(ws);
  ws.send(
    JSON.stringify({
      type: "hello",
      ...settingsPublic(),
      acpReady: acp.ready,
    }),
  );

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
      return;
    }

    try {
      if (msg.type === "prompt") {
        if (state.engine === "acp" && msg.engine !== "headless") {
          await startAcpPrompt(msg);
        } else {
          await startHeadlessPrompt(msg);
        }
        return;
      }
      if (msg.type === "cancel") {
        acp.cancel();
        if (state.activeRun?.child) {
          state.activeRun.child.kill();
          state.activeRun = null;
          broadcast({ type: "run", event: "cancelled" });
        }
        return;
      }
      if (msg.type === "acp/ensure") {
        await acp.ensure();
        return;
      }
      if (msg.type === "acp/restart") {
        await acp.restart();
        return;
      }
      if (msg.type === "acp/new") {
        state.sessionMode = "fresh";
        state.resumeSessionId = "";
        acp.billingBlocked = false;
        await acp.newChat();
        return;
      }
      if (msg.type === "permissionAnswer") {
        acp.answerPermission(msg.requestId, msg.optionId);
        return;
      }
      if (msg.type === "planAnswer") {
        acp.answerPlan(msg.requestId, msg.verdict);
        return;
      }
      if (msg.type === "questionAnswer") {
        acp.answerQuestion(msg.requestId, msg.answers || {});
        return;
      }
      if (msg.type === "questionCancel") {
        acp.cancelQuestion(msg.requestId);
      }
    } catch (err) {
      broadcast({ type: "error", error: err.message || String(err) });
    }
  });

  ws.on("close", () => sockets.delete(ws));
});

async function startAcpPrompt(msg) {
  const prompt = String(msg.prompt || "").trim();
  if (!prompt) {
    broadcast({ type: "error", error: "Empty prompt" });
    return;
  }
  broadcast({
    type: "run",
    event: "start",
    engine: "acp",
    prompt,
    projectPath: state.projectPath,
    model: state.model || null,
  });
  try {
    await acp.prompt(prompt);
    broadcast({ type: "run", event: "end", engine: "acp", code: 0 });
  } catch (err) {
    const billing = err?.billing || err?.code === 402 || /402|spending limit/i.test(err.message || "");
    broadcast({ type: "run", event: "error", engine: "acp", error: err.message, billing });
    broadcast({ type: "run", event: "end", engine: "acp", code: 1 });

    if (billing && state.autoFallback && msg.fallback !== false) {
      broadcast({
        type: "run",
        event: "fallback",
        from: "acp",
        to: "headless",
        reason: "billing",
      });
      await startHeadlessPrompt({
        ...msg,
        prompt,
        engine: "headless",
        sessionMode: "fresh",
      });
    }
  }
}

function buildHeadlessArgs(prompt, { sessionMode, resumeSessionId } = {}) {
  const mode = sessionMode || state.sessionMode || "continue";
  const resumeId = resumeSessionId || state.resumeSessionId || "";
  const args = [];
  if (state.noAutoUpdate) args.push("--no-auto-update");
  if (mode === "resume" && resumeId) args.push("--resume", resumeId);
  else if (mode === "continue") args.push("--continue");
  args.push("-p", prompt);
  args.push("--output-format", "streaming-json");
  args.push("--cwd", state.projectPath);
  if (state.model) args.push("-m", state.model);
  if (state.effort) args.push("--effort", state.effort);
  if (state.alwaysApprove) args.push("--always-approve");
  return args;
}

async function startHeadlessPrompt(msg) {
  const prompt = String(msg.prompt || "").trim();
  if (!prompt) {
    broadcast({ type: "error", error: "Empty prompt" });
    return;
  }
  if (state.activeRun) {
    broadcast({ type: "error", error: "A run is already in progress. Cancel it first." });
    return;
  }

  const grok = findGrokBin();
  if (!grok) {
    broadcast({ type: "error", error: "grok CLI not found" });
    return;
  }

  let sessionMode = state.sessionMode;
  let resumeSessionId = state.resumeSessionId;
  if (typeof msg.sessionMode === "string") sessionMode = msg.sessionMode;
  if (typeof msg.resumeSessionId === "string") resumeSessionId = msg.resumeSessionId;
  if (typeof msg.continueSession === "boolean") {
    sessionMode = msg.continueSession ? "continue" : "fresh";
  }

  const args = buildHeadlessArgs(prompt, { sessionMode, resumeSessionId });
  broadcast({
    type: "run",
    event: "start",
    engine: "headless",
    prompt,
    args: [grok, ...args],
    projectPath: state.projectPath,
    model: state.model || null,
  });

  const child = spawn(grok, args, {
    cwd: state.projectPath,
    env: process.env,
    shell: false,
    windowsHide: true,
  });
  state.activeRun = { child, startedAt: Date.now() };

  let buffer = "";
  const flushLines = (chunk, stream) => {
    buffer += chunk.toString();
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || "";
    for (const line of parts) {
      if (!line.trim()) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        /* plain */
      }
      broadcast({ type: "run", event: "chunk", stream, line, json: parsed });
    }
  };

  child.stdout.on("data", (d) => flushLines(d, "stdout"));
  child.stderr.on("data", (d) => broadcast({ type: "run", event: "stderr", text: d.toString() }));
  child.on("error", (err) => {
    broadcast({ type: "run", event: "error", error: err.message });
    state.activeRun = null;
  });
  child.on("close", (code) => {
    if (buffer.trim()) {
      let parsed = null;
      try {
        parsed = JSON.parse(buffer);
      } catch {
        /* ignore */
      }
      broadcast({ type: "run", event: "chunk", stream: "stdout", line: buffer, json: parsed });
      buffer = "";
    }
    broadcast({ type: "run", event: "end", code });
    state.activeRun = null;
  });
}

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/ws")) return next();
  const index = path.join(dist, "index.html");
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(404).send("UI not built yet. Run npm run dev.");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`GrokBuildUI server http://127.0.0.1:${PORT}`);
  console.log(`Engine: ${state.engine}`);
  console.log(`Project: ${state.projectPath}`);
  console.log(`Grok: ${findGrokBin() || "NOT FOUND"}`);
});

process.on("SIGINT", async () => {
  await acp.dispose();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await acp.dispose();
  process.exit(0);
});
