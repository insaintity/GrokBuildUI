import { AcpClient } from "./client.js";
import { findGrokBin } from "../grok.js";

/**
 * Owns the long-lived ACP agent and fans events out to WebSocket clients.
 */
export class AcpEngine {
  constructor({ broadcast, getSettings, log = console.log }) {
    this.broadcast = broadcast;
    this.getSettings = getSettings;
    this.log = log;
    this.client = null;
    this.busy = false;
    this.starting = null;
  }

  get ready() {
    return Boolean(this.client?.sessionId);
  }

  async ensure() {
    if (this.client?.sessionId) return this.client;
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async _start() {
    if (this.client) {
      await this.client.dispose();
      this.client = null;
    }

    const settings = this.getSettings();
    const bin = findGrokBin();
    if (!bin) throw new Error("grok CLI not found");

    const client = new AcpClient({
      cliPath: bin,
      cwd: settings.projectPath,
      effort: settings.effort || undefined,
      alwaysApprove: settings.alwaysApprove,
      noAutoUpdate: settings.noAutoUpdate !== false,
      log: (msg) => {
        this.log(msg);
        this.broadcast({ type: "acp", event: "log", text: msg });
      },
    });

    this.bind(client);
    await client.start();

    if (settings.sessionMode === "resume" && settings.resumeSessionId) {
      try {
        await client.loadSession(settings.resumeSessionId, settings.model || undefined);
      } catch (err) {
        this.log(`[acp] loadSession failed, starting new: ${err.message}`);
        await client.newSession(settings.model || undefined);
      }
    } else {
      await client.newSession(settings.model || undefined);
    }

    this.client = client;
    this.broadcast({
      type: "acp",
      event: "ready",
      sessionId: client.sessionId,
      model: client.currentModelId,
      models: client.availableModels,
    });
    return client;
  }

  bind(client) {
    const emit = (event, payload = {}) => {
      this.broadcast({ type: "acp", event, ...payload });
    };

    client.on("messageChunk", (text) => emit("messageChunk", { text }));
    client.on("thoughtChunk", (text) => emit("thoughtChunk", { text }));
    client.on("userMessageChunk", (text) => emit("userMessageChunk", { text }));
    client.on("toolCall", (payload) => emit("toolCall", { call: simplifyTool(payload) }));
    client.on("toolCallUpdate", (payload) => emit("toolCallUpdate", { call: simplifyTool(payload) }));
    client.on("plan", (payload) => emit("plan", { plan: payload }));
    client.on("permissionRequest", (req) => emit("permissionRequest", { req }));
    client.on("permissionAuto", (req) => emit("permissionAuto", { req }));
    client.on("exitPlanRequest", (req) => emit("exitPlanRequest", { req }));
    client.on("planAutoApproved", (req) => emit("planAutoApproved", { req }));
    client.on("questionRequest", (req) => emit("questionRequest", { req }));
    client.on("fsWrite", (info) => emit("fsWrite", info));
    client.on("terminalCreate", (info) => emit("terminalCreate", info));
    client.on("commandDone", (info) => emit("commandDone", info));
    client.on("stderr", (text) => {
      emit("stderr", { text });
      if (/402|Payment Required|spending-limit|out of credits/i.test(text)) {
        this.broadcast({
          type: "error",
          error:
            "Grok spending limit (402). Add credits at https://grok.com/?_s=usage or switch Engine → Headless.",
        });
      }
    });
    client.on("promptStart", ({ text }) => {
      this.busy = true;
      emit("promptStart", { prompt: text });
    });
    client.on("promptComplete", (result) => {
      this.busy = false;
      emit("promptComplete", { result });
    });
    client.on("exit", (code) => {
      this.busy = false;
      this.client = null;
      emit("exit", { code });
    });
    client.on("error", (err) => emit("error", { error: err.message }));
  }

  async restart() {
    if (this.client) {
      await this.client.dispose();
      this.client = null;
    }
    return this.ensure();
  }

  async prompt(text) {
    const client = await this.ensure();
    const settings = this.getSettings();
    client.setAlwaysApprove(settings.alwaysApprove);

    if (settings.model && settings.model !== client.currentModelId) {
      try {
        await client.setModel(settings.model);
      } catch (err) {
        this.log(`[acp] model switch: ${err.message}`);
      }
    }

    if (this.busy) {
      throw new Error("A prompt is already running. Stop it first.");
    }

    return client.prompt(text);
  }

  cancel() {
    this.client?.cancel("ui");
    this.busy = false;
  }

  answerPermission(requestId, optionId) {
    this.client?.respondPermission(requestId, optionId);
  }

  answerPlan(requestId, verdict) {
    this.client?.respondExitPlan(requestId, verdict);
  }

  answerQuestion(requestId, answers) {
    this.client?.respondQuestion(requestId, answers);
  }

  cancelQuestion(requestId) {
    this.client?.respondQuestionCancelled(requestId);
  }

  async dispose() {
    if (this.client) await this.client.dispose();
    this.client = null;
  }
}

function simplifyTool(payload) {
  const tc = payload?.toolCall || payload;
  return {
    toolCallId: tc?.toolCallId || payload?.toolCallId,
    title: tc?.title || payload?.title || "tool",
    kind: tc?.kind || payload?.kind,
    status: tc?.status || payload?.status,
    rawInput: tc?.rawInput || payload?.rawInput,
    content: tc?.content || payload?.content,
    sessionUpdate: payload?.sessionUpdate,
  };
}
