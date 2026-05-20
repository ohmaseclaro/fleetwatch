// Wire types shared between server (daemon) and web client.
// Mirror of spec §3, simplified where local-network deployment makes
// frame complexity unnecessary.

export type SessionStatus =
  | "running"
  | "running-tool"
  | "awaiting-user"
  | "idle"
  | "errored"
  | "compacted";

export type SessionSource = "claude-code" | "cowork" | "cursor";

/** Top-level provider grouping (Claude tab vs. Cursor tab in the UI). */
export type SessionProvider = "claude" | "cursor";

export function providerForSource(source: SessionSource): SessionProvider {
  return source === "cursor" ? "cursor" : "claude";
}

export interface Session {
  id: string;
  projectPath: string;
  projectLabel: string;
  /** AI-generated title, e.g. "Fix grid expansion pricing and add placement modal" */
  aiTitle?: string;
  /** User-set title, takes precedence over aiTitle */
  customTitle?: string;
  status: SessionStatus;
  lastUserMessageAt: number;
  lastEventAt: number;
  lastUserMessagePreview: string;
  currentActivity?: string;
  isSubagent: boolean;
  parentSessionId?: string;
  source: SessionSource;
  gitBranch?: string;
  eventCount: number;
}

export type EventType =
  | "user"
  | "assistant"
  | "tool_use"
  | "tool_result"
  | "system"
  | "summary"
  | "attachment"
  | "thinking";

export interface ImageRef {
  /** Content-addressed hash. Fetch via GET /api/attachment/:hash?token=… */
  hash: string;
  /** MIME type, e.g. "image/png", "image/jpeg". */
  mediaType: string;
  /** Decoded byte size (for progress / size warnings). */
  sizeBytes: number;
}

export interface SessionEvent {
  sessionId: string;
  ts: number;
  type: EventType;
  text?: string;
  thinking?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  toolUseRef?: string;
  toolResultText?: string;
  toolResultIsError?: boolean;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  attachmentKind?: string;
  /**
   * Inline images attached to a user/assistant message. Refs only — the
   * actual bytes live server-side in AttachmentStore and are served via the
   * /api/attachment/:hash endpoint (authed).
   */
  images?: ImageRef[];
  uuid?: string;
}

export type Frame =
  | { kind: "hello"; agentVersion: string; hostname: string; platform: string; ts: number }
  | { kind: "session_list"; sessions: Session[]; ts: number }
  | { kind: "session_upsert"; session: Session }
  | { kind: "session_remove"; sessionId: string }
  | { kind: "session_events"; sessionId: string; events: SessionEvent[]; replay: boolean }
  | { kind: "session_event"; event: SessionEvent }
  | { kind: "subscribe"; sessionIds: string[] }
  | { kind: "unsubscribe"; sessionIds: string[] }
  | { kind: "request_history"; sessionId: string; limit?: number }
  | { kind: "heartbeat"; ts: number }
  | { kind: "error"; message: string };
