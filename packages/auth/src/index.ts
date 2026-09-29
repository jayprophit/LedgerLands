import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Identity model + development authentication.
 *
 * DEV ONLY: DevAuthAdapter mints local sessions for development. It is NOT
 * production authentication (no password, no MFA, no KYC). Production must
 * implement the AuthAdapter interface with OIDC/wallet/passkey providers.
 */

export type AuthProvider = "dev" | "email" | "google" | "apple" | "wallet" | "passkey" | "aetherius";
export type Role = "player" | "moderator" | "admin";

export interface AuthPrincipal {
  principalId: string;
  /** Stable in-game identity. Game commands authorize against this, never raw browser input. */
  playerId: string;
  sessionId: string;
  displayName: string;
  roles: Role[];
  provider: AuthProvider;
  issuedAt: string;
  expiresAt: string;
}

export interface AuthAdapter {
  readonly provider: AuthProvider;
  verifyToken(token: string, nowMs?: number): AuthPrincipal | null;
}

export class AuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

export interface DevSession extends AuthPrincipal {
  revoked: boolean;
}

const TOKEN_PREFIX = "lld1";

/**
 * HMAC-signed opaque dev sessions. Secret defaults to a random per-process
 * value (sessions die with the process); set LEDGERLANDS_DEV_SECRET for
 * stable dev sessions across restarts. NEVER use in production.
 */
export class DevAuthAdapter implements AuthAdapter {
  readonly provider: AuthProvider = "dev";
  private readonly sessions = new Map<string, DevSession>();
  private readonly secret: string;
  private readonly ttlMs: number;

  constructor(opts?: { secret?: string; ttlMs?: number }) {
    this.secret = opts?.secret ?? randomUUID();
    this.ttlMs = opts?.ttlMs ?? 12 * 60 * 60 * 1000;
  }

  loginDev(displayName: string, nowMs = Date.now()): { principal: AuthPrincipal; token: string } {
    const name = displayName.trim();
    if (!name) throw new AuthError("INVALID_NAME", "displayName is required.");
    if (name.length > 40) throw new AuthError("INVALID_NAME", "displayName too long.");
    const now = new Date(nowMs).toISOString();
    const session: DevSession = {
      principalId: randomUUID(),
      playerId: `dev-${randomUUID()}`,
      sessionId: randomUUID(),
      displayName: name,
      roles: ["player"],
      provider: "dev",
      issuedAt: now,
      expiresAt: new Date(nowMs + this.ttlMs).toISOString(),
      revoked: false,
    };
    this.sessions.set(session.sessionId, session);
    return { principal: publicPrincipal(session), token: this.sign(session.sessionId) };
  }

  verifyToken(token: string, nowMs = Date.now()): AuthPrincipal | null {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
    const [, sessionId, sig] = parts as [string, string, string];
    if (!this.checkSig(sessionId!, sig!)) return null;
    const session = this.sessions.get(sessionId!);
    if (!session || session.revoked) return null;
    if (Date.parse(session.expiresAt) <= nowMs) return null;
    return publicPrincipal(session);
  }

  revoke(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.revoked = true;
    return true;
  }

  /** Step-up guard example: dev sessions can never satisfy privileged operations. */
  assertStepUp(principal: AuthPrincipal, operation: string): void {
    if (principal.provider === "dev") {
      throw new AuthError("STEP_UP_REQUIRED", `${operation} requires production MFA/passkey authentication, not a dev session.`);
    }
  }

  private sign(sessionId: string): string {
    const sig = createHmac("sha256", this.secret).update(`${TOKEN_PREFIX}.${sessionId}`).digest("hex");
    return `${TOKEN_PREFIX}.${sessionId}.${sig}`;
  }

  private checkSig(sessionId: string, sig: string): boolean {
    const expected = createHmac("sha256", this.secret).update(`${TOKEN_PREFIX}.${sessionId}`).digest("hex");
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

function publicPrincipal(session: DevSession): AuthPrincipal {
  const { revoked: _revoked, ...principal } = session;
  void _revoked;
  return principal;
}
