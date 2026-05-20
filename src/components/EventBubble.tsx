import { useState } from "react";
import { Paperclip } from "lucide-react";
import type { SessionEvent, ImageRef } from "../../shared/types";
import { clockTime } from "../lib/time";
import { useStore } from "../lib/store";
import { ImageLightbox } from "./ImageLightbox";

interface Props {
  event: SessionEvent;
}

const COLLAPSE_THRESHOLD = 800;

export function EventBubble({ event }: Props) {
  if (event.type === "user") return <UserBubble event={event} />;
  if (event.type === "assistant") return <AssistantBubble event={event} />;
  if (event.type === "thinking") return <ThinkingBubble event={event} />;
  if (event.type === "summary") return <SystemRow event={event} label="Session compacted" />;
  if (event.type === "attachment") return <AttachmentRow event={event} />;
  return <SystemRow event={event} label={event.text ?? "system"} />;
}

function UserBubble({ event }: { event: SessionEvent }) {
  const text = event.text ?? "";
  const hasImages = (event.images?.length ?? 0) > 0;
  // Skip internal command markers, but only when there's no other content.
  if (
    !hasImages &&
    (text.startsWith("<command-name>") || text.startsWith("<local-command-stdout>"))
  ) return null;
  if (!text && !hasImages) return null;
  // Filter the marker prefix when images coexist with command stdout (rare).
  const cleanText = (text.startsWith("<command-name>") || text.startsWith("<local-command-stdout>"))
    ? ""
    : text;
  return (
    <div className="flex flex-col items-end my-3 slide-in">
      <Timestamp ts={event.ts} />
      <div
        className="max-w-[88%] rounded-lg px-3.5 py-2.5 mt-1"
        style={{
          background: "var(--accent-bg)",
          border: "1px solid var(--accent-soft)",
          color: "var(--text)",
        }}
      >
        <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--accent)" }}>
          You
        </div>
        {event.images && event.images.length > 0 && (
          <ImageStrip images={event.images} />
        )}
        {cleanText && (
          <div className="whitespace-pre-wrap break-words text-sm" style={{ lineHeight: 1.5 }}>
            {cleanText}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Inline thumbnails for user-attached images. Tap any to open a fullscreen
 * lightbox. Sized small enough to not crowd the bubble; user can always
 * expand for detail.
 */
function ImageStrip({ images }: { images: ImageRef[] }) {
  const token = useStore((s) => s.token);
  const [active, setActive] = useState<ImageRef | null>(null);
  if (!token) return null;
  return (
    <>
      <div className={`flex flex-wrap gap-1.5 ${images.length > 0 ? "mb-2" : ""}`}>
        {images.map((img) => {
          const src = `/api/attachment/${img.hash}?token=${encodeURIComponent(token)}`;
          return (
            <button
              key={img.hash}
              type="button"
              onClick={() => setActive(img)}
              className="block rounded overflow-hidden flex-shrink-0"
              style={{
                background: "var(--bg-subtle)",
                border: "1px solid var(--border)",
                padding: 0,
              }}
              aria-label="View image"
            >
              <img
                src={src}
                alt=""
                loading="lazy"
                style={{
                  maxWidth: "200px",
                  maxHeight: "160px",
                  display: "block",
                  objectFit: "cover",
                }}
              />
            </button>
          );
        })}
      </div>
      {active && (
        <ImageLightbox
          src={`/api/attachment/${active.hash}?token=${encodeURIComponent(token)}`}
          mediaType={active.mediaType}
          sizeBytes={active.sizeBytes}
          onClose={() => setActive(null)}
        />
      )}
    </>
  );
}

function AssistantBubble({ event }: { event: SessionEvent }) {
  const [expanded, setExpanded] = useState(false);
  if (!event.text && !event.thinking) {
    // Tool-only turn: rendered by adjacent ToolCard.
    return null;
  }
  const full = event.text ?? "";
  const display = !expanded && full.length > COLLAPSE_THRESHOLD ? full.slice(0, COLLAPSE_THRESHOLD) + "…" : full;
  const tokens = (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
  return (
    <div className="flex flex-col items-start my-3 slide-in">
      <Timestamp ts={event.ts} />
      <div
        className="max-w-[92%] rounded-lg px-3.5 py-2.5 mt-1"
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border)",
          color: "var(--text)",
        }}
      >
        <div className="text-[10px] uppercase tracking-wider mb-1 flex items-center gap-2" style={{ color: "var(--text-faint)" }}>
          <span>Claude</span>
          {event.model && <span>· {event.model.replace("claude-", "").replace("-20", " ").split(" ")[0]}</span>}
          {tokens > 0 && <span>· {tokens.toLocaleString()} tok</span>}
        </div>
        {event.thinking && (
          <details className="mb-2" style={{ color: "var(--text-faint)" }}>
            <summary className="cursor-pointer text-xs">Thinking</summary>
            <div className="mt-1 text-xs whitespace-pre-wrap" style={{ fontFamily: "var(--font-serif)" }}>
              {event.thinking}
            </div>
          </details>
        )}
        {event.text && (
          <div className="prose-claude">
            {display}
            {!expanded && full.length > COLLAPSE_THRESHOLD && (
              <button
                onClick={() => setExpanded(true)}
                className="ml-2 underline text-xs"
                style={{ color: "var(--accent)", fontFamily: "var(--font-sans)" }}
              >
                Show full
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingBubble({ event }: { event: SessionEvent }) {
  if (!event.thinking) return null;
  return (
    <div className="flex flex-col items-start my-2 slide-in">
      <Timestamp ts={event.ts} />
      <div
        className="max-w-[92%] rounded-lg px-3.5 py-2 mt-1"
        style={{
          background: "var(--bg-subtle)",
          border: "1px dashed var(--border)",
          color: "var(--text-muted)",
        }}
      >
        <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--text-faint)" }}>
          Thinking
        </div>
        <div className="text-sm whitespace-pre-wrap" style={{ fontFamily: "var(--font-serif)" }}>
          {event.thinking}
        </div>
      </div>
    </div>
  );
}

function SystemRow({ event, label }: { event: SessionEvent; label: string }) {
  return (
    <div className="my-2 flex items-center gap-2 text-xs italic" style={{ color: "var(--text-faint)" }}>
      <span>—</span>
      <span className="truncate">{label}</span>
      <span className="ml-auto" style={{ fontFamily: "var(--font-mono)" }}>{clockTime(event.ts)}</span>
    </div>
  );
}

function AttachmentRow({ event }: { event: SessionEvent }) {
  const kind = event.attachmentKind ?? "attachment";
  return (
    <div className="my-2 flex items-center gap-2 text-xs italic" style={{ color: "var(--text-faint)" }}>
      <Paperclip size={11} />
      <span className="truncate">{kind}{event.text ? ` · ${event.text.slice(0, 60)}` : ""}</span>
      <span className="ml-auto" style={{ fontFamily: "var(--font-mono)" }}>{clockTime(event.ts)}</span>
    </div>
  );
}

function Timestamp({ ts }: { ts: number }) {
  return (
    <div className="text-[10px] mx-1" style={{ color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>
      {clockTime(ts)}
    </div>
  );
}

