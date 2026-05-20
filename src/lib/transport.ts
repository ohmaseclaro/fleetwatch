import type { Frame, Session } from "../../shared/types";
import { useStore } from "./store";

let socket: WebSocket | null = null;
let backoff = 500;
let manualClose = false;

export function connect(token: string): void {
  manualClose = false;
  if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
    return;
  }
  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${wsProto}://${location.host}/ws?token=${encodeURIComponent(token)}`;
  useStore.getState().setConnection({ status: "connecting" });

  try {
    socket = new WebSocket(url);
  } catch (err) {
    useStore.getState().setConnection({ status: "error", lastError: (err as Error).message });
    scheduleReconnect(token);
    return;
  }

  socket.onopen = () => {
    backoff = 500;
  };
  socket.onmessage = (ev: MessageEvent<string>) => {
    let frame: Frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleFrame(frame);
  };
  socket.onclose = (ev: CloseEvent) => {
    if (ev.code === 4001) {
      useStore.getState().setConnection({ status: "unauthorized", lastError: "Token rejected." });
      useStore.getState().setToken(null);
      return;
    }
    if (manualClose) {
      useStore.getState().setConnection({ status: "disconnected" });
      return;
    }
    scheduleReconnect(token);
  };
  socket.onerror = () => {
    // onclose will follow.
  };
}

export function disconnect(): void {
  manualClose = true;
  try {
    socket?.close();
  } catch {}
  socket = null;
}

export function send(frame: Frame): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(frame));
}

function scheduleReconnect(token: string): void {
  useStore.getState().setConnection({ status: "connecting", lastError: "Reconnecting…" });
  const delay = Math.min(backoff, 30_000);
  backoff = Math.min(backoff * 2, 30_000);
  setTimeout(() => connect(token), delay);
}

function handleFrame(frame: Frame): void {
  const store = useStore.getState();
  if (frame.kind === "hello") {
    store.setConnection({
      status: "connected",
      hostname: frame.hostname,
      platform: frame.platform,
      agentVersion: frame.agentVersion,
    });
  } else if (frame.kind === "session_list") {
    store.setSessions(frame.sessions);
  } else if (frame.kind === "session_upsert") {
    store.upsertSession(frame.session as Session);
  } else if (frame.kind === "session_remove") {
    store.removeSession(frame.sessionId);
  } else if (frame.kind === "session_event") {
    store.appendEvent(frame.event);
  } else if (frame.kind === "session_events") {
    store.setEvents(frame.sessionId, frame.events);
  } else if (frame.kind === "error") {
    store.setConnection({ status: "error", lastError: frame.message });
    if (frame.message === "unauthorized") store.setToken(null);
  }
}
