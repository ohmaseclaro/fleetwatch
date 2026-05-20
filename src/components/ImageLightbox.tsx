import { useEffect } from "react";
import { X } from "lucide-react";

interface Props {
  src: string;
  mediaType: string;
  sizeBytes: number;
  onClose: () => void;
}

/**
 * Fullscreen image viewer for attached images. Click outside / press Escape
 * to dismiss. Intentionally minimal — the goal is "make the image bigger",
 * not implement zoom/pan/share.
 */
export function ImageLightbox({ src, mediaType, sizeBytes, onClose }: Props) {
  // Escape-to-close keyboard shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center safe-top safe-bottom safe-x"
      style={{ background: "rgba(0,0,0,0.85)" }}
    >
      {/* Close button (always visible, top-right). */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="absolute top-3 right-3 flex items-center justify-center w-9 h-9 rounded-full"
        style={{ background: "rgba(255,255,255,0.12)", color: "white" }}
        aria-label="Close"
      >
        <X size={18} />
      </button>
      {/* Image. Stops click from bubbling to backdrop. */}
      <img
        src={src}
        alt=""
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          padding: "2.5rem 1rem",
        }}
      />
      {/* Tiny metadata strip at the bottom. */}
      <div
        className="absolute bottom-2 left-0 right-0 text-center text-[11px]"
        style={{ color: "rgba(255,255,255,0.55)" }}
      >
        {mediaType.replace("image/", "").toUpperCase()} · {formatBytes(sizeBytes)}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
