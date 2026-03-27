import { v4 as uuidv4 } from "uuid";
import type {
  AgentCard,
  AgentSkill,
  Artifact,
  Message,
  Part,
  StreamEvent,
  StreamResponse,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatusUpdateEvent,
} from "../types/a2a_v1";
import { parseStreamResponse } from "../types/a2a_v1";

export type { StreamEvent, Task, Message, Artifact, Part, TaskState };
export type { TaskStatusUpdateEvent, TaskArtifactUpdateEvent };

const API_BASE = "";

// ── Agent card ────────────────────────────────────────────────────────────────

let cachedCard: Promise<AgentCard> | null = null;

export async function getAgentCard(): Promise<AgentCard> {
  if (!cachedCard) {
    cachedCard = fetch(`${API_BASE}/.well-known/agent-card.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch agent card: HTTP ${r.status}`);
        return r.json() as Promise<AgentCard>;
      })
      .catch((e) => {
        cachedCard = null;
        throw e;
      });
  }
  return cachedCard;
}

export async function getAgentDetail() {
  const card = await getAgentCard();
  return {
    name: card.name,
    description: card.description ?? "",
    version: card.version,
    skills: (card.skills ?? []) as AgentSkill[],
    cardUrl: "/.well-known/agent-card.json",
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Derive the RPC endpoint from the agent card's supported interfaces. */
async function getRpcEndpoint(): Promise<string> {
  const card = await getAgentCard();
  // Prefer HTTP+JSON, fall back to JSONRPC
  const httpJson = card.supportedInterfaces?.find(
    (i) => i.protocolBinding === "HTTP+JSON"
  );
  if (httpJson) return httpJson.url;
  const rpc = card.supportedInterfaces?.find(
    (i) => i.protocolBinding === "JSONRPC"
  );
  if (rpc) return rpc.url;
  // Last resort — assume /rpc on the same origin
  return `${API_BASE}/rpc`;
}

/** Parse one SSE line from the server. Returns the data payload string or null. */
function parseSseLine(line: string): string | null {
  if (line.startsWith("data:")) return line.slice(5).trimStart();
  return null;
}

/**
 * Read an SSE stream and yield each `StreamEvent`.
 * Handles both the JSON-RPC envelope (`{ jsonrpc, result, id }`) that the
 * `/rpc` endpoint emits and the bare `StreamResponse` that the
 * HTTP+JSON `/message:stream` endpoint emits.
 */
async function* readSseStream(
  response: Response
): AsyncGenerator<StreamEvent, void, undefined> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const data = parseSseLine(line.trim());
        if (data == null || data === "") continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          console.warn("[SSE] Failed to parse event data:", data);
          continue;
        }

        // Unwrap JSON-RPC envelope if present.
        const payload: StreamResponse =
          parsed != null &&
          typeof parsed === "object" &&
          "result" in (parsed as object)
            ? (parsed as { result: StreamResponse }).result
            : (parsed as StreamResponse);

        const event = parseStreamResponse(payload);
        if (event) yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Send message (streaming) ──────────────────────────────────────────────────

export interface SendMessageOptions {
  messageText: string;
  contextId?: string;
  taskId?: string;
}

export async function* sendMessageStream(
  options: SendMessageOptions
): AsyncGenerator<StreamEvent, void, undefined> {
  const card = await getAgentCard();
  const isHttpJson =
    card.supportedInterfaces?.some((i) => i.protocolBinding === "HTTP+JSON") ?? false;

  const message: Message = {
    messageId: uuidv4(),
    role: "ROLE_USER",
    parts: [{ text: options.messageText }],
    contextId: options.contextId ?? "",
    taskId: options.taskId ?? "",
    referenceTaskIds: [],
    extensions: [],
  };

  if (isHttpJson) {
    // HTTP+JSON transport: POST /message:stream
    const endpoint = await getRpcEndpoint();
    const base = endpoint.replace(/\/message:stream$/, "").replace(/\/rpc$/, "");
    const url = `${base}/message:stream`;

    const body = {
      message,
        configuration: { acceptedOutputModes: [], historyLength: 0, returnImmediately: true },
      metadata: null,
      tenant: "",
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    yield* readSseStream(response);
  } else {
    // JSON-RPC transport: POST /rpc  method=SendStreamingMessage
    const endpoint = await getRpcEndpoint();
    const requestId = uuidv4();

    const body = {
      jsonrpc: "2.0",
      id: requestId,
      method: "SendStreamingMessage",
      params: {
        message,
     configuration: { acceptedOutputModes: [], historyLength: 0, returnImmediately: true },
        metadata: null,
        tenant: "",
      },
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    yield* readSseStream(response);
  }
}

// ── Resubscribe task ──────────────────────────────────────────────────────────

export async function* resubscribeTaskStream(params: {
  id: string;
}): AsyncGenerator<StreamEvent, void, undefined> {
  const card = await getAgentCard();
  const isHttpJson =
    card.supportedInterfaces?.some((i) => i.protocolBinding === "HTTP+JSON") ?? false;

  if (isHttpJson) {
    const endpoint = await getRpcEndpoint();
    const base = endpoint.replace(/\/message:stream$/, "").replace(/\/rpc$/, "");
    const url = `${base}/tasks/${encodeURIComponent(params.id)}:subscribe`;

    const response = await fetch(url, {
      headers: { Accept: "text/event-stream" },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    yield* readSseStream(response);
  } else {
    const endpoint = await getRpcEndpoint();
    const requestId = uuidv4();

    const body = {
      jsonrpc: "2.0",
      id: requestId,
      method: "SubscribeToTask",
      params: { id: params.id, tenant: "" },
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    yield* readSseStream(response);
  }
}

// ── Dev-UI REST endpoints ─────────────────────────────────────────────────────

export interface TaskSummary {
  task: Task;
  skill_id?: string;
  pending_slot?: unknown;
}

export interface UiTaskEvent {
  result: StreamResponse;
  is_final: boolean;
}

export interface TaskHistoryResponse {
  events: UiTaskEvent[];
  task?: Task;
}

export async function listContexts(): Promise<string[]> {
  const r = await fetch(`${API_BASE}/ui/contexts`);
  if (!r.ok) throw new Error(`Failed to load contexts: HTTP ${r.status}`);
  return r.json();
}

export async function listContextTasks(contextId: string): Promise<TaskSummary[]> {
  const r = await fetch(`${API_BASE}/ui/contexts/${contextId}/tasks`);
  if (!r.ok) throw new Error(`Failed to load tasks for context ${contextId}: HTTP ${r.status}`);
  return r.json();
}

export async function getTaskHistory(taskId: string): Promise<TaskHistoryResponse> {
  const r = await fetch(`${API_BASE}/ui/tasks/${taskId}/events`);
  if (!r.ok) throw new Error(`Failed to load history for task ${taskId}: HTTP ${r.status}`);
  const payload = await r.json();
  return {
    events: (payload.events ?? []) as UiTaskEvent[],
    task: payload.task as Task | undefined,
  };
}

export async function getTaskTransitions(taskId: string): Promise<
  import("../types/TaskTransitionsResponse").TaskTransitionsResponse
> {
  const r = await fetch(`${API_BASE}/ui/tasks/${taskId}/transitions`);
  if (!r.ok) throw new Error(`Failed to load transitions for task ${taskId}: HTTP ${r.status}`);
  return r.json();
}
