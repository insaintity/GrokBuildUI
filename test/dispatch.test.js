import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAcpLine,
  routeSessionUpdate,
  pickAllowOption,
  makePermissionResponse,
} from "../server/acp/dispatch.js";
import { parseModels, parseSessions } from "../server/grok.js";

test("parseAcpLine response", () => {
  const ev = parseAcpLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  assert.equal(ev.kind, "response");
  assert.equal(ev.id, 1);
  assert.deepEqual(ev.result, { ok: true });
});

test("parseAcpLine session/update", () => {
  const ev = parseAcpLine(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
    }),
  );
  assert.equal(ev.kind, "session-update");
  assert.equal(ev.update.sessionUpdate, "agent_message_chunk");
});

test("parseAcpLine server request", () => {
  const ev = parseAcpLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "session/request_permission",
      params: { options: [] },
    }),
  );
  assert.equal(ev.kind, "server-request");
  assert.equal(ev.method, "session/request_permission");
});

test("routeSessionUpdate chunks", () => {
  assert.deepEqual(
    routeSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "A" },
    }),
    { event: "messageChunk", text: "A" },
  );
  assert.deepEqual(
    routeSessionUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "think" },
    }),
    { event: "thoughtChunk", text: "think" },
  );
  assert.equal(routeSessionUpdate({ sessionUpdate: "tool_call", title: "x" }).event, "toolCall");
});

test("pickAllowOption prefers allow_always", () => {
  const opt = pickAllowOption([
    { optionId: "reject", kind: "reject_once" },
    { optionId: "once", kind: "allow_once" },
    { optionId: "always", kind: "allow_always" },
  ]);
  assert.equal(opt.optionId, "always");
});

test("makePermissionResponse shape", () => {
  const r = makePermissionResponse(42, "allow_once");
  assert.equal(r.id, 42);
  assert.equal(r.result.outcome.optionId, "allow_once");
});

test("parseModels from grok models output", () => {
  const text = `You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
`;
  const parsed = parseModels(text);
  assert.equal(parsed.defaultModel, "grok-4.5");
  assert.equal(parsed.models[0].id, "grok-4.5");
  assert.equal(parsed.models[0].default, true);
});

test("parseSessions table rows", () => {
  const text = `SESSION ID                            CREATED     UPDATED     STATUS      SUMMARY
019f7957-a536-7622-864e-6c165809dd72  2026-07-19  2026-07-19  local  reply with exactly: OK
`;
  const sessions = parseSessions(text);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "019f7957-a536-7622-864e-6c165809dd72");
  assert.match(sessions[0].title, /reply with exactly/);
});
