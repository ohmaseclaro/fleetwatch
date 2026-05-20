import { useState } from "react";
import { ChevronRight, ChevronDown, Wrench, Terminal, FileText, FilePen, Search, Globe, Zap, Image as ImageIcon } from "lucide-react";
import type { ToolPair } from "../lib/groupEvents";
import { toolGroupLabel, singleToolLabel } from "../lib/groupEvents";
import { clockTime } from "../lib/time";
import { useStore } from "../lib/store";
import { ImageLightbox } from "./ImageLightbox";
import type { ImageRef } from "../../shared/types";

interface Props {
  pairs: ToolPair[];
  /** If true, this group is at the bottom of the feed and may be in-flight. */
  isLast?: boolean;
}

/**
 * Decide whether to render the raw `toolResultText` pre-block. We hide it
 * when the only content is a JSON dump of image blocks (already shown as
 * thumbnails) — keeping the result clean instead of repeating yourself.
 */
function shouldShowResultText(result: { toolResultText?: string; images?: unknown[] }): boolean {
  const text = result.toolResultText ?? "";
  const hasImages = (result.images?.length ?? 0) > 0;
  if (!hasImages) return true; // no images → text is the only meaningful output
  // With images: only show text if there's something beyond an image-block JSON dump.
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Common shape: `[{"type":"image",...}]` or `{"type":"image",...}`
  const startsWithImageBlock = /^[\[{]\s*\{?\s*"type"\s*:\s*"image"/.test(trimmed);
  return !startsWithImageBlock;
}

export function ToolGroup({ pairs, isLast }: Props) {
  const [open, setOpen] = useState(false);
  const label = toolGroupLabel(pairs);
  const hasErrors = pairs.some((p) => p.result?.toolResultIsError);
  const inFlight = isLast && pairs.some((p) => !p.result);

  return (
    <div className="my-1">
      {/* Collapsed / expanded toggle row */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-md group transition-colors"
        style={{
          color: hasErrors ? "var(--status-error)" : "var(--text-muted)",
        }}
      >
        {open ? (
          <ChevronDown size={14} style={{ flexShrink: 0, color: "var(--text-faint)" }} />
        ) : (
          <ChevronRight size={14} style={{ flexShrink: 0, color: "var(--text-faint)" }} />
        )}
        <span className="text-sm truncate" style={{ color: hasErrors ? "var(--status-error)" : "var(--text-muted)" }}>
          {label}
        </span>
        {inFlight && (
          <span className="ml-1 pulse-dot" style={{ color: "var(--status-running)", fontSize: 10 }}>
            ●
          </span>
        )}
      </button>

      {/* Expanded: each pair */}
      {open && (
        <div className="ml-5 border-l pl-3 py-1 space-y-2" style={{ borderColor: "var(--border)" }}>
          {pairs.map((pair, i) => (
            <PairRow key={`${pair.use.toolUseId ?? i}`} pair={pair} />
          ))}
        </div>
      )}
    </div>
  );
}

function PairRow({ pair }: { pair: ToolPair }) {
  const [open, setOpen] = useState(false);
  const label = singleToolLabel(pair);
  const isErr = pair.result?.toolResultIsError;
  const inFlight = !pair.result;

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left flex items-center gap-2 py-0.5 group"
      >
        <ToolIcon name={pair.use.toolName} size={13} />
        <span
          className="text-xs truncate flex-1"
          style={{
            color: isErr ? "var(--status-error)" : "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {label}
        </span>
        {inFlight && <span className="pulse-dot text-[10px]" style={{ color: "var(--status-running)" }}>●</span>}
        {!inFlight && (
          open ? <ChevronDown size={11} style={{ color: "var(--text-faint)", flexShrink: 0 }} />
                : <ChevronRight size={11} style={{ color: "var(--text-faint)", flexShrink: 0 }} />
        )}
      </button>

      {open && (
        <div className="mt-1 space-y-1">
          {/* Tool input */}
          <pre
            className="overflow-auto rounded text-xs"
            style={{
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              padding: "6px 8px",
              maxHeight: 280,
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
            }}
          >
            {JSON.stringify(pair.use.toolInput, null, 2)}
          </pre>
          {/* Tool result: image thumbnails first (visual results — screenshots etc) */}
          {pair.result?.images && pair.result.images.length > 0 && (
            <ToolResultImages images={pair.result.images} />
          )}
          {/* Text result — suppressed when we have images AND the text is just a
              JSON description of those same images (i.e. nothing new to show). */}
          {pair.result && shouldShowResultText(pair.result) && (
            <pre
              className="overflow-auto rounded text-xs"
              style={{
                background: isErr ? "rgba(248,113,113,0.06)" : "var(--bg-subtle)",
                border: `1px solid ${isErr ? "var(--status-error)" : "var(--border)"}`,
                padding: "6px 8px",
                maxHeight: 280,
                fontFamily: "var(--font-mono)",
                color: isErr ? "var(--status-error)" : "var(--text-muted)",
              }}
            >
              {(pair.result.toolResultText ?? "").slice(0, 4000) || "(empty)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Render tool-result image attachments (e.g., screenshot tool output) as
 * inline thumbnails. Click to open the lightbox.
 */
function ToolResultImages({ images }: { images: ImageRef[] }) {
  const token = useStore((s) => s.token);
  const [active, setActive] = useState<ImageRef | null>(null);
  if (!token) return null;
  return (
    <>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {images.map((img) => {
          const src = `/api/attachment/${img.hash}?token=${encodeURIComponent(token)}`;
          return (
            <button
              key={img.hash}
              type="button"
              onClick={() => setActive(img)}
              className="block rounded overflow-hidden flex-shrink-0 group relative"
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
                  maxWidth: "240px",
                  maxHeight: "180px",
                  display: "block",
                  objectFit: "contain",
                }}
              />
              <span
                className="absolute top-1 left-1 inline-flex items-center gap-0.5 text-[9px] uppercase tracking-wider px-1 py-px rounded font-semibold"
                style={{ background: "rgba(0,0,0,0.55)", color: "white" }}
              >
                <ImageIcon size={9} /> {img.mediaType.replace("image/", "")}
              </span>
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

function ToolIcon({ name, size = 14 }: { name?: string; size?: number }) {
  const n = (name ?? "").toLowerCase();
  const style = { flexShrink: 0, color: "var(--text-faint)" };
  if (n === "bash" || n.startsWith("bash_")) return <Terminal size={size} style={style} />;
  if (n === "read") return <FileText size={size} style={style} />;
  if (n === "write") return <FilePen size={size} style={style} />;
  if (n === "edit" || n === "notebookedit") return <FilePen size={size} style={style} />;
  if (n === "grep" || n === "glob") return <Search size={size} style={style} />;
  if (n === "webfetch" || n === "websearch") return <Globe size={size} style={style} />;
  if (n === "task" || n === "agent") return <Zap size={size} style={style} />;
  return <Wrench size={size} style={style} />;
}
