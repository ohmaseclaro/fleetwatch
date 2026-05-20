import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { existsSync } from "node:fs";
import Fastify, { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { SessionRegistry } from "./registry.js";
import type { ProviderManager } from "./providers/types.js";
import { attachmentStore } from "./attachmentStore.js";
import { Config, buildPairingPayload, pickLanIp, rotateToken, saveConfig } from "./pairing.js";
import { startTunnel, stopTunnel, activeTunnel, lastTunnelError } from "./tunnel.js";
import {
  isAuthorized,
  isPasswordRequired,
  issueJwt,
  setPairingToken,
  setPassword,
  verifyPassword,
} from "./auth.js";
import type { Frame, Session, SessionEvent } from "../shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  port: number;
  host: string;
  config: Config;
  registry: SessionRegistry;
  /** Fan-out target for backfill requests across all configured providers. */
  providers: ProviderManager;
  webRoot: string;
  agentVersion: string;
  onConfigChanged: (cfg: Config) => void;
  /** Called when a new ngrok authtoken is saved so the tunnel can be (re)started. */
  onTunnelAuthtoken?: (authtoken: string) => Promise<void>;
  onLog?: (msg: string) => void;
}

export async function startServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true });

  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: 1024 * 1024,
    },
  });

  // Block browser extensions (e.g. Claude Code's SES lockdown) from injecting
  // scripts into the app. Inline styles are needed for Tailwind utility classes.
  app.addHook("onSend", async (_req, reply, payload) => {
    const ct = reply.getHeader("content-type") as string | undefined;
    if (ct && ct.startsWith("text/html")) {
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: https:;"
      );
    }
    return payload;
  });

  if (existsSync(opts.webRoot)) {
    await app.register(fastifyStatic, {
      root: opts.webRoot,
      prefix: "/",
      wildcard: false,
      decorateReply: true,
    });
  }

  // Auth helper: token is presented either as ?token= or Authorization: Bearer
  // and may be either a JWT or the pairing token (when no password is set).
  const requireToken = (token: string | undefined): boolean => isAuthorized(token);

  // --- HTTP routes ---

  app.get("/api/health", async () => ({
    ok: true,
    host: opts.config.hostLabel,
    platform: process.platform,
    version: opts.agentVersion,
  }));

  /** Public — tells the client what auth method to use. */
  app.get("/api/auth-info", async () => ({
    passwordRequired: isPasswordRequired(),
    hostLabel: opts.config.hostLabel,
  }));

  /**
   * Exchange pairing token + optional password for a JWT.
   * Rules:
   *   - No password configured: valid pairing token required.
   *   - Password configured:    valid password required (pairing token optional).
   */
  app.post<{ Body: { token?: string; password?: string } }>("/api/login", async (req, reply) => {
    const body = req.body ?? {};
    const passwordNeeded = isPasswordRequired();

    if (passwordNeeded) {
      if (typeof body.password !== "string" || body.password.length === 0) {
        reply.code(400);
        return { error: "password_required" };
      }
      const ok = await verifyPassword(body.password);
      if (!ok) {
        reply.code(401);
        return { error: "invalid_password" };
      }
    } else {
      // No password — require valid pairing token (provided via QR URL).
      if (typeof body.token !== "string" || body.token !== opts.config.token) {
        reply.code(401);
        return { error: "invalid_token" };
      }
    }

    const { token: jwtToken, expiresAt } = issueJwt();
    return { jwt: jwtToken, expiresAt, passwordRequired: passwordNeeded };
  });

  app.get("/api/pairing", async (req, reply) => {
    // Only available from localhost.
    const ip = req.ip;
    const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (!isLocal) {
      reply.code(403);
      return { error: "Pairing info is only available from localhost." };
    }
    const lan = pickLanIp() ?? "127.0.0.1";
    const tunnel = activeTunnel();
    const payload = await buildPairingPayload(lan, opts.port, opts.config.token, tunnel?.url);
    return {
      url: payload.url,
      qrSvg: payload.qrSvg,
      hostLabel: opts.config.hostLabel,
      lan,
      port: opts.port,
      ngrokUrl: tunnel?.url ?? null,
      ngrokActive: !!tunnel,
      ngrokConfigured: !!(opts.config.ngrokAuthtoken || process.env.NGROK_AUTHTOKEN),
      ngrokDisabled: !!opts.config.ngrokDisabled,
      passwordRequired: isPasswordRequired(),
    };
  });

  /** Tunnel status — available to any authenticated client so the phone can show it. */
  app.get("/api/tunnel", async (req, reply) => {
    const token = extractToken(req.query as any, req.headers.authorization);
    if (!requireToken(token)) {
      reply.code(401);
      return { error: "unauthorized" };
    }
    const tunnel = activeTunnel();
    const err = lastTunnelError();
    return {
      active: !!tunnel,
      url: tunnel?.url ?? null,
      error: tunnel ? null : err,
    };
  });

  app.post("/api/rotate-token", async (req, reply) => {
    const ip = req.ip;
    const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (!isLocal) {
      reply.code(403);
      return { error: "Local only." };
    }
    const next = await rotateToken(opts.config);
    opts.config.token = next.token;
    setPairingToken(next.token);
    opts.onConfigChanged(next);
    return { ok: true, token: next.token };
  });

  app.post<{
    Body: {
      includeCowork?: boolean;
      hostLabel?: string;
      ngrokAuthtoken?: string;
      ngrokDisabled?: boolean;
      /** Plaintext — hashed in memory immediately. Empty string clears the password. */
      password?: string;
    };
  }>("/api/settings", async (req, reply) => {
    const ip = req.ip;
    const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (!isLocal) {
      reply.code(403);
      return { error: "Local only." };
    }
    if (typeof req.body?.includeCowork === "boolean") {
      opts.config.preferences.includeCowork = req.body.includeCowork;
    }
    if (typeof req.body?.hostLabel === "string" && req.body.hostLabel.length > 0) {
      opts.config.hostLabel = req.body.hostLabel.slice(0, 80);
    }
    if (typeof req.body?.password === "string") {
      setPassword(req.body.password.length > 0 ? req.body.password : null);
    }
    let tunnelRestarted = false;
    if (typeof req.body?.ngrokDisabled === "boolean") {
      opts.config.ngrokDisabled = req.body.ngrokDisabled;
      if (req.body.ngrokDisabled) {
        await stopTunnel().catch(() => {});
      } else if (opts.onTunnelAuthtoken && opts.config.ngrokAuthtoken) {
        await opts.onTunnelAuthtoken(opts.config.ngrokAuthtoken).catch(() => {});
        tunnelRestarted = true;
      }
    }
    if (typeof req.body?.ngrokAuthtoken === "string") {
      const token = req.body.ngrokAuthtoken.trim();
      opts.config.ngrokAuthtoken = token || undefined;
      if (opts.onTunnelAuthtoken && token && !opts.config.ngrokDisabled) {
        await opts.onTunnelAuthtoken(token).catch(() => {});
        tunnelRestarted = true;
      } else if (!token) {
        await stopTunnel().catch(() => {});
      }
    }
    await saveConfig(opts.config);
    opts.onConfigChanged(opts.config);
    const tunnel = activeTunnel();
    return {
      ok: true,
      hostLabel: opts.config.hostLabel,
      includeCowork: opts.config.preferences.includeCowork,
      ngrokUrl: tunnel?.url ?? null,
      ngrokActive: !!tunnel,
      ngrokDisabled: !!opts.config.ngrokDisabled,
      passwordRequired: isPasswordRequired(),
      tunnelRestarted,
    };
  });

  /**
   * Serve a stored image attachment. Content-addressed — the hash comes from
   * the SessionEvent's `images[].hash`. Requires JWT (or pairing token when
   * no password is set).
   */
  app.get<{ Params: { hash: string } }>("/api/attachment/:hash", async (req, reply) => {
    const token = extractToken(req.query as any, req.headers.authorization);
    if (!requireToken(token)) {
      reply.code(401);
      return { error: "unauthorized" };
    }
    const { hash } = req.params;
    // Defensive: only allow alphanumeric (our hashes are hex).
    if (!/^[a-f0-9]{8,64}$/i.test(hash)) {
      reply.code(400);
      return { error: "bad_hash" };
    }
    const entry = attachmentStore.get(hash);
    if (!entry) {
      reply.code(404);
      return { error: "not_found" };
    }
    reply.header("content-type", entry.mediaType);
    // Long cache since the hash is content-addressed and immutable.
    reply.header("cache-control", "private, max-age=2592000, immutable");
    reply.header("content-length", entry.sizeBytes);
    return reply.send(entry.buffer);
  });

  /**
   * Per-session metadata: where the transcript lives, file size, event count,
   * etc. Used by the (i) info modal in the SessionDetail screen.
   */
  app.get<{ Params: { id: string } }>("/api/session/:id/info", async (req, reply) => {
    const token = extractToken(req.query as any, req.headers.authorization);
    if (!requireToken(token)) {
      reply.code(401);
      return { error: "unauthorized" };
    }
    const session = opts.registry.get(req.params.id);
    if (!session) {
      reply.code(404);
      return { error: "not_found" };
    }
    const filePath = opts.registry.filePathOf(req.params.id);
    // For real on-disk files, surface the size (helps the user judge if it's
    // a "big" transcript). Synthetic paths (cursor:<id>) just return null.
    let fileSize: number | null = null;
    let exists = false;
    if (filePath && !filePath.startsWith("cursor:")) {
      try {
        const stat = await import("node:fs").then((m) => m.promises.stat(filePath));
        fileSize = stat.size;
        exists = true;
      } catch {
        exists = false;
      }
    }
    return {
      sessionId: session.id,
      source: session.source,
      filePath: filePath ?? null,
      fileExists: exists,
      fileSize,
      projectPath: session.projectPath,
      projectLabel: session.projectLabel,
      gitBranch: session.gitBranch ?? null,
      eventCount: session.eventCount,
      lastEventAt: session.lastEventAt,
      lastUserMessageAt: session.lastUserMessageAt,
      status: session.status,
      aiTitle: session.aiTitle ?? null,
      customTitle: session.customTitle ?? null,
      isSubagent: session.isSubagent,
      parentSessionId: session.parentSessionId ?? null,
    };
  });

  app.get("/api/session/:id/history", async (req, reply) => {
    const token = extractToken(req.query as any, req.headers.authorization);
    if (!requireToken(token)) {
      reply.code(401);
      return { error: "unauthorized" };
    }
    const { id } = req.params as { id: string };
    return { events: opts.registry.history(id) };
  });

  // SPA fallback — serve index.html for unknown routes so client routing works.
  app.setNotFoundHandler(async (req, reply) => {
    const indexPath = path.join(opts.webRoot, "index.html");
    if (existsSync(indexPath) && (req.url || "").startsWith("/api") === false) {
      return reply.type("text/html").sendFile("index.html");
    }
    reply.code(404).send({ error: "not found" });
  });

  // --- WebSocket ---

  const clients = new Set<WebSocket>();

  app.get("/ws", { websocket: true }, (socket, req) => {
    const token = extractToken(req.query as any, req.headers.authorization);
    if (!requireToken(token)) {
      socket.send(JSON.stringify({ kind: "error", message: "unauthorized" } satisfies Frame));
      socket.close(4001, "unauthorized");
      return;
    }
    clients.add(socket);

    const hello: Frame = {
      kind: "hello",
      agentVersion: opts.agentVersion,
      hostname: opts.config.hostLabel,
      platform: process.platform,
      ts: Date.now(),
    };
    socket.send(JSON.stringify(hello));

    const list: Frame = {
      kind: "session_list",
      sessions: opts.registry.list(),
      ts: Date.now(),
    };
    socket.send(JSON.stringify(list));

    const heartbeat = setInterval(() => {
      try {
        socket.send(JSON.stringify({ kind: "heartbeat", ts: Date.now() } satisfies Frame));
      } catch {}
    }, 15_000);
    heartbeat.unref();

    // Track which sessions this client has open so we can unsubscribe on disconnect.
    const mySubscriptions = new Set<string>();

    socket.on("message", (raw: Buffer | string) => {
      let frame: Frame;
      try {
        frame = JSON.parse(raw.toString()) as Frame;
      } catch {
        return;
      }
      if (frame.kind === "request_history") {
        const sessionId = frame.sessionId;
        // Mark subscribed → enables event buffering in the registry.
        opts.registry.subscribe(sessionId);
        mySubscriptions.add(sessionId);
        // If the ring buffer is empty, kick off a full backfill from disk.
        const existing = opts.registry.history(sessionId, frame.limit ?? 500);
        if (existing.length > 0) {
          const response: Frame = { kind: "session_events", sessionId, events: existing, replay: true };
          socket.send(JSON.stringify(response));
        } else {
          // Backfill async — events will come via session_event broadcasts.
          opts.providers.backfillSession(sessionId).then(() => {
            const events = opts.registry.history(sessionId, frame.limit ?? 500);
            const response: Frame = { kind: "session_events", sessionId, events, replay: true };
            socket.send(JSON.stringify(response));
          });
        }
      } else if (frame.kind === "subscribe") {
        for (const id of frame.sessionIds) {
          opts.registry.subscribe(id);
          mySubscriptions.add(id);
        }
      } else if (frame.kind === "unsubscribe") {
        for (const id of frame.sessionIds) {
          opts.registry.unsubscribe(id);
          mySubscriptions.delete(id);
        }
      } else if (frame.kind === "heartbeat") {
        // echo
      }
    });

    socket.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(socket);
      // Unsubscribe all sessions this client had open.
      for (const id of mySubscriptions) opts.registry.unsubscribe(id);
      mySubscriptions.clear();
    });
    socket.on("error", () => {
      clearInterval(heartbeat);
      clients.delete(socket);
      for (const id of mySubscriptions) opts.registry.unsubscribe(id);
      mySubscriptions.clear();
    });
  });

  // Bridge registry events to all clients (broadcast model: tiny payloads).
  opts.registry.on("upsert", (session: Session) => broadcast(clients, { kind: "session_upsert", session }));
  opts.registry.on("event", (event: SessionEvent) => broadcast(clients, { kind: "session_event", event }));
  opts.registry.on("remove", (sessionId: string) => broadcast(clients, { kind: "session_remove", sessionId }));

  await app.listen({ port: opts.port, host: opts.host });
  return app;
}

function broadcast(clients: Set<WebSocket>, frame: Frame): void {
  const payload = JSON.stringify(frame);
  for (const sock of clients) {
    if (sock.readyState === 1) {
      try {
        sock.send(payload);
      } catch {}
    }
  }
}

function extractToken(query: Record<string, string> | undefined, auth: string | undefined): string | undefined {
  if (query && typeof query.token === "string" && query.token.length > 0) return query.token;
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7);
  return undefined;
}
