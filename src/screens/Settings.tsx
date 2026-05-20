import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ExternalLink } from "lucide-react";
import { useStore } from "../lib/store";
import { disconnect } from "../lib/transport";

interface Health {
  ok: boolean;
  host: string;
  platform: string;
  version: string;
}

interface PairingInfo {
  hostLabel: string;
  ngrokUrl: string | null;
  ngrokActive: boolean;
  ngrokConfigured: boolean;
  ngrokDisabled?: boolean;
  passwordRequired?: boolean;
}

interface TunnelStatus {
  active: boolean;
  url: string | null;
  error?: { code: string; raw: string; hint: string } | null;
}

export function Settings() {
  const setToken = useStore((s) => s.setToken);
  const token = useStore((s) => s.token);
  const connection = useStore((s) => s.connection);
  const sessionCount = useStore((s) => Object.keys(s.sessions).length);
  const [health, setHealth] = useState<Health | null>(null);
  const [hostLabel, setHostLabel] = useState("");
  const [isLocal, setIsLocal] = useState(false);
  const [ngrokAuthtoken, setNgrokAuthtoken] = useState("");
  const [ngrokDisabled, setNgrokDisabled] = useState(false);
  const [tunnel, setTunnel] = useState<TunnelStatus | null>(null);
  const [tunnelSaving, setTunnelSaving] = useState(false);
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordRequired, setPasswordRequired] = useState(false);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((h) => h && setHealth(h));
    fetch("/api/pairing")
      .then((r) => (r.ok ? r.json() : null))
      .then((p: PairingInfo | null) => {
        if (p) {
          setIsLocal(true);
          setHostLabel(p.hostLabel);
          setPairing(p);
          setNgrokDisabled(!!p.ngrokDisabled);
          setPasswordRequired(!!p.passwordRequired);
        }
      });
    // Also check auth-info publicly (works from phone too).
    fetch("/api/auth-info")
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => info && setPasswordRequired(!!info.passwordRequired));
    // Poll tunnel status so the phone can see when ngrok comes up.
    if (token) {
      fetch(`/api/tunnel?token=${encodeURIComponent(token)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((t: TunnelStatus | null) => t && setTunnel(t));
    }
  }, [token]);

  async function saveSettings(patch: {
    hostLabel?: string;
    ngrokAuthtoken?: string;
    ngrokDisabled?: boolean;
    password?: string;
  }) {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ngrokUrl !== undefined) {
        setTunnel({ active: data.ngrokActive, url: data.ngrokUrl });
        setPairing((p) =>
          p
            ? {
                ...p,
                ngrokUrl: data.ngrokUrl,
                ngrokActive: data.ngrokActive,
                ngrokDisabled: data.ngrokDisabled,
                passwordRequired: data.passwordRequired,
              }
            : p,
        );
      }
      if (typeof data.passwordRequired === "boolean") {
        setPasswordRequired(data.passwordRequired);
      }
    }
  }

  async function saveTunnel() {
    setTunnelSaving(true);
    try {
      await saveSettings({ ngrokAuthtoken });
      setNgrokAuthtoken(""); // clear field after save (token is sensitive)
      // Poll /api/tunnel a few times — tunnel start is async on the server.
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 750));
        if (!token) break;
        const r = await fetch(`/api/tunnel?token=${encodeURIComponent(token)}`);
        if (!r.ok) continue;
        const data: TunnelStatus = await r.json();
        setTunnel(data);
        if (data.active || data.error) break;
      }
    } finally {
      setTunnelSaving(false);
    }
  }

  async function savePassword(clear: boolean) {
    setPasswordSaving(true);
    try {
      await saveSettings({ password: clear ? "" : newPassword });
      setNewPassword("");
      if (clear) {
        alert("Password cleared. Anyone with the pairing URL can now connect.");
      } else {
        alert("Password set. Existing devices may need to re-authenticate.");
      }
    } finally {
      setPasswordSaving(false);
    }
  }

  function unpair() {
    if (!confirm("Forget this pairing? You'll need to scan again.")) return;
    disconnect();
    setToken(null);
    window.location.reload();
  }

  return (
    <div className="flex flex-col flex-1 min-h-full" style={{ background: "var(--bg)" }}>
      <header className="safe-top safe-x px-4 py-3 flex items-center gap-2 border-b" style={{ borderColor: "var(--border)" }}>
        <Link to="/" className="flex items-center justify-center w-8 h-8 rounded-md" style={{ background: "var(--bg-subtle)", color: "var(--accent)" }}>
          <ChevronLeft size={18} />
        </Link>
        <h1 className="text-base font-semibold" style={{ color: "var(--text)" }}>
          Settings
        </h1>
      </header>

      <main className="flex-1 overflow-y-auto safe-bottom px-4 py-4 space-y-6">
        <Section title="Connection">
          <Row label="Status">
            <span style={{ color: connection.status === "connected" ? "var(--status-running)" : "var(--text-muted)" }}>
              {connection.status}
            </span>
          </Row>
          <Row label="Host">
            <span>{connection.hostname ?? health?.host ?? "—"}</span>
          </Row>
          <Row label="Platform">
            <span>{connection.platform ?? health?.platform ?? "—"}</span>
          </Row>
          <Row label="Daemon version">
            <span style={{ fontFamily: "var(--font-mono)" }}>{connection.agentVersion ?? health?.version ?? "—"}</span>
          </Row>
          <Row label="Sessions cached">
            <span>{sessionCount}</span>
          </Row>
        </Section>

        {/* ngrok tunnel status — shown to all connected clients */}
        <Section
          title="ngrok tunnel"
          subtitle="Public HTTPS URL — reach your sessions from anywhere (cellular, coffee shops, anywhere)."
        >
          {tunnel?.active && tunnel.url ? (
            <div className="flex items-center gap-2 py-1.5">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: "var(--status-running)" }}
              />
              <span className="text-xs flex-1 truncate" style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                {tunnel.url}
              </span>
              <a
                href={tunnel.url}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)" }}
              >
                <ExternalLink size={14} />
              </a>
            </div>
          ) : tunnel?.error ? (
            <div className="py-1.5">
              <div className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ background: "var(--status-error)" }}
                />
                <span className="text-xs font-medium" style={{ color: "var(--status-error)" }}>
                  Tunnel failed: {tunnel.error.code.replace("_", " ")}
                </span>
              </div>
              <p className="text-xs mt-1 ml-4" style={{ color: "var(--text-muted)" }}>
                {tunnel.error.hint}
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2 py-1.5">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: "var(--text-faint)" }}
              />
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                {pairing?.ngrokDisabled
                  ? "Disabled (LAN only)"
                  : pairing?.ngrokConfigured
                    ? "Connecting…"
                    : "Not configured — paste an authtoken below to enable"}
              </span>
            </div>
          )}
          {isLocal && (
            <div className="mt-2 pt-2" style={{ borderTop: "1px solid var(--border)" }}>
              {/* Step-by-step setup guide — only shown when not yet active */}
              {!tunnel?.active && !ngrokDisabled && (
                <ol className="text-xs space-y-2 mb-3" style={{ color: "var(--text-muted)" }}>
                  <li className="flex gap-2">
                    <span style={{ color: "var(--accent)" }}>1.</span>
                    <span>
                      Sign up free (no credit card):{" "}
                      <a
                        href="https://dashboard.ngrok.com/signup"
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-0.5"
                        style={{ color: "var(--accent)" }}
                      >
                        dashboard.ngrok.com/signup <ExternalLink size={10} />
                      </a>
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span style={{ color: "var(--accent)" }}>2.</span>
                    <span>
                      Copy your authtoken:{" "}
                      <a
                        href="https://dashboard.ngrok.com/get-started/your-authtoken"
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-0.5"
                        style={{ color: "var(--accent)" }}
                      >
                        get-started/your-authtoken <ExternalLink size={10} />
                      </a>
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span style={{ color: "var(--accent)" }}>3.</span>
                    <span>Paste it below and click Save.</span>
                  </li>
                </ol>
              )}
              <div className="flex gap-2">
                <input
                  type="password"
                  value={ngrokAuthtoken}
                  onChange={(e) => setNgrokAuthtoken(e.target.value)}
                  placeholder={tunnel?.active ? "Token saved — paste to replace" : "Paste authtoken (e.g. 2abc...)"}
                  className="flex-1 text-xs px-2 py-1.5 rounded"
                  style={{
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                  }}
                />
                <button
                  onClick={saveTunnel}
                  disabled={!ngrokAuthtoken.trim() || tunnelSaving}
                  className="text-xs px-3 py-1.5 rounded font-medium"
                  style={{
                    background: ngrokAuthtoken.trim() ? "var(--accent)" : "var(--bg-subtle)",
                    color: ngrokAuthtoken.trim() ? "white" : "var(--text-muted)",
                    opacity: tunnelSaving ? 0.6 : 1,
                  }}
                >
                  {tunnelSaving ? "Starting…" : "Save"}
                </button>
              </div>
              <label className="flex items-center justify-between py-2 mt-3">
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Disable ngrok (use LAN only)
                </span>
                <input
                  type="checkbox"
                  checked={ngrokDisabled}
                  onChange={async (e) => {
                    setNgrokDisabled(e.target.checked);
                    await saveSettings({ ngrokDisabled: e.target.checked });
                  }}
                />
              </label>
            </div>
          )}
        </Section>

        {/* Password protection — desktop only */}
        {isLocal && (
          <Section
            title="Password protection"
            subtitle="Optional. When set, every device must enter the password before connecting (recommended if ngrok is on)."
          >
            <div className="flex items-center gap-2 py-1.5">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: passwordRequired ? "var(--status-running)" : "var(--text-faint)" }}
              />
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                {passwordRequired ? "Password is set" : "No password — anyone with the URL can connect"}
              </span>
            </div>
            <div className="mt-2 pt-2 flex gap-2" style={{ borderTop: "1px solid var(--border)" }}>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={passwordRequired ? "Enter new password to replace" : "Enter a password…"}
                className="flex-1 text-xs px-2 py-1.5 rounded"
                style={{
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                }}
              />
              <button
                onClick={() => savePassword(false)}
                disabled={!newPassword || passwordSaving}
                className="text-xs px-3 py-1.5 rounded font-medium"
                style={{
                  background: newPassword ? "var(--accent)" : "var(--bg-subtle)",
                  color: newPassword ? "white" : "var(--text-muted)",
                  opacity: passwordSaving ? 0.6 : 1,
                }}
              >
                Set
              </button>
              {passwordRequired && (
                <button
                  onClick={() => savePassword(true)}
                  disabled={passwordSaving}
                  className="text-xs px-3 py-1.5 rounded font-medium"
                  style={{
                    background: "transparent",
                    color: "var(--status-error)",
                    border: "1px solid var(--status-error)",
                    opacity: passwordSaving ? 0.6 : 1,
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            <p className="text-[11px] mt-2" style={{ color: "var(--text-faint)" }}>
              Or set <code style={{ fontFamily: "var(--font-mono)" }}>PASSWORD=…</code> in your <code style={{ fontFamily: "var(--font-mono)" }}>.env</code> file
              (env-set passwords survive restart; UI-set ones do not).
            </p>
          </Section>
        )}

        {isLocal && (
          <Section title="Desktop preferences" subtitle="Only visible & editable from the desktop running the daemon.">
            <Row label="Host label">
              <input
                value={hostLabel}
                onChange={(e) => setHostLabel(e.target.value)}
                onBlur={() => saveSettings({ hostLabel })}
                className="text-sm px-2 py-1 rounded"
                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text)" }}
              />
            </Row>
            <p className="text-[11px] mt-2 pt-2" style={{ color: "var(--text-faint)", borderTop: "1px solid var(--border)" }}>
              Cowork sessions are auto-discovered when{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>~/Library/Application Support/Claude/local-agent-mode-sessions/</code>{" "}
              exists. Filter visibility with the source tabs on the home screen.
            </p>
            <p className="text-[11px] mt-2" style={{ color: "var(--text-faint)" }}>
              Cursor sessions are auto-discovered from the Cursor IDE's SQLite store. Disable with{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>--no-cursor</code> or{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>CURSOR_DISABLED=1</code>.
            </p>
          </Section>
        )}

        <Section title="Pairing">
          <button
            onClick={unpair}
            className="w-full py-3 rounded-md text-sm font-medium"
            style={{
              background: "transparent",
              color: "var(--status-error)",
              border: "1px solid var(--status-error)",
            }}
          >
            Unpair this device
          </button>
        </Section>

        <Section title="About">
          <p className="text-xs" style={{ color: "var(--text-faint)" }}>
            fleetwatch · read-only mobile companion for Claude Code, Cowork, and Cursor · v0.1.0
          </p>
          <p className="text-xs mt-2" style={{ color: "var(--text-faint)" }}>
            Watches <code style={{ fontFamily: "var(--font-mono)" }}>~/.claude/projects/</code> and{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>~/.claude/history.jsonl</code>. Never writes to either.
          </p>
        </Section>
      </main>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section
      className="rounded-lg overflow-hidden"
      style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}
    >
      <div className="px-3 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
        <h2 className="text-xs uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
          {title}
        </h2>
        {subtitle && (
          <p className="text-[11px] mt-0.5" style={{ color: "var(--text-faint)" }}>
            {subtitle}
          </p>
        )}
      </div>
      <div className="px-3 py-2">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ color: "var(--text)" }}>{children}</span>
    </div>
  );
}
