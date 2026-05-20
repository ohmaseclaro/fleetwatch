/**
 * Authentication: optional bcrypt-hashed password + JWT issuance for ongoing
 * access. State is in-memory only — the password hash never touches disk.
 *
 * Two modes:
 *   - No password (default): /api/login with a valid pairing token issues a JWT.
 *   - Password set in env:   /api/login with a valid password issues a JWT.
 *                            (Pairing token alone is not enough.)
 *
 * The JWT is the long-lived credential the client uses for all subsequent
 * requests (WS + HTTP). 30-day expiry by default.
 */
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

interface AuthState {
  passwordHash: string | null; // null = no password configured
  jwtSecret: string;
  jwtExpiresIn: string; // e.g. "30d"
  pairingToken: string;
}

let state: AuthState | null = null;

export interface InitAuthOptions {
  /** Plaintext password from env (will be bcrypt-hashed in memory). */
  password?: string;
  /** Stable secret used to sign JWTs (auto-generated if not provided). */
  jwtSecret: string;
  /** Long-lived pairing token (matches config.token; embedded in QR URL). */
  pairingToken: string;
  /** JWT lifetime, default "30d". */
  jwtExpiresIn?: string;
}

export function initAuth(opts: InitAuthOptions): void {
  const passwordHash = opts.password
    ? bcrypt.hashSync(opts.password, 10)
    : null;
  state = {
    passwordHash,
    jwtSecret: opts.jwtSecret,
    jwtExpiresIn: opts.jwtExpiresIn ?? "30d",
    pairingToken: opts.pairingToken,
  };
}

/** Update the pairing token (e.g. after rotation) without re-initializing. */
export function setPairingToken(token: string): void {
  if (state) state.pairingToken = token;
}

/** Update the password (e.g. set/clear via Settings UI). */
export function setPassword(plaintext: string | null): void {
  if (!state) throw new Error("auth not initialized");
  state.passwordHash = plaintext ? bcrypt.hashSync(plaintext, 10) : null;
}

export function isPasswordRequired(): boolean {
  return !!state?.passwordHash;
}

export async function verifyPassword(plaintext: string): Promise<boolean> {
  if (!state?.passwordHash) return false;
  return bcrypt.compare(plaintext, state.passwordHash);
}

export function verifyPairingToken(token: string | undefined): boolean {
  if (!state || !token) return false;
  return token === state.pairingToken;
}

export interface JwtPayload {
  sub: string; // subject — "user" for now (single-user model)
  iat: number;
  exp: number;
}

export function issueJwt(subject = "user"): { token: string; expiresAt: number } {
  if (!state) throw new Error("auth not initialized");
  const token = jwt.sign({ sub: subject }, state.jwtSecret, {
    expiresIn: state.jwtExpiresIn as any,
  });
  const decoded = jwt.decode(token) as JwtPayload | null;
  return {
    token,
    expiresAt: decoded ? decoded.exp * 1000 : Date.now() + 30 * 24 * 3600_000,
  };
}

export function verifyJwt(token: string | undefined): JwtPayload | null {
  if (!state || !token) return null;
  try {
    return jwt.verify(token, state.jwtSecret) as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Unified auth check used by HTTP + WS routes.
 * Accepts a JWT (preferred) OR the pairing token (when password is not required).
 * Returns true if authorized.
 */
export function isAuthorized(token: string | undefined): boolean {
  if (!token) return false;
  if (verifyJwt(token)) return true;
  // Pairing token alone is only enough when no password is configured.
  if (!isPasswordRequired() && verifyPairingToken(token)) return true;
  return false;
}
