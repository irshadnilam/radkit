import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import {
  getAgentDetail,
  getTaskHistory,
  listContexts,
  listContextTasks,
  sendMessageStream,
  resubscribeTaskStream,
  type StreamEvent,
  type TaskSummary,
} from "../api/client";
import type {
  Artifact,
  Task,
  TaskState,
  TaskStatusUpdateEvent,
} from "../types/a2a_v1";
import {
  isInputRequired,
  isTerminalState,
  messageText,
  partsToText,
  parseStreamResponse,
  stateLabel,
} from "../types/a2a_v1";
import ArtifactPreview from "../components/ArtifactPreview";

export async function loader(_args: LoaderFunctionArgs) {
  const detail = await getAgentDetail();
  return { detail };
}

function shortenId(id: string): string {
  return `${id.slice(0, 6)}...${id.slice(-4)}`;
}

// ── Console entry types ───────────────────────────────────────────────────────

type ConsoleEntryType = "user" | "agent" | "status" | "artifact" | "task" | "negotiation";

interface ConsoleEntry {
  id: string;
  type: ConsoleEntryType;
  title: string;
  body?: string;
  subtext?: string;
  taskId?: string;
  contextId?: string;
  timestamp: string;
  badge?: string;
  artifact?: Artifact;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AgentDetail() {
  const { detail } = useLoaderData<Awaited<ReturnType<typeof loader>>>();

  const [availableContexts, setAvailableContexts] = useState<string[]>([]);
  const [contextId, setContextId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<ConsoleEntry[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [inspectedTask, setInspectedTask] = useState<{
    taskId: string;
    entries: ConsoleEntry[];
    task?: Task;
  } | null>(null);
  const [inspecting, setInspecting] = useState(false);

  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [isInNegotiation, setIsInNegotiation] = useState(false);
  const streamCancelRef = useRef<(() => void) | null>(null);
  const contextIdRef = useRef<string | null>(null);
  const [showAgentInfo, setShowAgentInfo] = useState(false);
  const consoleContainerRef = useRef<HTMLDivElement | null>(null);

  // ── Helpers ─────────────────────────────────────────────────────────────────

  const refreshContexts = useCallback(async () => {
    try {
      setAvailableContexts(await listContexts());
    } catch (err) {
      console.error(err);
    }
  }, []);

  const ensureContextListed = useCallback((ctxId: string) => {
    if (!ctxId) return;
    setAvailableContexts((prev) => (prev.includes(ctxId) ? prev : [ctxId, ...prev]));
  }, []);

  const upsertTaskFromEvent = useCallback((incoming: Task) => {
    setTasks((prev) => {
      const idx = prev.findIndex((s) => s.task.id === incoming.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], task: { ...incoming } };
        return next;
      }
      return [{ task: incoming }, ...prev];
    });
  }, []);

  const applyStatusUpdate = useCallback((event: TaskStatusUpdateEvent) => {
    setTasks((prev) => {
      const idx = prev.findIndex((s) => s.task.id === event.taskId);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          task: { ...next[idx].task, status: event.status },
        };
        return next;
      }
      // Create a placeholder task so the sidebar shows it immediately.
      const placeholder: Task = {
        id: event.taskId,
        contextId: event.contextId,
        status: event.status,
        artifacts: [],
        history: [],
      };
      return [{ task: placeholder }, ...prev];
    });
  }, []);

  const cancelActiveStream = useCallback(() => {
    streamCancelRef.current?.();
    streamCancelRef.current = null;
  }, []);

  const pushEntry = useCallback((entry: ConsoleEntry) => {
    setTimeline((prev) =>
      prev.some((e) => e.id === entry.id) ? prev : [...prev, entry]
    );
  }, []);

  // ── Stream event processing ──────────────────────────────────────────────────

  const processStreamEvent = useCallback(
    (event: StreamEvent) => {
      // Update context tracking.
      const ctxId =
        event.type === "task"
          ? event.data.contextId
          : event.type === "message"
          ? event.data.contextId
          : event.type === "statusUpdate"
          ? event.data.contextId
          : event.type === "artifactUpdate"
          ? event.data.contextId
          : undefined;

      if (ctxId) {
        ensureContextListed(ctxId);
        setContextId((prev) => prev ?? ctxId);
      }

      // Update task state.
      if (event.type === "task") {
        upsertTaskFromEvent(event.data);
        const state = event.data.status?.state;
        if (state && isInputRequired(state)) {
          setIsInNegotiation(false);
          setActiveTaskId(event.data.id);
        } else if (state && isTerminalState(state)) {
          setIsInNegotiation(false);
          setActiveTaskId(null);
        }
      } else if (event.type === "statusUpdate") {
        applyStatusUpdate(event.data);
        setIsInNegotiation(false);
        const state = event.data.status?.state;
        if (state && isInputRequired(state)) {
          setActiveTaskId(event.data.taskId);
        } else {
          setActiveTaskId((prev) => (prev === event.data.taskId ? null : prev));
        }
      } else if (event.type === "message") {
        if (!event.data.taskId) {
          setIsInNegotiation(true);
          setActiveTaskId(null);
        }
      }

      const entry = convertEventToEntry(event);
      if (entry) pushEntry(entry);
    },
    [applyStatusUpdate, ensureContextListed, pushEntry, upsertTaskFromEvent]
  );

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  useEffect(() => {
    refreshContexts();
  }, [refreshContexts]);

  useEffect(() => {
    contextIdRef.current = contextId;
  }, [contextId]);

  useEffect(() => () => cancelActiveStream(), [cancelActiveStream]);

  useEffect(() => {
    if (contextId) {
      listContextTasks(contextId).then(setTasks).catch(console.error);
    } else {
      setTasks([]);
    }
  }, [contextId]);

  // ── Active interaction ───────────────────────────────────────────────────────

  const activeInteraction = useMemo(() => {
    if (activeTaskId) {
      const task = tasks.find((t) => t.task.id === activeTaskId);
      const canReceiveInput =
        !!task && !!task.task.status?.state && isInputRequired(task.task.status.state);
      return { type: "task" as const, taskId: activeTaskId, task, canReceiveInput };
    }
    if (isInNegotiation) return { type: "negotiation" as const };
    if (contextId) return { type: "context" as const };
    return { type: "new" as const };
  }, [activeTaskId, isInNegotiation, contextId, tasks]);

  useEffect(() => {
    if (activeInteraction.type === "task" && !activeInteraction.canReceiveInput) {
      setActiveTaskId(null);
    }
  }, [activeInteraction]);

  // ── Send message ─────────────────────────────────────────────────────────────

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || isStreaming) return;

    if (activeTaskId) {
      const task = tasks.find((t) => t.task.id === activeTaskId);
      if (!task?.task.status?.state || !isInputRequired(task.task.status.state)) {
        setError("Cannot send message to this task — it is not waiting for input");
        return;
      }
    }

    setIsStreaming(true);
    setError(null);
    cancelActiveStream();

    const userMessage = inputValue;
    setInputValue("");

    setTimeline((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        type: "user",
        title: "You",
        body: userMessage,
        timestamp: new Date().toISOString(),
      },
    ]);

    try {
      const stream = sendMessageStream({
        messageText: userMessage,
        contextId: contextId ?? undefined,
        taskId: activeTaskId ?? undefined,
      });
      const iterator = stream[Symbol.asyncIterator]();
      streamCancelRef.current = () => iterator.return?.();

      for (;;) {
        const { value, done } = await iterator.next();
        if (done) break;
        if (value) processStreamEvent(value);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      cancelActiveStream();
      setIsStreaming(false);
      const ctx = contextIdRef.current;
      if (ctx) listContextTasks(ctx).then(setTasks).catch(console.error);
      refreshContexts();
    }
  };

  // ── Task inspection ──────────────────────────────────────────────────────────

  const handleInspectTask = useCallback(async (taskId: string) => {
    setInspecting(true);
    try {
      const history = await getTaskHistory(taskId);
      const entries: ConsoleEntry[] = history.events
        .map(({ result }) => convertEventToEntry(parseStreamResponse(result)!))
        .filter((e): e is ConsoleEntry => e != null);
      setInspectedTask({ taskId, entries, task: history.task });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load task");
    } finally {
      setInspecting(false);
    }
  }, []);

  const handleNewContext = () => {
    setContextId(null);
    setTimeline([]);
    setTasks([]);
    setInspectedTask(null);
    setActiveTaskId(null);
    setIsInNegotiation(false);
    refreshContexts();
  };

  const handleSelectContext = (ctxId: string) => {
    cancelActiveStream();
    setContextId(ctxId);
    setTimeline([]);
    setInspectedTask(null);
    setActiveTaskId(null);
    setIsInNegotiation(false);
  };

  const loadTaskHistoryIntoTimeline = useCallback(
    async (taskId: string) => {
      const history = await getTaskHistory(taskId);
      const entries = history.events
        .map(({ result }) => convertEventToEntry(parseStreamResponse(result)!))
        .filter((e): e is ConsoleEntry => e != null);
      const unique = [
        ...new Map(entries.map((e) => [e.id, e])).values(),
      ];
      setTimeline(unique);
      if (history.task?.contextId) {
        ensureContextListed(history.task.contextId);
        setContextId(history.task.contextId);
      }
      return history;
    },
    [ensureContextListed]
  );

  const handleSubscribeTask = useCallback(
    async (taskId: string) => {
      let contextForRefresh: string | null = null;
      try {
        setIsStreaming(true);
        cancelActiveStream();
        const history = await loadTaskHistoryIntoTimeline(taskId);
        if (history.task) {
          upsertTaskFromEvent(history.task);
          setIsInNegotiation(false);
          const state = history.task.status?.state;
          if (state && isInputRequired(state)) setActiveTaskId(taskId);
          contextForRefresh = history.task.contextId;
        }

        const stream = resubscribeTaskStream({ id: taskId });
        const iterator = stream[Symbol.asyncIterator]();
        streamCancelRef.current = () => iterator.return?.();

        for (;;) {
          const { value, done } = await iterator.next();
          if (done) break;
          if (value) processStreamEvent(value);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to subscribe to task");
      } finally {
        cancelActiveStream();
        setIsStreaming(false);
        refreshContexts();
        const ctx = contextForRefresh ?? contextIdRef.current;
        if (ctx) listContextTasks(ctx).then(setTasks).catch(console.error);
      }
    },
    [
      cancelActiveStream,
      loadTaskHistoryIntoTimeline,
      processStreamEvent,
      refreshContexts,
      upsertTaskFromEvent,
    ]
  );

  const handleStartNewInContext = () => {
    cancelActiveStream();
    setActiveTaskId(null);
    setIsInNegotiation(false);
    setTimeline([]);
  };

  const handleResumeTask = useCallback(
    async (taskId: string) => {
      try {
        cancelActiveStream();
        const history = await loadTaskHistoryIntoTimeline(taskId);
        if (history.task) {
          const state = history.task.status?.state;
          setActiveTaskId(state && isInputRequired(state) ? taskId : null);
          setIsInNegotiation(!(state && isInputRequired(state)));
          upsertTaskFromEvent(history.task);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to resume task");
      }
    },
    [cancelActiveStream, loadTaskHistoryIntoTimeline, upsertTaskFromEvent]
  );

  // Auto-scroll console.
  useEffect(() => {
    consoleContainerRef.current?.scrollTo({
      top: consoleContainerRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [timeline, isStreaming]);

  // ── State colours ────────────────────────────────────────────────────────────

  const stateColors: Record<string, string> = {
    TASK_STATE_WORKING:
      "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-400/20 dark:text-amber-100 dark:border-amber-400/30",
    TASK_STATE_INPUT_REQUIRED:
      "bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-400/20 dark:text-purple-100 dark:border-purple-400/30",
    TASK_STATE_COMPLETED:
      "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-400/20 dark:text-emerald-100 dark:border-emerald-400/30",
    TASK_STATE_FAILED:
      "bg-red-100 text-red-700 border-red-200 dark:bg-red-400/20 dark:text-red-100 dark:border-red-400/30",
    TASK_STATE_SUBMITTED:
      "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-400/20 dark:text-blue-100 dark:border-blue-400/30",
    TASK_STATE_CANCELED:
      "bg-slate-100 text-slate-700 border-slate-200 dark:bg-zinc-700/40 dark:text-zinc-200 dark:border-zinc-600",
    TASK_STATE_REJECTED:
      "bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-400/20 dark:text-orange-100 dark:border-orange-400/30",
  };

  function stateColorClass(state: TaskState | undefined): string {
    return state ? (stateColors[state] ?? stateColors["TASK_STATE_SUBMITTED"]) : "";
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-1 h-full min-h-0 w-full flex-col overflow-hidden bg-slate-50 dark:bg-zinc-900 rounded-2xl border border-slate-200 dark:border-zinc-800">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white px-6 py-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">
                {detail.name}
              </h1>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600 dark:bg-zinc-800 dark:text-zinc-200">
                v{detail.version}
              </span>
              <button
                onClick={() => setShowAgentInfo(true)}
                className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 transition-colors dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
                type="button"
              >
                Info
              </button>
            </div>
            <p className="mt-1 text-sm text-slate-600 dark:text-zinc-300">{detail.description}</p>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Main chat area */}
        <div className="flex flex-1 flex-col min-h-0">
          {/* Console */}
          <div
            ref={consoleContainerRef}
            className="flex-1 overflow-y-auto bg-white px-6 py-6 dark:bg-zinc-950"
          >
            {timeline.length === 0 ? (
              <div className="flex h-full items-center justify-center text-center">
                <div>
                  <p className="text-sm text-slate-500 dark:text-zinc-400">No messages yet</p>
                  <p className="text-xs text-slate-400 mt-1 dark:text-zinc-500">
                    {contextId ? "Start a conversation" : "Select or create a context to begin"}
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-6 max-w-4xl mx-auto">
                {timeline.map((entry) => {
                  const isUser = entry.type === "user";
                  const isNegotiation = entry.type === "negotiation";
                  const isTask = entry.type === "task";

                  return (
                    <div
                      key={entry.id}
                      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                    >
                      <div className={`max-w-[80%] ${isUser ? "" : "w-full"}`}>
                        {!isUser && (
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs font-semibold text-slate-700 dark:text-zinc-200">
                              {entry.title}
                            </span>
                            {entry.badge && (
                              <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-semibold dark:bg-zinc-800 dark:text-zinc-300">
                                {entry.badge}
                              </span>
                            )}
                            <span className="text-[11px] text-slate-400 dark:text-zinc-500">
                              {new Date(entry.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                        )}

                        {isUser ? (
                          <div className="rounded-2xl bg-blue-600 px-4 py-3 text-white dark:bg-blue-500">
                            <p className="text-sm whitespace-pre-wrap">{entry.body}</p>
                          </div>
                        ) : isTask ? (
                          <div className="rounded-2xl border-2 border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-500/40 dark:bg-blue-500/10">
                            <p className="text-sm font-semibold text-blue-900 mb-1 dark:text-blue-200">
                              {entry.title}
                            </p>
                            {entry.body && (
                              <p className="text-sm text-blue-800 whitespace-pre-wrap dark:text-blue-100">
                                {entry.body}
                              </p>
                            )}
                            {entry.subtext && (
                              <p className="text-xs text-blue-600 mt-2 dark:text-blue-200">
                                {entry.subtext}
                              </p>
                            )}
                            {entry.artifact && (
                              <div className="mt-3">
                                <ArtifactPreview artifact={entry.artifact} />
                              </div>
                            )}
                          </div>
                        ) : isNegotiation ? (
                          <div className="rounded-2xl border border-cyan-200 bg-cyan-50 px-4 py-3 dark:border-cyan-500/40 dark:bg-cyan-500/10">
                            {entry.body && (
                              <p className="text-sm text-cyan-900 whitespace-pre-wrap dark:text-cyan-100">
                                {entry.body}
                              </p>
                            )}
                          </div>
                        ) : (
                          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 dark:border-zinc-700 dark:bg-zinc-800">
                            {entry.body && (
                              <p className="text-sm text-slate-700 whitespace-pre-wrap dark:text-zinc-200">
                                {entry.body}
                              </p>
                            )}
                            {entry.subtext && (
                              <p className="text-xs text-slate-500 mt-2 dark:text-zinc-400">
                                {entry.subtext}
                              </p>
                            )}
                            {entry.artifact && (
                              <div className="mt-3">
                                <ArtifactPreview artifact={entry.artifact} />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {isStreaming && (
                  <div className="flex justify-start">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 dark:border-zinc-700 dark:bg-zinc-800">
                      <div className="flex gap-1">
                        {[0, 0.2, 0.4].map((delay) => (
                          <div
                            key={delay}
                            className="h-2 w-2 rounded-full bg-slate-400 animate-bounce dark:bg-zinc-700"
                            style={{ animationDelay: `${delay}s` }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Input bar */}
          <div className="border-t border-slate-200 bg-white px-6 py-4 flex-shrink-0 dark:border-zinc-800 dark:bg-zinc-900">
            {error && (
              <div className="mb-3 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600 dark:bg-red-500/20 dark:text-red-200">
                {error}
              </div>
            )}

            {/* Active interaction banner */}
            <div className="mb-3">
              {activeInteraction.type === "task" && activeInteraction.task && (
                <>
                  {activeInteraction.canReceiveInput ? (
                    <div className="flex items-center justify-between rounded-lg border border-purple-200 bg-purple-50 px-4 py-2 dark:border-purple-500/40 dark:bg-purple-500/10">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-2 rounded-full bg-purple-500 dark:bg-purple-300" />
                        <span className="text-xs font-semibold text-purple-900 dark:text-purple-100">
                          Replying to Task {shortenId(activeInteraction.taskId)}
                        </span>
                        <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-semibold dark:bg-purple-400/20 dark:text-purple-100">
                          {stateLabel(activeInteraction.task.task.status?.state ?? "TASK_STATE_UNSPECIFIED")}
                        </span>
                      </div>
                      <button
                        onClick={handleStartNewInContext}
                        className="text-xs text-purple-700 hover:text-purple-900 font-medium dark:text-purple-200 dark:hover:text-purple-100"
                      >
                        Start new conversation
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-4 py-2 dark:border-red-400/30 dark:bg-red-500/10">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-2 rounded-full bg-red-500 dark:bg-red-300" />
                        <span className="text-xs font-semibold text-red-900 dark:text-red-100">
                          Task {shortenId(activeInteraction.taskId)} is not waiting for input
                        </span>
                        <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold dark:bg-red-400/20 dark:text-red-100">
                          {stateLabel(activeInteraction.task.task.status?.state ?? "TASK_STATE_UNSPECIFIED")}
                        </span>
                      </div>
                      <button
                        onClick={handleStartNewInContext}
                        className="text-xs text-red-700 hover:text-red-900 font-medium dark:text-red-200 dark:hover:text-red-100"
                      >
                        Start new conversation
                      </button>
                    </div>
                  )}
                </>
              )}

              {activeInteraction.type === "negotiation" && (
                <div className="flex items-center gap-2 rounded-lg border border-cyan-200 bg-cyan-50 px-4 py-2 dark:border-zinc-700 dark:bg-zinc-800">
                  <div className="h-2 w-2 rounded-full bg-cyan-500 animate-pulse dark:bg-zinc-200" />
                  <span className="text-xs font-semibold text-cyan-900 dark:text-zinc-100">
                    Agent is negotiating (no task created yet)
                  </span>
                </div>
              )}

              {activeInteraction.type === "context" && (
                <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 dark:border-zinc-700 dark:bg-zinc-800">
                  <span className="text-xs text-slate-600 dark:text-zinc-300">
                    Sending message in context {shortenId(contextId!)}
                  </span>
                </div>
              )}

              {activeInteraction.type === "new" && (
                <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 dark:border-zinc-700 dark:bg-zinc-800">
                  <span className="text-xs text-blue-700 font-medium dark:text-zinc-100">
                    Starting new conversation
                  </span>
                </div>
              )}
            </div>

            <form onSubmit={handleSendMessage} className="flex gap-3">
              <textarea
                rows={3}
                className="flex-1 rounded-xl border border-slate-300 px-4 py-3 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 resize-none disabled:bg-slate-100 disabled:cursor-not-allowed dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500"
                placeholder={
                  activeInteraction.type === "task" && !activeInteraction.canReceiveInput
                    ? "This task is not waiting for input"
                    : contextId
                    ? "Send a message..."
                    : "Start a new conversation..."
                }
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                disabled={
                  isStreaming ||
                  (activeInteraction.type === "task" && !activeInteraction.canReceiveInput)
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendMessage(e);
                  }
                }}
              />
              <button
                type="submit"
                className="self-end rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 transition-colors dark:bg-blue-500 dark:hover:bg-blue-400"
                disabled={
                  isStreaming ||
                  !inputValue.trim() ||
                  (activeInteraction.type === "task" && !activeInteraction.canReceiveInput)
                }
              >
                {isStreaming ? "Sending..." : "Send"}
              </button>
            </form>
            <p className="mt-2 text-xs text-slate-500 dark:text-zinc-400">
              Press Enter to send, Shift+Enter for new line
            </p>
          </div>
        </div>

        {/* Sidebar */}
        <aside className="w-80 h-full border-l border-slate-200 bg-white flex flex-col overflow-hidden dark:border-zinc-800 dark:bg-zinc-900">
          <div className="border-b border-slate-200 px-4 py-4 dark:border-zinc-800">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-600 mb-3 dark:text-zinc-300">
              Context
            </p>
            <div className="space-y-2">
              <button
                onClick={handleNewContext}
                className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors dark:bg-blue-500 dark:hover:bg-blue-400"
              >
                + New Context
              </button>
              {availableContexts.length > 0 && (
                <select
                  value={contextId ?? ""}
                  onChange={(e) => handleSelectContext(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                >
                  <option value="">Select existing context...</option>
                  {availableContexts.map((ctx) => (
                    <option key={ctx} value={ctx}>
                      {shortenId(ctx)}
                    </option>
                  ))}
                </select>
              )}
              {contextId && (
                <p className="text-xs text-slate-500 dark:text-zinc-400">
                  Active: {shortenId(contextId)}
                </p>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-600 mb-3 dark:text-zinc-300">
              Tasks ({tasks.length})
            </p>
            {tasks.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-zinc-400">
                {contextId ? "No tasks yet" : "Select or create a context"}
              </p>
            ) : (
              <div className="space-y-2">
                {tasks.map(({ task }) => {
                  const state = task.status?.state;
                  const colorClass = stateColorClass(state);
                  const needsInput = !!state && isInputRequired(state);

                  return (
                    <div
                      key={task.id}
                      className="rounded-lg border border-slate-200 bg-slate-50 p-3 hover:bg-slate-100 transition-colors dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                    >
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-mono text-slate-600 truncate dark:text-zinc-300">
                            {shortenId(task.id)}
                          </p>
                          {state && (
                            <span
                              className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${colorClass}`}
                            >
                              {stateLabel(state)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() =>
                            void (needsInput
                              ? handleResumeTask(task.id)
                              : handleSubscribeTask(task.id))
                          }
                          className="flex-1 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700 transition-colors dark:bg-purple-500 dark:hover:bg-purple-400"
                        >
                          {needsInput ? "Resume" : "View"}
                        </button>
                        <button
                          onClick={() => void handleInspectTask(task.id)}
                          disabled={inspecting}
                          className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-200 disabled:opacity-50 transition-colors dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-700"
                        >
                          Inspect
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Task inspection modal */}
      {inspectedTask && (
        <div className="fixed inset-0 bg-black/50 dark:bg-black/70 flex items-center justify-center p-6 z-50">
          <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col border border-slate-200 dark:border-zinc-800">
            <div className="border-b border-slate-200 px-6 py-4 flex items-center justify-between dark:border-zinc-800">
              <div>
                <h3 className="text-lg font-semibold text-slate-900 dark:text-zinc-100">
                  Task {shortenId(inspectedTask.taskId)}
                </h3>
                <p className="text-xs text-slate-500 dark:text-zinc-400">Detailed history</p>
              </div>
              <button
                onClick={() => setInspectedTask(null)}
                className="text-slate-400 hover:text-slate-600 text-2xl leading-none dark:text-zinc-500 dark:hover:text-zinc-300"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {inspectedTask.task && (
                <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-800 dark:text-zinc-100">Context</span>
                    <span className="font-mono text-xs dark:text-zinc-300">
                      {shortenId(inspectedTask.task.contextId)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-800 dark:text-zinc-100">Status</span>
                    <span className="text-xs rounded-full bg-slate-200 px-2 py-0.5 uppercase tracking-wide text-slate-700 dark:bg-zinc-700 dark:text-zinc-200">
                      {inspectedTask.task.status?.state
                        ? stateLabel(inspectedTask.task.status.state)
                        : "unknown"}
                    </span>
                  </div>
                  {(inspectedTask.task.artifacts?.length ?? 0) > 0 && (
                    <div>
                      <span className="font-semibold text-slate-800 block mb-2 dark:text-zinc-100">
                        Artifacts ({inspectedTask.task.artifacts.length})
                      </span>
                      <div className="space-y-2">
                        {inspectedTask.task.artifacts.map((artifact) => (
                          <ArtifactPreview key={artifact.artifactId} artifact={artifact} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-600 mb-3 dark:text-zinc-400">
                  Event History
                </p>
                <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4 max-h-96 overflow-y-auto dark:border-zinc-700 dark:bg-zinc-800">
                  {inspectedTask.entries.map((entry) => (
                    <div key={entry.id} className="text-sm text-slate-700 dark:text-zinc-200">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-semibold text-slate-700 dark:text-zinc-300">
                          {entry.title}
                        </span>
                        {entry.badge && (
                          <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-slate-200 text-slate-600 font-semibold dark:bg-zinc-600 dark:text-zinc-200">
                            {entry.badge}
                          </span>
                        )}
                        <span className="text-[11px] text-slate-400 dark:text-zinc-500">
                          {new Date(entry.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      {entry.body && (
                        <p
                          className={`text-sm ${
                            entry.type === "user"
                              ? "text-blue-700 dark:text-blue-200"
                              : "text-slate-600 dark:text-zinc-300"
                          } whitespace-pre-wrap`}
                        >
                          {entry.body}
                        </p>
                      )}
                      {entry.subtext && (
                        <p className="text-xs text-slate-500 mt-1 dark:text-zinc-400">
                          {entry.subtext}
                        </p>
                      )}
                      {entry.artifact && (
                        <div className="mt-2">
                          <ArtifactPreview artifact={entry.artifact} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Agent info modal */}
      {showAgentInfo && (
        <div className="fixed inset-0 bg-black/40 dark:bg-black/70 flex items-center justify-center p-6 z-40">
          <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden border border-slate-200 dark:border-zinc-800">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-zinc-800">
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-zinc-100">
                  Agent Information
                </h2>
                <p className="text-xs text-slate-500 dark:text-zinc-400">
                  Details from the published AgentCard
                </p>
              </div>
              <button
                onClick={() => setShowAgentInfo(false)}
                className="text-slate-400 hover:text-slate-600 text-2xl leading-none dark:text-zinc-500 dark:hover:text-zinc-300"
              >
                ×
              </button>
            </div>
            <div className="max-h-[70vh] overflow-y-auto px-6 py-4 space-y-6">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1 dark:text-zinc-400">
                  Agent Card URL
                </p>
                <a
                  href={detail.cardUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:text-blue-800 break-all dark:text-blue-300 dark:hover:text-blue-200"
                >
                  {typeof window !== "undefined"
                    ? `${window.location.origin}${detail.cardUrl}`
                    : detail.cardUrl}
                </a>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-600 mb-3 dark:text-zinc-400">
                  Skills ({detail.skills.length})
                </p>
                {detail.skills.length === 0 ? (
                  <p className="text-sm text-slate-500 dark:text-zinc-400">No published skills.</p>
                ) : (
                  <div className="space-y-3">
                    {detail.skills.map((skill) => (
                      <div
                        key={skill.id}
                        className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-zinc-700 dark:bg-zinc-800"
                      >
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div>
                            <p className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
                              {skill.name}
                            </p>
                            <p className="text-xs text-slate-500 font-mono dark:text-zinc-400">
                              {skill.id}
                            </p>
                          </div>
                        </div>
                        {skill.description && (
                          <p className="text-sm text-slate-700 mb-2 whitespace-pre-wrap dark:text-zinc-300">
                            {skill.description}
                          </p>
                        )}
                        {(skill.examples?.length ?? 0) > 0 && (
                          <div className="rounded-lg bg-white border border-slate-200 px-3 py-2 dark:bg-zinc-900 dark:border-zinc-700">
                            <p className="text-xs font-semibold text-slate-600 mb-1 dark:text-zinc-400">
                              Examples
                            </p>
                            <ul className="list-disc pl-5 space-y-1 text-sm text-slate-700 dark:text-zinc-300">
                              {skill.examples!.map((ex, i) => (
                                <li key={i}>{ex}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-200 pt-3 dark:border-zinc-800">
                <button
                  onClick={() => setShowAgentInfo(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 transition-colors dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  Close
                </button>
                <a
                  href={detail.cardUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors dark:bg-blue-500 dark:hover:bg-blue-400"
                >
                  Open Agent Card
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Event → ConsoleEntry conversion ───────────────────────────────────────────

function convertEventToEntry(event: StreamEvent | null): ConsoleEntry | null {
  if (!event) return null;
  const timestamp = new Date().toISOString();

  if (event.type === "message") {
    const msg = event.data;
    if (msg.role !== "ROLE_AGENT") return null;
    const isNegotiation = !msg.taskId;
    const body = partsToText(msg.parts) || undefined;
    return {
      id: msg.messageId || `msg-${Date.now()}`,
      type: isNegotiation ? "negotiation" : "agent",
      title: isNegotiation ? "Agent (Negotiation)" : "Agent",
      body,
      contextId: msg.contextId,
      taskId: msg.taskId,
      timestamp,
      badge: isNegotiation ? "Negotiation" : undefined,
    };
  }

  if (event.type === "statusUpdate") {
    const update = event.data;
    const state = update.status?.state;
    const defaultMessages: Partial<Record<TaskState, string>> = {
      TASK_STATE_INPUT_REQUIRED: "Awaiting additional input",
      TASK_STATE_WORKING: "Task is in progress",
      TASK_STATE_COMPLETED: "Task completed",
      TASK_STATE_FAILED: "Task failed",
      TASK_STATE_REJECTED: "Task was rejected",
      TASK_STATE_CANCELED: "Task was canceled",
    };
    const statusText = update.status?.message
      ? messageText(update.status.message)
      : state
      ? defaultMessages[state as TaskState]
      : undefined;
    const ts = update.status?.timestamp ?? timestamp;
    return {
      id: `status-${update.taskId}-${ts}`,
      type: "status",
      title: `Status: ${state ? stateLabel(state) : "unknown"}`,
      body: statusText,
      taskId: update.taskId,
      contextId: update.contextId,
      timestamp: ts,
      badge: state ? stateLabel(state) : undefined,
    };
  }

  if (event.type === "artifactUpdate") {
    const update = event.data;
    const artifact = update.artifact;
    const artifactId =
      artifact?.artifactId ?? `${update.taskId}-${artifact?.name ?? "artifact"}-${Date.now()}`;
    return {
      id: `artifact-${artifactId}-${update.append ? "append" : "replace"}`,
      type: "artifact",
      title: "Artifact Update",
      body: artifact?.name ?? "Unnamed artifact",
      subtext: artifact?.description
        ? artifact.description
        : update.append
        ? "Appended chunk"
        : undefined,
      artifact: artifact ?? undefined,
      taskId: update.taskId,
      contextId: update.contextId,
      timestamp,
    };
  }

  if (event.type === "task") {
    const task = event.data;
    const state = task.status?.state;
    const isCreation =
      state === "TASK_STATE_SUBMITTED" || state === "TASK_STATE_WORKING";
    if (!isCreation) return null;

    const body = task.status?.message ? messageText(task.status.message) : undefined;
    const entry: ConsoleEntry = {
      id: task.id,
      type: "task",
      title: "Task Created",
      body,
      taskId: task.id,
      contextId: task.contextId,
      timestamp: task.status?.timestamp ?? timestamp,
      badge: "Task Created",
    };
    if (task.artifacts?.length) {
      entry.artifact = task.artifacts[0];
      if (task.artifacts.length > 1) {
        entry.subtext = `${task.artifacts.length} artifacts generated`;
      }
    }
    return entry;
  }

  return null;
}
