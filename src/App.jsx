import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API = "";

async function api(path, options) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function extractHeadless(json) {
  if (!json || typeof json !== "object") return null;
  if (json.type === "text" && typeof json.data === "string") return { kind: "text", text: json.data };
  if (json.type === "thought" && typeof json.data === "string") return { kind: "thought", text: json.data };
  if (json.type === "end") return { kind: "end", meta: json };
  return null;
}

function newAssistant() {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: "",
    thought: "",
    tools: [],
    streaming: true,
    permissions: [],
    plans: [],
    commands: [],
  };
}

export default function App() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState([]);
  const [running, setRunning] = useState(false);
  const [sessionMode, setSessionMode] = useState("continue");
  const [resumeSessionId, setResumeSessionId] = useState("");
  const [effort, setEffort] = useState("");
  const [engine, setEngine] = useState("acp");
  const [commitMsg, setCommitMsg] = useState("chore: update from GrokBuildUI");
  const [toast, setToast] = useState("");
  const [cmdOut, setCmdOut] = useState("");
  const [showThinking, setShowThinking] = useState(true);
  const [pendingPermission, setPendingPermission] = useState(null);
  const [pendingPlan, setPendingPlan] = useState(null);
  const [pendingQuestion, setPendingQuestion] = useState(null);
  const [acpConnecting, setAcpConnecting] = useState(false);

  const wsRef = useRef(null);
  const feedRef = useRef(null);
  const draftRef = useRef({ thought: "", text: "" });
  const reconnectRef = useRef(0);
  const engineRef = useRef(engine);
  const handlersRef = useRef({});

  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);

  const flash = useCallback((text) => {
    setToast(text);
    setTimeout(() => setToast(""), 3200);
  }, []);

  const model = status?.model || "";
  const models =
    status?.models?.models ||
    status?.acpModels?.map((m) => ({
      id: m.modelId,
      name: m.name || m.modelId,
    })) ||
    [];
  const git = status?.git;

  const refresh = useCallback(async () => {
    try {
      const data = await api("/api/status");
      setStatus(data);
      if (data.sessionMode) setSessionMode(data.sessionMode);
      if (typeof data.resumeSessionId === "string") setResumeSessionId(data.resumeSessionId || "");
      if (typeof data.effort === "string") setEffort(data.effort || "");
      if (data.engine) setEngine(data.engine);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  const patchAssistant = useCallback((mutator) => {
    setMessages((prev) => {
      const next = [...prev];
      let last = next[next.length - 1];
      if (!last || last.role !== "assistant") {
        last = newAssistant();
        next.push(last);
      }
      next[next.length - 1] = mutator({ ...last });
      return next;
    });
  }, []);

  handlersRef.current = {
    flash,
    refresh,
    patchAssistant,
    handleAcp(msg) {
      const { flash, refresh, patchAssistant } = handlersRef.current;
      switch (msg.event) {
        case "ready":
          setAcpConnecting(false);
          flash(`ACP ready · ${msg.sessionId?.slice(0, 8) || "session"}`);
          refresh();
          break;
        case "promptStart":
          setRunning(true);
          draftRef.current = { thought: "", text: "" };
          break;
        case "messageChunk":
          draftRef.current.text += msg.text || "";
          patchAssistant((a) => ({ ...a, text: draftRef.current.text, streaming: true }));
          break;
        case "thoughtChunk":
          draftRef.current.thought += msg.text || "";
          patchAssistant((a) => ({ ...a, thought: draftRef.current.thought, streaming: true }));
          break;
        case "toolCall":
        case "toolCallUpdate": {
          patchAssistant((a) => {
            const call = msg.call || {};
            const id = call.toolCallId || call.title;
            const tools = [...(a.tools || [])];
            const idx = tools.findIndex((t) => t.toolCallId === id || t.title === call.title);
            const entry = {
              toolCallId: call.toolCallId,
              title: call.title || "tool",
              kind: call.kind,
              status: call.status || (msg.event === "toolCall" ? "pending" : "running"),
            };
            if (idx >= 0) tools[idx] = { ...tools[idx], ...entry };
            else tools.push(entry);
            return { ...a, tools };
          });
          break;
        }
        case "terminalCreate":
          patchAssistant((a) => ({
            ...a,
            commands: [...(a.commands || []), { command: msg.command, status: "running" }],
          }));
          break;
        case "commandDone":
          patchAssistant((a) => {
            const commands = [...(a.commands || [])];
            if (commands.length) {
              commands[commands.length - 1] = {
                ...commands[commands.length - 1],
                status: "done",
                exitCode: msg.exitCode,
                output: msg.output,
              };
            }
            return { ...a, commands };
          });
          break;
        case "fsWrite":
          patchAssistant((a) => ({
            ...a,
            tools: [
              ...(a.tools || []),
              { title: `write ${msg.path}`, kind: "edit", status: "completed" },
            ],
          }));
          break;
        case "permissionRequest":
          setPendingPermission(msg.req);
          break;
        case "permissionAuto":
          patchAssistant((a) => ({
            ...a,
            permissions: [
              ...(a.permissions || []),
              {
                auto: true,
                title: msg.req?.toolCall?.title || "tool",
                optionId: msg.req?.optionId,
              },
            ],
          }));
          break;
        case "exitPlanRequest":
          setPendingPlan(msg.req);
          break;
        case "planAutoApproved":
          flash("Plan auto-approved");
          break;
        case "questionRequest":
          setPendingQuestion(msg.req);
          break;
        case "billingBlocked":
          setError(
            "Grok spending limit (402). Auto-fallback will try Headless if enabled.",
          );
          break;
        case "promptComplete":
          setRunning(false);
          patchAssistant((a) => ({ ...a, streaming: false }));
          refresh();
          break;
        case "exit":
          setRunning(false);
          setAcpConnecting(false);
          break;
        case "error":
          setError(msg.error || "ACP error");
          setRunning(false);
          setAcpConnecting(false);
          break;
        default:
          break;
      }
    },
  };

  useEffect(() => {
    let closed = false;
    let timer;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectRef.current = 0;
        if (engineRef.current === "acp") {
          ws.send(JSON.stringify({ type: "acp/ensure" }));
        }
      };

      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }

        const { flash, refresh, patchAssistant, handleAcp } = handlersRef.current;

        if (msg.type === "error") {
          setError(msg.error || "Unknown error");
          setRunning(false);
          setAcpConnecting(false);
          return;
        }

        if (msg.type === "acp") {
          handleAcp(msg);
          return;
        }

        if (msg.type !== "run") return;

        if (msg.event === "fallback") {
          flash(`ACP hit ${msg.reason || "error"} — retrying via Headless…`);
          setEngine("headless");
          return;
        }

        if (msg.event === "start") {
          setRunning(true);
          draftRef.current = { thought: "", text: "" };
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            const lastUser = [...prev].reverse().find((m) => m.role === "user");
            // Avoid duplicating when ACP already opened a turn, or fallback retries.
            if (lastUser?.text === msg.prompt && last?.role === "assistant") {
              return [
                ...prev.slice(0, -1),
                { ...last, text: last.text || "", thought: "", tools: last.tools || [], streaming: true },
              ];
            }
            return [
              ...prev,
              { id: crypto.randomUUID(), role: "user", text: msg.prompt },
              newAssistant(),
            ];
          });
        }

        if (msg.event === "chunk" && msg.json) {
          const bit = extractHeadless(msg.json);
          if (!bit) return;
          if (bit.kind === "thought") draftRef.current.thought += bit.text;
          if (bit.kind === "text") draftRef.current.text += bit.text;
          patchAssistant((a) => ({
            ...a,
            thought: bit.kind === "thought" ? draftRef.current.thought : a.thought,
            text: bit.kind === "text" ? draftRef.current.text : a.text,
            streaming: bit.kind !== "end",
            meta: bit.kind === "end" ? bit.meta : a.meta,
          }));
        }

        if (msg.event === "stderr" && msg.text) {
          patchAssistant((a) => ({ ...a, stderr: `${a.stderr || ""}${msg.text}` }));
          if (/402|Payment Required|spending-limit|out of credits/i.test(msg.text)) {
            setError(
              "Grok API hit a spending limit (402). Add credits / upgrade at grok.com, or try Headless engine if free-tier still works.",
            );
          }
        }

        if (msg.event === "end" || msg.event === "cancelled" || msg.event === "error") {
          setRunning(false);
          if (msg.error) setError(msg.error);
          patchAssistant((a) => ({
            ...a,
            streaming: false,
            text:
              a.text ||
              draftRef.current.text ||
              (msg.event === "cancelled" ? "(cancelled)" : a.text),
          }));
          refresh();
        }
      };

      ws.onclose = () => {
        if (closed) return;
        const delay = Math.min(4000, 500 + reconnectRef.current * 500);
        reconnectRef.current += 1;
        timer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pendingPermission, pendingPlan]);

  const saveSettings = async (patch) => {
    const data = await api("/api/settings", { method: "POST", body: JSON.stringify(patch) });
    setStatus((s) => ({ ...s, ...data }));
    if (data.engine) setEngine(data.engine);
    await refresh();
    return data;
  };

  const sendPrompt = () => {
    const text = prompt.trim();
    if (!text || running || !wsRef.current || wsRef.current.readyState !== 1) return;
    if (engine === "headless" && sessionMode === "resume" && !resumeSessionId) {
      setError("Pick a session to resume, or switch to Continue / Fresh.");
      return;
    }
    draftRef.current = { thought: "", text: "" };
    wsRef.current.send(
      JSON.stringify({
        type: "prompt",
        prompt: text,
        engine,
        sessionMode,
        resumeSessionId: sessionMode === "resume" ? resumeSessionId : undefined,
      }),
    );
    setPrompt("");
  };

  const cancelRun = () => {
    wsRef.current?.send(JSON.stringify({ type: "cancel" }));
    api("/api/run/cancel", { method: "POST", body: "{}" }).catch(() => {});
  };

  const pickFolder = async () => {
    if (window.grokDesktop?.pickFolder) {
      const folder = await window.grokDesktop.pickFolder();
      if (folder) {
        setAcpConnecting(true);
        await saveSettings({ projectPath: folder });
        flash(`Project → ${folder}`);
      }
      return;
    }
    const next = window.prompt("Project folder path", status?.projectPath || "");
    if (next) {
      setAcpConnecting(true);
      await saveSettings({ projectPath: next });
      flash(`Project → ${next}`);
    }
  };

  const runCommand = async (name) => {
    try {
      setCmdOut(`Running ${name}…`);
      const result = await api("/api/command", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setCmdOut(result.combined || result.stdout || result.stderr || "(empty)");
      flash(`${name} done`);
      await refresh();
    } catch (err) {
      setCmdOut(err.message);
      setError(err.message);
    }
  };

  const loadInspect = async () => {
    try {
      const data = await api("/api/inspect");
      setCmdOut(
        typeof data.json === "object"
          ? JSON.stringify(data.json, null, 2)
          : data.raw || "(empty)",
      );
      flash("Inspect loaded");
    } catch (err) {
      setError(err.message);
    }
  };

  const exportSession = async () => {
    try {
      const data = await api("/api/sessions/export", {
        method: "POST",
        body: JSON.stringify({
          sessionId: resumeSessionId || status?.acpSessionId || undefined,
        }),
      });
      setCmdOut(data.markdown?.slice(0, 4000) || data.path || "(exported)");
      flash(data.path ? `Exported → ${data.path}` : "Exported");
    } catch (err) {
      setError(err.message);
    }
  };

  const resumeSession = async (session) => {
    if (!session?.id) return;
    setResumeSessionId(session.id);
    setSessionMode("resume");
    setAcpConnecting(true);
    await saveSettings({ sessionMode: "resume", resumeSessionId: session.id });
    flash(`Resume → ${session.title || session.id.slice(0, 8)}`);
  };

  const openDocs = (url) => {
    if (window.grokDesktop?.openExternal) window.grokDesktop.openExternal(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  };

  const gitAction = async (kind) => {
    try {
      if (kind === "commit") {
        const r = await api("/api/git/commit", {
          method: "POST",
          body: JSON.stringify({ message: commitMsg }),
        });
        flash(r.noop ? "Nothing to commit" : "Committed");
      } else if (kind === "push") {
        await api("/api/git/push", { method: "POST", body: JSON.stringify({ setUpstream: true }) });
        flash("Pushed to GitHub");
      } else if (kind === "pr") {
        const r = await api("/api/git/pr", {
          method: "POST",
          body: JSON.stringify({ title: commitMsg }),
        });
        flash(r.url ? `PR: ${r.url}` : "PR ready");
        if (r.url && window.grokDesktop?.openExternal) window.grokDesktop.openExternal(r.url);
        else if (r.url) window.open(r.url, "_blank");
      }
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const answerPermission = (optionId) => {
    if (!pendingPermission) return;
    wsRef.current?.send(
      JSON.stringify({
        type: "permissionAnswer",
        requestId: pendingPermission.id,
        optionId,
      }),
    );
    patchAssistant((a) => ({
      ...a,
      permissions: [
        ...(a.permissions || []),
        { title: pendingPermission.toolCall?.title || "tool", optionId },
      ],
    }));
    setPendingPermission(null);
  };

  const answerPlan = (verdict) => {
    if (!pendingPlan) return;
    wsRef.current?.send(
      JSON.stringify({ type: "planAnswer", requestId: pendingPlan.id, verdict }),
    );
    setPendingPlan(null);
    flash(`Plan ${verdict}`);
  };

  const heroSub = useMemo(() => {
    if (!status?.grok) return "Install Grok Build CLI to get started";
    const eng = engine === "acp" ? "ACP" : "Headless";
    if (git?.isRepo) {
      return `${eng} · ${git.branch || "branch"} · ${git.dirty ? "uncommitted changes" : "clean"}`;
    }
    return `${eng} · pick a project and build`;
  }, [status, git, engine]);

  return (
    <div className="app">
      <div className="atmosphere" aria-hidden />

      <header className="topbar">
        <div className="brand-wrap">
          <p className="brand">GrokBuildUI</p>
          <p className="tagline">{heroSub}</p>
        </div>
        <div className="top-actions">
          {acpConnecting && <span className="pill">Connecting ACP…</span>}
          <button type="button" className="ghost" onClick={refresh}>
            Refresh
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setMessages([]);
              setPendingPermission(null);
              setPendingPlan(null);
              setPendingQuestion(null);
              setError("");
              flash("Chat cleared");
            }}
          >
            Clear chat
          </button>
          <button
            type="button"
            className="ghost"
            onClick={async () => {
              setAcpConnecting(true);
              setMessages([]);
              try {
                await api("/api/acp/new", { method: "POST", body: "{}" });
                setSessionMode("fresh");
                setResumeSessionId("");
                flash("New ACP session");
              } catch (err) {
                setError(err.message);
              } finally {
                setAcpConnecting(false);
                refresh();
              }
            }}
          >
            New session
          </button>
          <button
            type="button"
            className="ghost"
            onClick={async () => {
              setAcpConnecting(true);
              try {
                await api("/api/acp/restart", { method: "POST", body: "{}" });
                flash("ACP restarted");
              } catch (err) {
                setError(err.message);
              } finally {
                setAcpConnecting(false);
                refresh();
              }
            }}
          >
            Restart agent
          </button>
          <button type="button" className="primary-soft" onClick={pickFolder}>
            Open project
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="chat-panel">
          <div className="chat-meta">
            <label className="field">
              <span>Engine</span>
              <select
                value={engine}
                onChange={async (e) => {
                  const next = e.target.value;
                  setEngine(next);
                  await saveSettings({ engine: next });
                  if (next === "acp") {
                    setAcpConnecting(true);
                    wsRef.current?.send(JSON.stringify({ type: "acp/ensure" }));
                  }
                }}
              >
                <option value="acp">ACP (recommended)</option>
                <option value="headless">Headless (-p)</option>
              </select>
            </label>
            <label className="field">
              <span>Model</span>
              <select value={model || ""} onChange={(e) => saveSettings({ model: e.target.value })}>
                {(models.length
                  ? models
                  : [{ id: model || "grok-4.5", name: model || "grok-4.5" }]
                ).map((m) => (
                  <option key={m.id || m.modelId} value={m.id || m.modelId}>
                    {m.name || m.id || m.modelId}
                    {m.default ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Session</span>
              <select
                value={sessionMode}
                onChange={async (e) => {
                  const next = e.target.value;
                  setSessionMode(next);
                  await saveSettings({ sessionMode: next });
                }}
              >
                <option value="continue">Continue</option>
                <option value="resume">Resume</option>
                <option value="fresh">Fresh</option>
              </select>
            </label>
            <label className="field">
              <span>Effort</span>
              <select
                value={effort}
                onChange={async (e) => {
                  const next = e.target.value;
                  setEffort(next);
                  setAcpConnecting(true);
                  await saveSettings({ effort: next });
                }}
              >
                <option value="">Default</option>
                {["none", "minimal", "low", "medium", "high", "xhigh"].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={Boolean(status?.alwaysApprove)}
                onChange={(e) => saveSettings({ alwaysApprove: e.target.checked })}
              />
              <span>Always approve</span>
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={status?.autoFallback !== false}
                onChange={(e) => saveSettings({ autoFallback: e.target.checked })}
              />
              <span>Fallback on 402</span>
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={showThinking}
                onChange={(e) => setShowThinking(e.target.checked)}
              />
              <span>Show thinking</span>
            </label>
          </div>

          <div className="project-path" title={status?.projectPath}>
            <span>Project</span>
            <code>{status?.projectPath || "…"}</code>
            {status?.acpSessionId && (
              <code className="resume-chip">acp {status.acpSessionId.slice(0, 8)}</code>
            )}
            {sessionMode === "resume" && resumeSessionId && (
              <code className="resume-chip">resume {resumeSessionId.slice(0, 8)}</code>
            )}
          </div>

          <div className="feed" ref={feedRef}>
            {messages.length === 0 && (
              <div className="empty">
                <h1>Build without the terminal</h1>
                <p>
                  Default engine is <strong>ACP</strong> (<code>grok agent stdio</code>) — the IDE
                  integration path from the{" "}
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => openDocs("https://docs.x.ai/build/cli/headless-scripting")}
                  >
                    official docs
                  </button>
                  . Headless <code>-p</code> remains available as a fallback.
                </p>
              </div>
            )}

            {messages.map((m) => (
              <article key={m.id} className={`bubble ${m.role}`}>
                <header>{m.role === "user" ? "You" : "Grok"}</header>
                {m.role === "assistant" && showThinking && m.thought && (
                  <pre className="thought">{m.thought}</pre>
                )}
                {m.tools?.length > 0 && (
                  <ul className="tools">
                    {m.tools.map((t, i) => (
                      <li key={`${m.id}-t-${i}`}>
                        <span className={`dot ${t.status || ""}`} />
                        {t.title}
                        {t.kind ? ` · ${t.kind}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
                {m.commands?.length > 0 && (
                  <ul className="tools cmd-tools">
                    {m.commands.map((c, i) => (
                      <li key={`${m.id}-c-${i}`}>
                        <code>$ {c.command}</code>
                        {c.status === "done" && (
                          <span className="muted"> exit {c.exitCode ?? "?"}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {m.permissions?.length > 0 && (
                  <ul className="tools perms">
                    {m.permissions.map((p, i) => (
                      <li key={`${m.id}-p-${i}`}>
                        {p.auto ? "auto-approved" : "approved"} · {p.title}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="body">
                  {m.text || (m.streaming ? "…" : "")}
                  {m.streaming && <span className="cursor" />}
                </div>
                {m.stderr && <pre className="stderr">{m.stderr}</pre>}
              </article>
            ))}

            {pendingPermission && (
              <div className="card-interact permission-card">
                <h3>Permission needed</h3>
                <p>{pendingPermission.toolCall?.title || "Tool request"}</p>
                {pendingPermission.toolCall?.kind && (
                  <p className="muted">Kind: {pendingPermission.toolCall.kind}</p>
                )}
                <div className="btn-row">
                  {(pendingPermission.options || []).map((o) => (
                    <button
                      key={o.optionId}
                      type="button"
                      className={/allow/i.test(o.kind || "") ? "accent" : ""}
                      onClick={() => answerPermission(o.optionId)}
                    >
                      {o.name || o.optionId}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {pendingPlan && (
              <div className="card-interact plan-card">
                <h3>Plan review</h3>
                <pre className="plan-body">{pendingPlan.plan || "(empty plan)"}</pre>
                <div className="btn-row">
                  <button type="button" className="accent" onClick={() => answerPlan("approved")}>
                    Approve
                  </button>
                  <button type="button" onClick={() => answerPlan("rejected")}>
                    Reject
                  </button>
                  <button type="button" className="ghost" onClick={() => answerPlan("abandoned")}>
                    Abandon
                  </button>
                </div>
              </div>
            )}

            {pendingQuestion && (
              <div className="card-interact question-card">
                <h3>Grok has a question</h3>
                {(pendingQuestion.questions || []).map((q, i) => (
                  <div key={i} className="q-block">
                    <p>{q.question}</p>
                    <div className="btn-row">
                      {(q.options || []).map((opt) => (
                        <button
                          key={opt.label}
                          type="button"
                          onClick={() => {
                            wsRef.current?.send(
                              JSON.stringify({
                                type: "questionAnswer",
                                requestId: pendingQuestion.id,
                                answers: { [q.question]: opt.label },
                              }),
                            );
                            setPendingQuestion(null);
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    wsRef.current?.send(
                      JSON.stringify({
                        type: "questionCancel",
                        requestId: pendingQuestion.id,
                      }),
                    );
                    setPendingQuestion(null);
                  }}
                >
                  Skip
                </button>
              </div>
            )}
          </div>

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              sendPrompt();
            }}
          >
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Tell Grok what to build…"
              rows={3}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  sendPrompt();
                }
              }}
            />
            <div className="composer-actions">
              {running ? (
                <button type="button" className="danger" onClick={cancelRun}>
                  Stop
                </button>
              ) : (
                <button type="submit" className="primary" disabled={!prompt.trim()}>
                  Run Grok
                </button>
              )}
              <span className="hint">Ctrl+Enter · engine {engine}</span>
            </div>
          </form>
        </section>

        <aside className="side">
          <section className="card-block github">
            <h2>GitHub</h2>
            <p className="muted">
              {git?.isRepo
                ? `${git.branch}${git.remote ? " → origin" : " (no remote)"}`
                : "Not a git repo"}
            </p>
            {git?.isRepo && (
              <>
                <ul className="file-list">
                  {(git.files || []).slice(0, 8).map((f) => (
                    <li key={f.path}>
                      <code>{f.code}</code> {f.path}
                    </li>
                  ))}
                  {(git.files || []).length === 0 && <li className="muted">Working tree clean</li>}
                  {(git.files || []).length > 8 && (
                    <li className="muted">+{(git.files || []).length - 8} more</li>
                  )}
                </ul>
                <input
                  className="commit-input"
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  placeholder="Commit message"
                />
                <div className="btn-row">
                  <button type="button" onClick={() => gitAction("commit")}>
                    Commit all
                  </button>
                  <button type="button" className="accent" onClick={() => gitAction("push")}>
                    Push
                  </button>
                  <button type="button" onClick={() => gitAction("pr")}>
                    Open PR
                  </button>
                </div>
              </>
            )}
          </section>

          <section className="card-block commands">
            <h2>Grok commands</h2>
            <div className="btn-grid">
              {[
                ["login", "Login"],
                ["login-device", "Device login"],
                ["logout", "Logout"],
                ["models", "Models"],
                ["sessions-list", "Sessions"],
                ["mcp-list", "MCP list"],
                ["update", "Update CLI"],
                ["version", "Version"],
              ].map(([id, label]) => (
                <button key={id} type="button" onClick={() => runCommand(id)}>
                  {label}
                </button>
              ))}
              <button type="button" onClick={loadInspect}>
                Inspect JSON
              </button>
              <button type="button" onClick={exportSession}>
                Export MD
              </button>
            </div>
            {cmdOut && <pre className="cmd-out">{cmdOut}</pre>}
          </section>

          <section className="card-block sessions">
            <h2>Sessions</h2>
            <p className="muted">Click to resume</p>
            <ul className="session-list">
              {(status?.sessions || []).slice(0, 8).map((s, i) => (
                <li key={s.id || i}>
                  <button
                    type="button"
                    className={`session-btn ${resumeSessionId === s.id ? "active" : ""}`}
                    onClick={() => resumeSession(s)}
                    disabled={!s.id}
                  >
                    <strong>{s.title || s.id || "Session"}</strong>
                    {s.id && <code>{s.id.slice(0, 8)}</code>}
                  </button>
                </li>
              ))}
              {(status?.sessions || []).length === 0 && (
                <li className="muted">No sessions yet</li>
              )}
            </ul>
          </section>

          <section className="card-block status">
            <h2>Status</h2>
            <dl>
              <div>
                <dt>CLI</dt>
                <dd>{status?.version || "—"}</dd>
              </div>
              <div>
                <dt>Engine</dt>
                <dd>
                  {engine}
                  {status?.acpReady ? " · ready" : ""}
                  {status?.billingBlocked ? " · billing-blocked" : ""}
                  {running ? " · running" : " · idle"}
                </dd>
              </div>
              <div>
                <dt>Auth</dt>
                <dd>{status?.hasApiKey ? "XAI_API_KEY" : "cached login"}</dd>
              </div>
              <div>
                <dt>Binary</dt>
                <dd className="truncate">{status?.grok || "missing"}</dd>
              </div>
            </dl>
            <div className="btn-row docs-row">
              <button
                type="button"
                className="ghost"
                onClick={() => openDocs("https://docs.x.ai/build/overview")}
              >
                Overview
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => openDocs("https://docs.x.ai/build/cli/headless-scripting")}
              >
                ACP / Headless
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => openDocs("https://docs.x.ai/build/cli/reference")}
              >
                CLI ref
              </button>
            </div>
          </section>
        </aside>
      </main>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
