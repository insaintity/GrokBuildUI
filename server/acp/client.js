import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import {
  parseAcpLine,
  routeSessionUpdate,
  makeRequest,
  makeAckResponse,
  makePermissionResponse,
  makeExitPlanResponse,
  makeQuestionResponse,
  makeQuestionCancelledResponse,
  pickAllowOption,
} from "./dispatch.js";
import { createTerminalPool } from "./terminal.js";

export class AcpClient extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    this.currentModelId = null;
    this.availableModels = [];
    this.alwaysApprove = Boolean(opts.alwaysApprove);
    this.terminal = createTerminalPool({
      cwd: opts.cwd,
      log: opts.log || (() => {}),
    });
  }

  get log() {
    return this.opts.log || (() => {});
  }

  async start() {
    const bin = this.opts.cliPath;
    // Top-level flag only: `grok --no-auto-update agent stdio`
    const args = this.opts.noAutoUpdate
      ? ["--no-auto-update", "agent", "stdio"]
      : ["agent", "stdio"];
    if (this.opts.effort) {
      // effort is agent-level and must precede stdio
      const idx = args.indexOf("agent");
      args.splice(idx + 1, 0, "--reasoning-effort", this.opts.effort);
    }

    this.log(`spawning ${bin} ${args.join(" ")} (cwd=${this.opts.cwd})`);
    this.proc = spawn(bin, args, {
      cwd: this.opts.cwd,
      env: {
        ...process.env,
        ...(this.opts.noAutoUpdate ? { GROK_DISABLE_AUTOUPDATER: "1" } : {}),
        ...(this.opts.env || {}),
      },
      shell: false,
      windowsHide: true,
    });

    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.onLine(line));

    this.proc.stdin.on("error", (err) => {
      this.log(`[acp] stdin error: ${err.message}`);
    });
    this.proc.stderr.on("data", (d) => {
      const text = d.toString();
      this.log(`[stderr] ${text}`);
      this.emit("stderr", text);
    });
    this.proc.on("exit", (code) => {
      this.log(`grok exited ${code}`);
      this.proc = null;
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error(`Grok exited (code ${code})`));
      }
      this.emit("exit", code);
    });
    this.proc.on("error", (err) => {
      this.emit("error", err);
    });

    const init = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
    this.emit("initialized", init);

    const authMethods = new Set((init.authMethods ?? []).map((m) => m.id));
    let methodId = null;
    if (process.env.XAI_API_KEY && authMethods.has("xai.api_key")) methodId = "xai.api_key";
    else if (authMethods.has("cached_token")) methodId = "cached_token";
    else if (authMethods.has("grok.com")) methodId = "grok.com";
    else methodId = init._meta?.defaultAuthMethodId || null;

    if (!methodId) {
      throw new Error("Not authenticated. Run Login in the UI or set XAI_API_KEY.");
    }

    await this.request("authenticate", { methodId, _meta: { headless: true } });
    return init;
  }

  async newSession(modelId) {
    const res = await this.request("session/new", {
      cwd: this.opts.cwd,
      mcpServers: [],
    });
    this.sessionId = res.sessionId;
    this.ingestModels(res.models);
    this.emit("session", res);
    if (modelId && modelId !== this.currentModelId) {
      try {
        await this.setModel(modelId);
      } catch (err) {
        this.log(`[acp] setModel failed: ${err.message}`);
      }
    }
    return { sessionId: this.sessionId };
  }

  async loadSession(sessionId, modelId) {
    const res = await this.request("session/load", {
      sessionId,
      cwd: this.opts.cwd,
      mcpServers: [],
    });
    this.sessionId = sessionId;
    if (res?.models) this.ingestModels(res.models);
    this.emit("session", { sessionId, ...(res || {}) });
    this.emit("sessionLoaded", { sessionId });
    if (modelId && modelId !== this.currentModelId) {
      try {
        await this.setModel(modelId);
      } catch (err) {
        this.log(`[acp] setModel failed: ${err.message}`);
      }
    }
    return { sessionId };
  }

  ingestModels(models) {
    const list = models?.availableModels ?? [];
    this.availableModels = list.map((m) => ({
      modelId: m.modelId,
      name: m.name || m.modelId,
      description: m.description,
    }));
    this.currentModelId =
      models?.currentModelId ||
      this.availableModels[0]?.modelId ||
      this.currentModelId;
  }

  async setModel(modelId) {
    if (!this.sessionId) throw new Error("no session");
    const res = await this.request("session/set_model", {
      sessionId: this.sessionId,
      modelId,
    });
    this.currentModelId = modelId;
    this.emit("modelChanged", modelId);
    return res;
  }

  async setMode(modeId) {
    if (!this.sessionId) throw new Error("no session");
    await this.request("session/set_mode", {
      sessionId: this.sessionId,
      modeId,
    });
  }

  async prompt(text) {
    if (!this.sessionId) throw new Error("no session");
    this.emit("promptStart", { text });
    const result = await this.request(
      "session/prompt",
      {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      },
      1_800_000,
    );
    this.emit("promptComplete", result);
    return result;
  }

  cancel(reason = "user") {
    if (!this.sessionId) return;
    this.log(`[cancel] ${reason}`);
    this.writeLine({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: this.sessionId },
    });
  }

  respondPermission(requestId, optionId) {
    this.writeLine(makePermissionResponse(requestId, optionId));
    this.emit("permissionResolved", { requestId, optionId });
  }

  respondExitPlan(requestId, verdict) {
    this.writeLine(makeExitPlanResponse(requestId, verdict));
  }

  respondQuestion(requestId, answers, annotations = {}) {
    this.writeLine(makeQuestionResponse(requestId, answers, annotations));
  }

  respondQuestionCancelled(requestId) {
    this.writeLine(makeQuestionCancelledResponse(requestId));
  }

  setAlwaysApprove(value) {
    this.alwaysApprove = Boolean(value);
  }

  async dispose() {
    this.rl?.close();
    this.terminal.disposeAll();
    const proc = this.proc;
    if (!proc) return;
    return new Promise((resolve) => {
      const finish = () => resolve();
      const timer = setTimeout(finish, 3000);
      proc.once("exit", () => {
        clearTimeout(timer);
        finish();
      });
      try {
        if (process.platform === "win32" && proc.pid) {
          spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true });
        } else {
          proc.kill();
        }
      } catch {
        try {
          proc.kill();
        } catch {
          finish();
        }
      }
    });
  }

  writeLine(obj) {
    const proc = this.proc;
    if (!proc || proc.killed || !proc.stdin?.writable) return false;
    try {
      proc.stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch (err) {
      this.log(`[acp] write failed: ${err.message}`);
      return false;
    }
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++;
    const timeout = timeoutMs ?? (method === "session/prompt" ? 1_800_000 : 120_000);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.pending.set(id, entry);
      if (!this.writeLine(makeRequest(id, method, params))) {
        this.pending.delete(id);
        reject(new Error(`Grok process is not running (${method})`));
        return;
      }
      entry.timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`ACP request timed out: ${method}`));
        }
      }, timeout);
    });
  }

  respondOk(id, result = {}) {
    this.writeLine(makeAckResponse(id, result));
  }

  respondError(id, code, message) {
    this.writeLine({ jsonrpc: "2.0", id, error: { code, message } });
  }

  onLine(line) {
    const ev = parseAcpLine(line);
    if (!ev) return;
    if (ev.kind === "non-json") {
      this.log(`[non-json] ${ev.line.slice(0, 200)}`);
      return;
    }
    if (ev.kind === "response") {
      const p = this.pending.get(ev.id);
      if (p) {
        this.pending.delete(ev.id);
        if (p.timer) clearTimeout(p.timer);
        if (ev.error) p.reject(Object.assign(new Error(ev.error.message || "ACP error"), ev.error));
        else p.resolve(ev.result);
      }
      return;
    }
    if (ev.kind === "session-update") {
      this.handleSessionUpdate(ev.update);
      return;
    }
    void this.handleServerRequest({ id: ev.id, method: ev.method, params: ev.params });
  }

  handleSessionUpdate(u) {
    const r = routeSessionUpdate(u);
    if (!r) return;
    if (r.event === "messageChunk") this.emit("messageChunk", r.text);
    else if (r.event === "userMessageChunk") this.emit("userMessageChunk", r.text);
    else if (r.event === "thoughtChunk") this.emit("thoughtChunk", r.text);
    else if (r.event === "toolCall") this.emit("toolCall", r.payload);
    else if (r.event === "toolCallUpdate") this.emit("toolCallUpdate", r.payload);
    else if (r.event === "plan") this.emit("plan", r.payload);
    else if (r.event === "modeChanged") this.emit("modeChanged", r.modeId);
    else if (r.event === "commandsUpdate") this.emit("commandsUpdate", r.commands);
    else this.emit("update", r.payload);
  }

  async handleServerRequest(msg) {
    const { method, id, params } = msg;
    try {
      if (method === "fs/read_text_file") {
        const content = await fs.readFile(params.path, "utf8");
        this.respondOk(id, { content });
        return;
      }
      if (method === "fs/write_text_file") {
        await fs.writeFile(params.path, params.content ?? "", "utf8");
        this.emit("fsWrite", { path: params.path });
        this.respondOk(id, {});
        return;
      }
      if (method === "terminal/create") {
        const created = this.terminal.create(params);
        this.emit("terminalCreate", { ...created, command: params.command });
        this.respondOk(id, created);
        return;
      }
      if (method === "terminal/output") {
        this.respondOk(id, this.terminal.output(params.terminalId));
        return;
      }
      if (method === "terminal/wait_for_exit") {
        const r = await this.terminal.waitForExit(params.terminalId);
        this.respondOk(id, r);
        return;
      }
      if (method === "terminal/kill") {
        this.terminal.kill(params.terminalId);
        this.respondOk(id, {});
        return;
      }
      if (method === "terminal/release") {
        const snap = this.terminal.output(params.terminalId);
        this.emit("commandDone", {
          terminalId: params.terminalId,
          output: snap.output,
          exitCode: snap.exitStatus?.exitCode ?? null,
          truncated: snap.truncated,
        });
        this.terminal.release(params.terminalId);
        this.respondOk(id, {});
        return;
      }
      if (method === "session/request_permission") {
        const req = {
          id,
          sessionId: params.sessionId,
          toolCall: params.toolCall,
          options: params.options ?? [],
        };
        if (this.alwaysApprove) {
          const opt = pickAllowOption(req.options);
          if (opt?.optionId) {
            this.respondPermission(id, opt.optionId);
            this.emit("permissionAuto", { ...req, optionId: opt.optionId });
            return;
          }
        }
        this.emit("permissionRequest", req);
        return;
      }
      if (method === "x.ai/exit_plan_mode" || method === "_x.ai/exit_plan_mode") {
        const req = {
          id,
          sessionId: params?.sessionId ?? this.sessionId ?? "",
          plan: params?.planContent ?? params?.plan ?? "",
        };
        if (this.alwaysApprove) {
          this.respondExitPlan(id, "approved");
          this.emit("planAutoApproved", req);
          return;
        }
        this.emit("exitPlanRequest", req);
        return;
      }
      if (method === "x.ai/ask_user_question" || method === "_x.ai/ask_user_question") {
        this.emit("questionRequest", {
          id,
          sessionId: params?.sessionId ?? this.sessionId ?? "",
          questions: Array.isArray(params?.questions) ? params.questions : [],
        });
        return;
      }
      if (
        method === "_x.ai/session_notification" ||
        method === "x.ai/session_notification" ||
        method === "_x.ai/session/prompt_complete" ||
        method === "x.ai/session/prompt_complete" ||
        method === "_x.ai/session/update" ||
        method === "x.ai/session/update" ||
        method?.startsWith("_x.ai/") ||
        method?.startsWith("x.ai/")
      ) {
        this.emit("xai", { method, params });
        if (id != null) this.respondOk(id, {});
        return;
      }

      this.emit("serverRequest", msg);
      if (id != null) this.respondOk(id, {});
    } catch (err) {
      this.log(`server request error (${method}): ${err.message}`);
      if (id != null) this.respondError(id, -32603, err.message || "Internal error");
    }
  }
}
