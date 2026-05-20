/**
 * Transforms a flat list of session events into display groups that match
 * the Claude Code sidebar style:
 *
 *   - User messages → their own row
 *   - Assistant prose → its own row
 *   - Consecutive tool calls (use + result pairs) → one collapsible group
 *   - System / attachment → subtle inline row
 */
import type { SessionEvent } from "../../shared/types";

export interface ToolPair {
  use: SessionEvent;
  result?: SessionEvent;
}

export type DisplayGroup =
  | { kind: "user"; event: SessionEvent }
  | { kind: "assistant"; event: SessionEvent }
  | { kind: "tools"; pairs: ToolPair[] }
  | { kind: "system"; event: SessionEvent };

export function groupEvents(events: SessionEvent[]): DisplayGroup[] {
  const groups: DisplayGroup[] = [];
  let toolBuf: ToolPair[] = [];

  const flush = () => {
    if (toolBuf.length) {
      groups.push({ kind: "tools", pairs: toolBuf });
      toolBuf = [];
    }
  };

  for (const ev of events) {
    if (ev.type === "user") {
      flush();
      groups.push({ kind: "user", event: ev });
    } else if (ev.type === "assistant") {
      // If the assistant event carries a tool call (first in a multi-tool batch),
      // accumulate it — the text portion (if any) is shown inside the group header.
      if (ev.toolName) {
        toolBuf.push({ use: ev });
      } else {
        // Pure text turn — flush tool buffer first, then show prose.
        flush();
        if (ev.text || ev.thinking) groups.push({ kind: "assistant", event: ev });
      }
    } else if (ev.type === "tool_use") {
      // Additional tool_use events synthesised from multi-tool assistant lines.
      toolBuf.push({ use: ev });
    } else if (ev.type === "tool_result") {
      // Match to the most-recently unmatched tool call.
      const ref = ev.toolUseRef;
      const target = ref
        ? toolBuf.slice().reverse().find((p) => p.use.toolUseId === ref)
        : toolBuf.slice().reverse().find((p) => !p.result);
      if (target) {
        target.result = ev;
      } else {
        // Orphan result with no matching use (e.g., compacted history) — wrap it.
        toolBuf.push({ use: orphanUse(ev), result: ev });
      }
    } else if (ev.type === "thinking") {
      // Attach to the next assistant event; skip as standalone.
    } else if (ev.type === "summary") {
      flush();
      groups.push({ kind: "system", event: ev });
    } else if (ev.type === "attachment") {
      // Skip internal hook attachments; show goal/error attachments.
      const kind = ev.attachmentKind;
      if (kind && kind !== "hook_success" && kind !== "goal_status" && kind !== "deferred_tools_delta") {
        flush();
        groups.push({ kind: "system", event: ev });
      }
    } else if (ev.type === "system") {
      if (ev.text && !ev.text.startsWith('{"operation"') && !ev.text.startsWith("{")) {
        flush();
        groups.push({ kind: "system", event: ev });
      }
    }
  }

  flush();
  return groups;
}

/** Produce a readable summary label for a tool group (the collapsed row text). */
export function toolGroupLabel(pairs: ToolPair[]): string {
  if (pairs.length === 0) return "Tool call";
  const tools = pairs.map((p) => p.use);
  const names = tools.map((t) => t.toolName ?? "tool");

  // All same tool family?
  const family = toolFamily(names[0]);
  const allSameFamily = names.every((n) => toolFamily(n) === family);

  if (pairs.length === 1) {
    return singleToolLabel(pairs[0]);
  }

  if (!allSameFamily) {
    return `Used ${pairs.length} tools`;
  }

  switch (family) {
    case "bash":
      return `Ran ${pairs.length} command${pairs.length > 1 ? "s" : ""}`;
    case "read":
      return `Read ${pairs.length} file${pairs.length > 1 ? "s" : ""}`;
    case "write":
      return `Wrote ${pairs.length} file${pairs.length > 1 ? "s" : ""}`;
    case "edit":
      return `Edited ${pairs.length} file${pairs.length > 1 ? "s" : ""}`;
    case "search":
      return `Searched ${pairs.length} time${pairs.length > 1 ? "s" : ""}`;
    default:
      return `Used ${pairs.length} tools`;
  }
}

export function singleToolLabel(pair: ToolPair): string {
  const { use } = pair;
  const name = use.toolName ?? "tool";
  const inp = (use.toolInput ?? {}) as Record<string, unknown>;

  switch (name) {
    case "Bash":
    case "Bash_SIDECHAIN": {
      const cmd = String(inp.command ?? "").trim();
      const firstLine = cmd.split("\n")[0].slice(0, 80);
      return `Ran ${firstLine}`;
    }
    case "Read":
      return `Read ${shortPath(String(inp.file_path ?? ""))}`;
    case "Write":
      return `Wrote ${shortPath(String(inp.file_path ?? ""))}`;
    case "Edit":
    case "NotebookEdit": {
      const fp = shortPath(String(inp.file_path ?? ""));
      const added = countLines(String(inp.new_string ?? ""));
      const removed = countLines(String(inp.old_string ?? ""));
      const stat = added || removed ? ` +${added} -${removed}` : "";
      return `Edited ${fp}${stat}`;
    }
    case "Grep":
      return `Grepped "${String(inp.pattern ?? "").slice(0, 40)}"${inp.path ? ` in ${shortPath(String(inp.path))}` : ""}`;
    case "Glob":
      return `Glob ${String(inp.pattern ?? "").slice(0, 40)}`;
    case "WebFetch":
      return `Fetched ${shortUrl(String(inp.url ?? ""))}`;
    case "WebSearch":
      return `Searched "${String(inp.query ?? "").slice(0, 50)}"`;
    case "Task":
    case "Agent":
      return `Started ${String(inp.description ?? inp.subagent_type ?? "task").slice(0, 60)}`;
    default:
      return name;
  }
}

function toolFamily(name: string): string {
  const n = name.toLowerCase();
  if (n === "bash" || n.startsWith("bash_")) return "bash";
  if (n === "read") return "read";
  if (n === "write") return "write";
  if (n === "edit" || n === "notebookedit") return "edit";
  if (n === "grep" || n === "glob") return "search";
  return "other";
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  if (parts.length > 2) return "…/" + parts.slice(-2).join("/");
  return p;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname.length > 1 ? u.pathname.slice(0, 30) : "");
  } catch {
    return url.slice(0, 40);
  }
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split("\n").length;
}

function orphanUse(result: SessionEvent): SessionEvent {
  return {
    sessionId: result.sessionId,
    ts: result.ts,
    type: "tool_use",
    toolName: "tool",
    toolUseId: result.toolUseRef,
  };
}
