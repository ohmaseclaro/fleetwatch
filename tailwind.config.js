/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        "bg-elevated": "var(--bg-elevated)",
        "bg-subtle": "var(--bg-subtle)",
        text: "var(--text)",
        "text-muted": "var(--text-muted)",
        "text-faint": "var(--text-faint)",
        accent: "var(--accent)",
        "accent-soft": "var(--accent-soft)",
        "accent-bg": "var(--accent-bg)",
        border: "var(--border)",
        "border-strong": "var(--border-strong)",
        "status-running": "var(--status-running)",
        "status-tool": "var(--status-tool)",
        "status-waiting": "var(--status-waiting)",
        "status-idle": "var(--status-idle)",
        "status-error": "var(--status-error)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        serif: ["var(--font-serif)"],
        mono: ["var(--font-mono)"],
      },
      borderRadius: {
        DEFAULT: "var(--radius)",
        sm: "var(--radius-sm)",
        lg: "var(--radius-lg)",
      },
    },
  },
  plugins: [],
};
