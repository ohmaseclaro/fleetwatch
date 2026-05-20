import { useEffect, useState } from "react";
import { useStore } from "../lib/store";

interface PairingResponse {
  url: string;
  qrSvg: string;
  hostLabel: string;
  lan: string;
  port: number;
  ngrokUrl?: string | null;
  ngrokActive?: boolean;
  passwordRequired?: boolean;
}

interface AuthInfo {
  passwordRequired: boolean;
  hostLabel: string;
}

export function Pair() {
  const setToken = useStore((s) => s.setToken);
  const [pairing, setPairing] = useState<PairingResponse | null>(null);
  const [authInfo, setAuthInfo] = useState<AuthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualToken, setManualToken] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Pairing token captured from ?token= in the URL (or pasted manually).
  const [pairingToken, setPairingToken] = useState<string | null>(null);

  useEffect(() => {
    // Capture ?token= from the URL but DON'T set it as the auth token yet —
    // first we need to know whether a password is required.
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token");
    if (t) {
      setPairingToken(t);
      window.history.replaceState({}, "", "/");
    }

    // Ask the server what auth flow to show.
    fetch("/api/auth-info")
      .then((r) => (r.ok ? r.json() : null))
      .then((info: AuthInfo | null) => {
        if (info) setAuthInfo(info);
      })
      .catch(() => {});

    // Pairing info — only succeeds if we're on localhost (the desktop).
    fetch("/api/pairing")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setPairing(data);
      })
      .catch(() => {});
  }, []);

  // When we have both the URL token AND know no password is needed, auto-login.
  useEffect(() => {
    if (!authInfo || !pairingToken || authInfo.passwordRequired || submitting) return;
    void doLogin({ token: pairingToken });
  }, [authInfo, pairingToken]);

  async function doLogin(body: { token?: string; password?: string }) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.error === "invalid_password") setError("Incorrect password.");
        else if (data.error === "password_required") setError("Password required.");
        else if (data.error === "invalid_token") setError("Invalid or missing pairing token.");
        else setError("Login failed.");
        return;
      }
      // Successful login — store the JWT and reload into the main app.
      setToken(data.jwt);
      window.location.reload();
    } catch (err) {
      setError("Network error.");
    } finally {
      setSubmitting(false);
    }
  }

  function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!password) {
      setError("Enter a password.");
      return;
    }
    void doLogin({ token: pairingToken ?? undefined, password });
  }

  function submitManualToken(e: React.FormEvent) {
    e.preventDefault();
    if (manualToken.trim().length < 8) {
      setError("Token looks too short.");
      return;
    }
    setPairingToken(manualToken.trim());
    // The useEffect above will pick this up and either auto-login (no password)
    // or wait for the password form (which will use the same pairingToken).
    if (authInfo?.passwordRequired) {
      setError(null);
    } else {
      void doLogin({ token: manualToken.trim() });
    }
  }

  // ─── Rendering ──────────────────────────────────────────────────────────

  const showPasswordForm = !!authInfo?.passwordRequired;
  const onDesktop = !!pairing;
  const publicUrl = pairing?.ngrokUrl;

  return (
    <div className="flex flex-col flex-1 min-h-full safe-top safe-x safe-bottom">
      <header className="px-5 py-4 flex items-center gap-3">
        <Logo />
        <div>
          <h1 className="text-lg font-semibold" style={{ color: "var(--text)" }}>
            fleetwatch
          </h1>
          <p className="text-xs" style={{ color: "var(--text-faint)" }}>
            {authInfo
              ? showPasswordForm
                ? "Enter your password"
                : "Pair this device to start watching"
              : "Connecting…"}
          </p>
        </div>
      </header>

      <main className="flex-1 px-5 pt-2 pb-10 flex flex-col items-center justify-start">
        {/* Password form — shown on phone OR when password is required */}
        {showPasswordForm && !onDesktop && (
          <form onSubmit={submitPassword} className="w-full max-w-sm mt-4">
            <p className="text-sm text-center mb-5" style={{ color: "var(--text-muted)" }}>
              This fleetwatch requires a password.
            </p>
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full px-3 py-3 rounded-lg text-sm"
              style={{
                background: "var(--bg-elevated)",
                color: "var(--text)",
                border: "1px solid var(--border)",
              }}
            />
            {error && (
              <div className="mt-2 text-sm" style={{ color: "var(--status-error)" }}>
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={submitting}
              className="mt-3 w-full py-3 rounded-lg font-medium text-sm"
              style={{
                background: "var(--accent)",
                color: "white",
                opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting ? "Connecting…" : "Connect"}
            </button>
          </form>
        )}

        {/* Desktop view: QR + URL */}
        {onDesktop && pairing && (
          <>
            <p className="text-sm text-center max-w-sm mb-5" style={{ color: "var(--text-muted)" }}>
              {publicUrl ? (
                <>Scan to open from <b>anywhere</b> (via ngrok) on <b>{pairing.hostLabel}</b>.</>
              ) : (
                <>Scan from your phone — must be on the same Wi-Fi as <b>{pairing.hostLabel}</b>.</>
              )}
            </p>
            <div
              className="p-5 rounded-lg"
              style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}
              dangerouslySetInnerHTML={{ __html: pairing.qrSvg }}
            />
            <div className="mt-5 text-center">
              <div className="text-xs uppercase tracking-wider mb-1" style={{ color: "var(--text-faint)" }}>
                {publicUrl ? "public URL" : "LAN URL"}
              </div>
              <div className="font-mono text-sm break-all max-w-md" style={{ color: "var(--accent)" }}>
                {pairing.url}
              </div>
              {showPasswordForm && (
                <div className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
                  · Password required ·
                </div>
              )}
            </div>
            <button
              className="mt-8 text-xs underline"
              style={{ color: "var(--text-muted)" }}
              onClick={() => {
                const t = extractTokenFromUrl(pairing.url);
                if (t) {
                  setPairingToken(t);
                  if (!showPasswordForm) void doLogin({ token: t });
                }
              }}
              disabled={submitting}
            >
              {showPasswordForm ? "Or enter the password here" : "Or just use this device to watch"}
            </button>
            {showPasswordForm && pairingToken && (
              <form onSubmit={submitPassword} className="w-full max-w-sm mt-4">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  className="w-full px-3 py-3 rounded-lg text-sm"
                  style={{
                    background: "var(--bg-elevated)",
                    color: "var(--text)",
                    border: "1px solid var(--border)",
                  }}
                />
                {error && (
                  <div className="mt-2 text-sm" style={{ color: "var(--status-error)" }}>
                    {error}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={submitting}
                  className="mt-3 w-full py-3 rounded-lg font-medium text-sm"
                  style={{
                    background: "var(--accent)",
                    color: "white",
                    opacity: submitting ? 0.6 : 1,
                  }}
                >
                  {submitting ? "Connecting…" : "Connect"}
                </button>
              </form>
            )}
          </>
        )}

        {/* Phone — no password required, no token yet: ask for pairing token */}
        {!onDesktop && !showPasswordForm && (
          <>
            <p className="text-sm text-center max-w-sm mb-5" style={{ color: "var(--text-muted)" }}>
              Open the <span style={{ color: "var(--accent)" }}>fleetwatch</span> URL printed in your desktop terminal — that's the URL with the <code style={{ fontFamily: "var(--font-mono)" }}>?token=</code> on it.
            </p>
            <form onSubmit={submitManualToken} className="w-full max-w-sm">
              <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: "var(--text-faint)" }}>
                Or paste the token manually
              </label>
              <input
                type="text"
                value={manualToken}
                onChange={(e) => setManualToken(e.target.value)}
                placeholder="paste token from terminal"
                className="w-full px-3 py-3 rounded-lg text-sm"
                style={{
                  background: "var(--bg-elevated)",
                  color: "var(--text)",
                  border: "1px solid var(--border)",
                  fontFamily: "var(--font-mono)",
                }}
              />
              {error && (
                <div className="mt-2 text-sm" style={{ color: "var(--status-error)" }}>
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={submitting}
                className="mt-3 w-full py-3 rounded-lg font-medium text-sm"
                style={{ background: "var(--accent)", color: "white", opacity: submitting ? 0.6 : 1 }}
              >
                {submitting ? "Connecting…" : "Connect"}
              </button>
            </form>
          </>
        )}
      </main>

      <footer className="px-5 pb-4 text-xs text-center" style={{ color: "var(--text-faint)" }}>
        Read-only. {authInfo?.passwordRequired ? "Password-protected." : "Token-protected."} v0.1.0
      </footer>
    </div>
  );
}

function extractTokenFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get("token");
  } catch {
    return null;
  }
}

function Logo() {
  return (
    <svg width="36" height="36" viewBox="0 0 192 192">
      <rect width="192" height="192" rx="42" fill="var(--bg-elevated)" />
      <circle cx="96" cy="96" r="48" fill="none" stroke="var(--accent)" strokeWidth="10" />
      <circle cx="96" cy="96" r="14" fill="var(--accent)" />
      <path
        d="M96 32 v18 M96 142 v18 M32 96 h18 M142 96 h18"
        stroke="var(--accent)"
        strokeWidth="8"
        strokeLinecap="round"
      />
    </svg>
  );
}
