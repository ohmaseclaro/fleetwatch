import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useStore } from "./lib/store";
import { connect, disconnect } from "./lib/transport";
import { Pair } from "./screens/Pair";
import { SessionList } from "./screens/SessionList";
import { SessionDetail } from "./screens/SessionDetail";
import { Settings } from "./screens/Settings";

export default function App() {
  const token = useStore((s) => s.token);

  useEffect(() => {
    if (token) {
      connect(token);
      return () => disconnect();
    }
  }, [token]);

  if (!token) {
    return (
      <Routes>
        <Route path="*" element={<Pair />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<SessionList />} />
      <Route path="/s/:id" element={<SessionDetail />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
