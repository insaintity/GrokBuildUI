/**
 * ACP wire helpers — parse lines and route session/update events.
 * Aligned with https://docs.x.ai/build/cli/headless-scripting (ACP section)
 * and community extension protocol shapes.
 */

export function parseAcpLine(line) {
  if (!line.trim()) return null;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return { kind: "non-json", line };
  }
  if (msg.id != null && msg.method == null) {
    return { kind: "response", id: msg.id, result: msg.result, error: msg.error };
  }
  if (msg.method === "session/update") {
    return { kind: "session-update", update: msg.params?.update };
  }
  if (msg.method) {
    return { kind: "server-request", id: msg.id, method: msg.method, params: msg.params };
  }
  return null;
}

export function routeSessionUpdate(u) {
  if (!u) return null;
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      return { event: "messageChunk", text: u.content?.text ?? "" };
    case "user_message_chunk":
      return { event: "userMessageChunk", text: u.content?.text ?? "" };
    case "agent_thought_chunk":
      return { event: "thoughtChunk", text: u.content?.text ?? "" };
    case "tool_call":
      return { event: "toolCall", payload: u };
    case "tool_call_update":
      return { event: "toolCallUpdate", payload: u };
    case "plan":
      return { event: "plan", payload: u };
    case "current_mode_update":
      return { event: "modeChanged", modeId: u.currentModeId };
    case "available_commands_update":
      return { event: "commandsUpdate", commands: u.availableCommands ?? [] };
    default:
      return { event: "update", payload: u };
  }
}

export function makeRequest(id, method, params) {
  return { jsonrpc: "2.0", id, method, params };
}

export function makeAckResponse(id, result = {}) {
  return { jsonrpc: "2.0", id, result };
}

export function makePermissionResponse(id, optionId) {
  return {
    jsonrpc: "2.0",
    id,
    result: { outcome: { outcome: "selected", optionId } },
  };
}

export function makeExitPlanResponse(id, verdict) {
  if (verdict === "approved") {
    return { jsonrpc: "2.0", id, result: { outcome: "approved" } };
  }
  const message = verdict === "rejected" ? "User rejected the plan" : "User abandoned the plan";
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

export function makeQuestionResponse(id, answers, annotations = {}) {
  return { jsonrpc: "2.0", id, result: { outcome: "accepted", answers, annotations } };
}

export function makeQuestionCancelledResponse(id) {
  return { jsonrpc: "2.0", id, result: { outcome: "cancelled" } };
}

/** Prefer allow_always, then allow_once, for auto-approve. */
export function pickAllowOption(options = []) {
  const list = Array.isArray(options) ? options : [];
  return (
    list.find((o) => /allow_always|allow-always|always/i.test(o.kind || o.optionId || "")) ||
    list.find((o) => /allow_once|allow-once|allow/i.test(o.kind || o.optionId || "")) ||
    list[0] ||
    null
  );
}
