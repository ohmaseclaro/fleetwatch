import { useEffect, useState } from "react";
import { X, Copy, Check, FileText, FolderOpen, GitBranch, Activity, Hash } from "lucide-react";
import { useStore } from "../lib/store";

interface SessionInfo {
  sessionId: string;
  source: string;
  filePath: string | null;
  fileExists: boolean;
  fileSize: number | null;
  projectPath: string;
  projectLabel: string;
  gitBranch: string | null;
  eventCount: number;
  lastEventAt: number;
  lastUserMessageAt: number;
  status: string;
  aiTitle: string | null;
  customTitle: string | null;
  isSubagent: boolean;
  parentSessionId: string | null;
}

interface Props {
  sessionId: string;
  onClose: () => void;
}

/**
 * Bottom-sheet style modal showing where the session's transcript lives on
 * disk. The headline feature: the full file path with a tap-to-copy button,
 * so the user can quickly jump to the file in their editor or terminal.
 */
export function SessionInfoModal({ sessionId, onClose }: Props) {
  const token = useStore((s) => s.token);
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Fetch info on mount.
  useEffect(() => {
    if (!token) return;
    fetch(`/api/session/${sessionId}/info?token=${encodeURIComponent(token)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then(setInfo)
      .catch((e) => setError(String(e)));
  }, [sessionId, token]);

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock body scroll.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  async function copy(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      // clipboard API may be unavailable on HTTP / older browsers
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); setCopied(key); setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500); } catch {}
      document.body.removeChild(ta);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center safe-top safe-x"
      style={{ background: "rgba(0,0,0,0.55)" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md max-h-[85vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl flex flex-col"
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 sticky top-0"
          style={{ background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)" }}
        >
          <div className="flex items-center gap-2">
            <FileText size={16} style={{ color: "var(--accent)" }} />
            <h2 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              Session details
            </h2>
          </div>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-8 h-8 rounded-md"
            style={{ background: "var(--bg-subtle)", color: "var(--text-muted)" }}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-3 safe-bottom">
          {error && (
            <div className="text-sm" style={{ color: "var(--status-error)" }}>
              Failed to load: {error}
            </div>
          )}
          {!info && !error && (
            <div className="text-sm" style={{ color: "var(--text-muted)" }}>
              Loading…
            </div>
          )}
          {info && (
            <>
              {/* File path — the headline feature */}
              <Field
                icon={<FileText size={13} />}
                label={info.filePath?.startsWith("cursor:") ? "Cursor DB entry" : "Transcript file"}
              >
                {info.filePath ? (
                  <PathBlock
                    value={
                      info.filePath.startsWith("cursor:")
                        ? `cursor://composer/${info.sessionId}`
                        : info.filePath
                    }
                    copyKey="filePath"
                    copied={copied}
                    onCopy={copy}
                    secondary={
                      info.filePath.startsWith("cursor:")
                        ? "Stored in Cursor's SQLite (~/Library/Application Support/Cursor/User/globalStorage/state.vscdb)"
                        : info.fileExists
                          ? formatBytes(info.fileSize ?? 0)
                          : "file no longer exists"
                    }
                  />
                ) : (
                  <span style={{ color: "var(--text-muted)" }}>(unknown)</span>
                )}
              </Field>

              <Field icon={<FolderOpen size={13} />} label="Project">
                <PathBlock
                  value={info.projectPath}
                  copyKey="projectPath"
                  copied={copied}
                  onCopy={copy}
                  secondary={info.projectLabel}
                />
              </Field>

              {info.gitBranch && (
                <Field icon={<GitBranch size={13} />} label="Git branch">
                  <span className="text-sm font-mono" style={{ color: "var(--text)" }}>
                    {info.gitBranch}
                  </span>
                </Field>
              )}

              <Field icon={<Hash size={13} />} label="Session ID">
                <PathBlock
                  value={info.sessionId}
                  copyKey="sessionId"
                  copied={copied}
                  onCopy={copy}
                  secondary={`source: ${info.source}`}
                />
              </Field>

              {info.parentSessionId && (
                <Field icon={<Hash size={13} />} label="Parent session (subagent)">
                  <PathBlock
                    value={info.parentSessionId}
                    copyKey="parentSessionId"
                    copied={copied}
                    onCopy={copy}
                  />
                </Field>
              )}

              <Field icon={<Activity size={13} />} label="Activity">
                <div className="grid grid-cols-2 gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
                  <Stat label="Status" value={info.status} />
                  <Stat label="Events" value={info.eventCount.toLocaleString()} />
                  <Stat label="Last event" value={info.lastEventAt ? new Date(info.lastEventAt).toLocaleString() : "—"} />
                  <Stat label="Last user msg" value={info.lastUserMessageAt ? new Date(info.lastUserMessageAt).toLocaleString() : "—"} />
                </div>
              </Field>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className="text-[10px] uppercase tracking-wider mb-1 flex items-center gap-1.5"
        style={{ color: "var(--text-faint)" }}
      >
        <span style={{ color: "var(--text-faint)" }}>{icon}</span>
        {label}
      </div>
      {children}
    </div>
  );
}

function PathBlock({
  value,
  copyKey,
  copied,
  onCopy,
  secondary,
}: {
  value: string;
  copyKey: string;
  copied: string | null;
  onCopy: (v: string, k: string) => void;
  secondary?: string;
}) {
  const isCopied = copied === copyKey;
  return (
    <div
      className="flex items-start gap-2 px-2 py-1.5 rounded"
      style={{ background: "var(--bg-subtle)", border: "1px solid var(--border)" }}
    >
      <div className="flex-1 min-w-0">
        <div
          className="text-xs break-all"
          style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}
        >
          {value}
        </div>
        {secondary && (
          <div className="text-[10px] mt-1" style={{ color: "var(--text-faint)" }}>
            {secondary}
          </div>
        )}
      </div>
      <button
        onClick={() => onCopy(value, copyKey)}
        className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors"
        style={{
          background: isCopied ? "var(--status-running)" : "transparent",
          color: isCopied ? "white" : "var(--text-muted)",
          border: "1px solid var(--border)",
        }}
        aria-label="Copy"
        title="Copy to clipboard"
      >
        {isCopied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
        {label}
      </div>
      <div className="text-xs" style={{ color: "var(--text)" }}>
        {value}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n === 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
