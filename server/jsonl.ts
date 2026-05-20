import type { SessionEvent, EventType, ImageRef } from "../shared/types.js";

/**
 * Sink for image attachments. The parser hands raw bytes to this callback
 * and gets back a content-addressed ref (or null if the image was rejected
 * — too large, etc.). Provided by the watcher so images get cached in the
 * shared AttachmentStore.
 */
export interface ParseOptions {
  storeImage?: (buffer: Buffer, mediaType: string) => string | null;
}

/**
 * Liberal JSONL line parser.
 *
 * Real Claude Code lines come in many shapes. Rather than modeling each
 * variant exhaustively, we extract the fields we care about and tolerate
 * everything else. Unknown line shapes still yield a usable SessionEvent.
 */
// Lines we drop entirely — pure metadata, not user-facing events.
const META_TYPES = new Set(["last-prompt", "queue-operation", "todo-update", "ai-title", "custom-title"]);

/**
 * Extract session title metadata from a raw JSONL line if present.
 * Returns null when the line isn't a title line.
 */
export function parseTitleLine(line: string): { aiTitle?: string; customTitle?: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: any;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  if (raw.type === "ai-title" && typeof raw.aiTitle === "string") {
    return { aiTitle: raw.aiTitle };
  }
  if (raw.type === "custom-title" && typeof raw.customTitle === "string") {
    return { customTitle: raw.customTitle };
  }
  return null;
}

export function parseLine(line: string, sessionId: string, opts: ParseOptions = {}): SessionEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: any;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;

  if (typeof raw.type === "string" && META_TYPES.has(raw.type)) return null;

  const parsedTs = parseTimestamp(raw.timestamp);
  // Drop lines with no timestamp — they pollute lastEventAt. Real conversation
  // events always carry one.
  if (parsedTs === null) return null;
  const ts = parsedTs;
  const type = normalizeType(raw.type);
  const ev: SessionEvent = {
    sessionId,
    ts,
    type,
    uuid: typeof raw.uuid === "string" ? raw.uuid : undefined,
  };

  // user messages can carry plain string content or assistant-style content arrays
  if (type === "user") {
    ev.text = extractMessageText(raw.message) ?? extractMessageText(raw);
    const images = extractImages(raw.message, opts.storeImage);
    if (images.length > 0) ev.images = images;
    // a user line may also bundle tool_result blocks inside message.content
    const toolResults = extractToolResults(raw.message);
    if (toolResults.length > 0) {
      // promote to a tool_result event (use the first; others rare)
      const first = toolResults[0];
      ev.type = "tool_result";
      ev.toolUseRef = first.tool_use_id;
      ev.toolResultText = first.text;
      ev.toolResultIsError = first.is_error;
      // keep the user text only if there's something beyond the tool_result
      if (!ev.text || ev.text.length < 4) ev.text = undefined;
    }
  } else if (type === "assistant") {
    const { text, toolUses, thinking, usage, model } = extractAssistantBlocks(raw.message);
    ev.text = text;
    ev.thinking = thinking;
    ev.model = model ?? (typeof raw.message?.model === "string" ? raw.message.model : undefined);
    if (usage) {
      ev.inputTokens = usage.input_tokens;
      ev.outputTokens = usage.output_tokens;
      ev.cacheReadTokens = usage.cache_read_input_tokens;
    }
    if (toolUses.length > 0) {
      // emit the first tool_use here; additional tool_uses in the same line
      // are returned by parseLineMulti below
      const first = toolUses[0];
      ev.toolName = first.name;
      ev.toolInput = first.input;
      ev.toolUseId = first.id;
      // we keep the assistant text alongside if present
    }
  } else if (type === "tool_use") {
    ev.toolName = raw.name;
    ev.toolInput = raw.input;
    ev.toolUseId = raw.id;
  } else if (type === "tool_result") {
    ev.toolUseRef = raw.tool_use_id;
    ev.toolResultText = stringifyMaybe(raw.content);
    ev.toolResultIsError = raw.is_error === true;
  } else if (type === "attachment") {
    ev.attachmentKind = raw.attachment?.type;
    if (typeof raw.attachment?.content === "string") {
      ev.text = raw.attachment.content;
    }
  } else if (type === "summary") {
    ev.text = typeof raw.summary === "string" ? raw.summary : stringifyMaybe(raw);
  } else if (type === "system") {
    ev.text = typeof raw.content === "string" ? raw.content : stringifyMaybe(raw);
  } else if (type === "thinking") {
    ev.thinking = typeof raw.thinking === "string" ? raw.thinking : stringifyMaybe(raw);
  }

  return ev;
}

/**
 * Split a single assistant JSONL line into multiple semantic events when
 * the message bundles text + multiple tool_uses. Callers can render each
 * piece in chronological order in the UI.
 */
export function parseLineMulti(line: string, sessionId: string, opts: ParseOptions = {}): SessionEvent[] {
  const primary = parseLine(line, sessionId, opts);
  if (!primary) return [];

  let raw: any;
  try {
    raw = JSON.parse(line.trim());
  } catch {
    return [primary];
  }

  if (primary.type === "assistant") {
    const { toolUses } = extractAssistantBlocks(raw.message);
    if (toolUses.length <= 1) return [primary];
    const events: SessionEvent[] = [];
    // The primary already includes the first tool_use; emit the rest separately
    events.push(primary);
    for (let i = 1; i < toolUses.length; i++) {
      const tu = toolUses[i];
      events.push({
        sessionId,
        ts: primary.ts + i,
        type: "tool_use",
        toolName: tu.name,
        toolInput: tu.input,
        toolUseId: tu.id,
        uuid: `${primary.uuid ?? ""}-${i}`,
      });
    }
    return events;
  }
  return [primary];
}

function normalizeType(t: unknown): EventType {
  if (typeof t !== "string") return "system";
  if (
    t === "user" ||
    t === "assistant" ||
    t === "tool_use" ||
    t === "tool_result" ||
    t === "system" ||
    t === "summary" ||
    t === "attachment" ||
    t === "thinking"
  ) {
    return t;
  }
  // queue-operation, etc. -> treat as system
  return "system";
}

function parseTimestamp(t: unknown): number | null {
  if (typeof t === "number") return t > 1e12 ? t : t * 1000;
  if (typeof t === "string") {
    const parsed = Date.parse(t);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractMessageText(msg: any): string | undefined {
  if (!msg) return undefined;
  if (typeof msg === "string") return msg;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    const parts: string[] = [];
    for (const block of msg.content) {
      if (!block) continue;
      if (typeof block === "string") parts.push(block);
      else if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
    return parts.length ? parts.join("\n") : undefined;
  }
  return undefined;
}

/**
 * Pull image attachments out of a message's content tree. Images can appear
 * in two places in Claude Code's JSONL:
 *
 *   (1) Direct user paste — top-level user.message.content[]:
 *       { type: "image", source: { type: "base64", media_type, data } }
 *
 *   (2) Tool result with image — nested inside a tool_result block:
 *       { type: "tool_result", content: [ { type: "image", source: {...} } ] }
 *
 * We walk the tree (one level deep is enough — Anthropic doesn't nest deeper)
 * and surface every image we find. The storeImage callback caches the bytes
 * in AttachmentStore and returns a content hash so events stay lightweight.
 */
function extractImages(
  msg: any,
  storeImage: ParseOptions["storeImage"],
): ImageRef[] {
  if (!storeImage || !msg) return [];
  const out: ImageRef[] = [];
  const visit = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block as any;
      if (b.type === "image") {
        const src = b.source;
        if (!src || src.type !== "base64" || typeof src.data !== "string" || !src.media_type) continue;
        let buf: Buffer;
        try {
          buf = Buffer.from(src.data, "base64");
        } catch {
          continue;
        }
        const hash = storeImage(buf, src.media_type);
        if (!hash) continue;
        out.push({ hash, mediaType: src.media_type, sizeBytes: buf.byteLength });
      } else if (b.type === "tool_result" && Array.isArray(b.content)) {
        // Recurse into tool_result content — that's where screenshot-tool images live.
        visit(b.content);
      }
    }
  };
  visit(msg.content);
  return out;
}

function extractToolResults(msg: any): Array<{ tool_use_id: string; text: string; is_error: boolean }> {
  if (!msg || !Array.isArray(msg.content)) return [];
  const results: Array<{ tool_use_id: string; text: string; is_error: boolean }> = [];
  for (const block of msg.content) {
    if (block?.type === "tool_result") {
      results.push({
        tool_use_id: String(block.tool_use_id ?? ""),
        text: stringifyMaybe(block.content) ?? "",
        is_error: block.is_error === true,
      });
    }
  }
  return results;
}

function extractAssistantBlocks(msg: any): {
  text?: string;
  thinking?: string;
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  usage?: any;
  model?: string;
} {
  const out = {
    text: undefined as string | undefined,
    thinking: undefined as string | undefined,
    toolUses: [] as Array<{ id: string; name: string; input: unknown }>,
    usage: undefined as any,
    model: undefined as string | undefined,
  };
  if (!msg) return out;
  out.model = typeof msg.model === "string" ? msg.model : undefined;
  out.usage = msg.usage;
  if (typeof msg.content === "string") {
    out.text = msg.content;
    return out;
  }
  if (!Array.isArray(msg.content)) return out;
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  for (const block of msg.content) {
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
    else if (block.type === "thinking" && typeof block.thinking === "string") thinkingParts.push(block.thinking);
    else if (block.type === "tool_use") {
      out.toolUses.push({
        id: String(block.id ?? ""),
        name: String(block.name ?? "unknown"),
        input: block.input,
      });
    }
  }
  if (textParts.length) out.text = textParts.join("\n");
  if (thinkingParts.length) out.thinking = thinkingParts.join("\n");
  return out;
}

function stringifyMaybe(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const item of v) {
      if (typeof item === "string") parts.push(item);
      else if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
      else parts.push(JSON.stringify(item));
    }
    return parts.join("\n");
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
