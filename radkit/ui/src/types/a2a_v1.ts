/**
 * A2A Protocol v1 types — sourced from the proto-generated wire format that
 * our Rust backend (pbjson) emits. These match exactly what comes over the
 * wire as JSON.
 *
 * Key differences from the v0.3 SDK:
 *  - No `kind` discriminator on any type.
 *  - `TaskState` is a string enum: "TASK_STATE_WORKING", etc.
 *  - `Role` is a string enum: "ROLE_USER", "ROLE_AGENT".
 *  - `Part` uses flat keys `{ text }` / `{ raw }` / `{ url }` / `{ data }`.
 *  - `Message` uses `parts` (not `content`) and `messageId` (camelCase).
 *  - `TaskStatus.message` holds the associated message (not `update`).
 *  - `StreamResponse` is a flat object with one key: `task`, `message`,
 *    `statusUpdate`, or `artifactUpdate`.
 *  - `AgentCard` uses `supportedInterfaces` (not `url`).
 *
 * Adapted from:
 * https://github.com/a2aproject/a2a-js/blob/epic/1.0_breaking_changes/src/types/pb/a2a_types.ts
 */

// ── Enums ─────────────────────────────────────────────────────────────────────

export type TaskState =
  | "TASK_STATE_UNSPECIFIED"
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_AUTH_REQUIRED";

export type Role = "ROLE_UNSPECIFIED" | "ROLE_USER" | "ROLE_AGENT";

// ── Part ──────────────────────────────────────────────────────────────────────

/**
 * A single content part. Exactly one of the fields will be present.
 * `raw` is base64-encoded bytes.
 */
export interface Part {
  text?: string;
  raw?: string;       // base64-encoded bytes
  url?: string;
  data?: unknown;
  metadata?: unknown;
  filename?: string;
  mediaType?: string;
}

// ── Core types ────────────────────────────────────────────────────────────────

export interface Message {
  messageId: string;
  contextId: string;
  taskId: string;
  role: Role;
  parts: Part[];
  referenceTaskIds?: string[];
  extensions?: string[];
  metadata?: unknown;
}

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  extensions?: string[];
  metadata?: unknown;
}

export interface TaskStatus {
  state: TaskState;
  /** Message associated with this status (e.g. progress update from the skill). */
  message?: Message;
  timestamp?: string;
}

export interface Task {
  id: string;
  contextId: string;
  status?: TaskStatus;
  artifacts: Artifact[];
  history: Message[];
  metadata?: unknown;
}

// ── Streaming events ──────────────────────────────────────────────────────────

export interface TaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status?: TaskStatus;
  metadata?: unknown;
}

export interface TaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact?: Artifact;
  append: boolean;
  lastChunk: boolean;
  metadata?: unknown;
}

/**
 * StreamResponse — exactly one key is present.
 * This is what each SSE `data:` line contains (unwrapped from JSON-RPC if applicable).
 */
export interface StreamResponse {
  task?: Task;
  message?: Message;
  statusUpdate?: TaskStatusUpdateEvent;
  artifactUpdate?: TaskArtifactUpdateEvent;
}

/** Discriminated union for stream events. */
export type StreamEvent =
  | { type: "task"; data: Task }
  | { type: "message"; data: Message }
  | { type: "statusUpdate"; data: TaskStatusUpdateEvent }
  | { type: "artifactUpdate"; data: TaskArtifactUpdateEvent };

/** Parse a raw `StreamResponse` object into a discriminated `StreamEvent`. */
export function parseStreamResponse(raw: StreamResponse): StreamEvent | null {
  if (raw.task != null) return { type: "task", data: raw.task };
  if (raw.message != null) return { type: "message", data: raw.message };
  if (raw.statusUpdate != null) return { type: "statusUpdate", data: raw.statusUpdate };
  if (raw.artifactUpdate != null) return { type: "artifactUpdate", data: raw.artifactUpdate };
  return null;
}

// ── SendMessageResponse ───────────────────────────────────────────────────────

/** Non-streaming send response — either a Task or a Message. */
export interface SendMessageResponse {
  task?: Task;
  message?: Message;
}

// ── AgentCard ─────────────────────────────────────────────────────────────────

export interface AgentInterface {
  url: string;
  protocolBinding: string;
  tenant?: string;
  protocolVersion?: string;
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extendedAgentCard?: boolean;
}

export interface AgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCard {
  name: string;
  description?: string;
  version: string;
  protocolVersion?: string;
  supportedInterfaces: AgentInterface[];
  capabilities?: AgentCapabilities;
  skills: AgentSkill[];
}

// ── State helpers ─────────────────────────────────────────────────────────────

export function isTerminalState(state: TaskState): boolean {
  return (
    state === "TASK_STATE_COMPLETED" ||
    state === "TASK_STATE_FAILED" ||
    state === "TASK_STATE_CANCELED" ||
    state === "TASK_STATE_REJECTED"
  );
}

export function isInputRequired(state: TaskState): boolean {
  return state === "TASK_STATE_INPUT_REQUIRED";
}

/** Short display label for a TaskState, e.g. "TASK_STATE_WORKING" → "working" */
export function stateLabel(state: TaskState): string {
  return state.replace("TASK_STATE_", "").toLowerCase().replace("_", "-");
}

// ── Part helpers ──────────────────────────────────────────────────────────────

/** Extract all text from a list of parts, joined by newlines. */
export function partsToText(parts: Part[]): string {
  return parts
    .filter((p) => p.text != null)
    .map((p) => p.text!)
    .join("\n");
}

/** Get the first text value from a message's parts, or undefined. */
export function messageText(msg: Message): string | undefined {
  return msg.parts.find((p) => p.text != null)?.text;
}
