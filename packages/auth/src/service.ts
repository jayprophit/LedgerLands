import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { DevAuthAdapter, type AuthAdapter, type AuthPrincipal, type Role } from "./core.js";

/**
 * Auth composition, MFA/second-factor boundary, and production safeguards.
 *
 * The goal here is architecture, not integrations: no external identity
 * provider is contacted. Each provider is a pluggable adapter behind one
 * interface, and a `DevAuthAdapter` is only ever usable when the guard below
 * explicitly allows it.
 */

export type { AuthPrincipal, Role };
export type { AuthAdapter, AuthProvider } from "./core.js";

// ---- Second factor ----

export type MfaMethod = "totp" | "webauthn" | "sms" | "backup-code";

export interface MfaEnrollment {
  id: string;
  principalId: string;
  method: MfaMethod;
  /** Never store a raw shared secret; this is a display/label placeholder. */
  label: string;
  enrolledAt: string;
  /** Only backup codes are single-use; the others are not. */
  singleUse: boolean;
}

export interface AuthPolicy {
  /** Providers that may be used as a primary factor. */
  allowedProviders: AuthAdapter["provider"][];
  /** Privileged operations require a second factor. */
  requireMfaFor: string[];
  /** Hard switch: when true, the dev adapter refuses to issue sessions. */
  production: boolean;
  sessionTtlMs: number;
}

export const DEFAULT_AUTH_POLICY: AuthPolicy = {
  allowedProviders: ["dev"],
  requireMfaFor: ["withdraw", "change-payout-wallet", "disable-mfa", "account-recovery", "high-value-trade"],
  production: false,
  sessionTtlMs: 12 * 60 * 60 * 1000,
};

export class AuthPolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "AuthPolicyError";
    this.code = code;
  }
}

/**
 * The production guard. The single most important safeguard in this package:
 * a misconfigured deployment must fail loudly rather than quietly accept
 * passwordless dev sessions.
 */
export class ProductionGuard {
  constructor(private policy: AuthPolicy = DEFAULT_AUTH_POLICY) {}

  getPolicy(): AuthPolicy {
    return this.policy;
  }

  configure(patch: Partial<AuthPolicy>): void {
    this.policy = { ...this.policy, ...patch };
  }

  /** Throw if a development adapter is reachable in a production profile. */
  assertNoDevAuth(adapters: AuthAdapter[]): void {
    if (!this.policy.production) return;
    const live = adapters.filter((a) => a.provider === "dev");
    if (live.length > 0) {
      throw new AuthPolicyError(
        "DEV_AUTH_IN_PRODUCTION",
        `${live.length} development auth adapter(s) configured while policy.production=true.`,
      );
    }
    if (!this.policy.allowedProviders.some((p) => p !== "dev")) {
      throw new AuthPolicyError(
        "NO_PRODUCTION_PROVIDER",
        "policy.production=true but no non-development provider is allowed.",
      );
    }
  }

  assertProviderAllowed(provider: AuthAdapter["provider"]): void {
    if (!this.policy.allowedProviders.includes(provider)) {
      throw new AuthPolicyError("PROVIDER_NOT_ALLOWED", `Provider ${provider} is not allowed by policy.`);
    }
    if (this.policy.production && provider === "dev") {
      throw new AuthPolicyError("DEV_AUTH_IN_PRODUCTION", "Dev auth cannot be used in a production profile.");
    }
  }
}

// ---- MFA store ----

export class MfaService {
  private readonly enrollments = new Map<string, MfaEnrollment>();
  private readonly usedBackupCodes = new Set<string>();

  enroll(principalId: string, method: MfaMethod, label: string, nowMs = Date.now()): MfaEnrollment {
    const e: MfaEnrollment = {
      id: randomUUID(),
      principalId,
      method,
      label,
      enrolledAt: new Date(nowMs).toISOString(),
      singleUse: method === "backup-code",
    };
    this.enrollments.set(e.id, e);
    return { ...e };
  }

  listFor(principalId: string): MfaEnrollment[] {
    return [...this.enrollments.values()].filter((e) => e.principalId === principalId).map((e) => ({ ...e }));
  }

  hasFactor(principalId: string): boolean {
    return this.listFor(principalId).length > 0;
  }

  revoke(id: string): boolean {
    return this.enrollments.delete(id);
  }

  /** A backup code may be spent exactly once. */
  consumeBackupCode(code: string): boolean {
    const key = hashCode(code);
    if (this.usedBackupCodes.has(key)) return false;
    this.usedBackupCodes.add(key);
    return true;
  }
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

// ---- Session composition ----

export interface SessionRecord {
  sessionId: string;
  principalId: string;
  playerId: string;
  provider: AuthPrincipal["provider"];
  mfaSatisfied: boolean;
  issuedAt: string;
  expiresAt: string;
  /** Monotonic counter; a replayed token with an older counter is rejected. */
  counter: number;
}

export class AuthService {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly counters = new Map<string, number>();
  private readonly revoked = new Set<string>();

  constructor(
    private readonly adapters: AuthAdapter[],
    private readonly guard = new ProductionGuard(),
    private readonly mfa = new MfaService(),
  ) {}

  /** Issue a session from the first allowed adapter that accepts the token. */
  establish(token: string, nowMs = Date.now()): SessionRecord {
    for (const adapter of this.adapters) {
      // Providers absent from the policy are skipped, not fatal: adding a
      // future provider must not break unrelated logins.
      if (!this.guard.getPolicy().allowedProviders.includes(adapter.provider)) continue;
      this.guard.assertProviderAllowed(adapter.provider);
      const principal = adapter.verifyToken(token, nowMs);
      if (!principal) continue;
      const counter = (this.counters.get(principal.sessionId) ?? 0) + 1;
      this.counters.set(principal.sessionId, counter);
      const record: SessionRecord = {
        sessionId: principal.sessionId,
        principalId: principal.principalId,
        playerId: principal.playerId,
        provider: principal.provider,
        mfaSatisfied: false,
        issuedAt: principal.issuedAt,
        expiresAt: principal.expiresAt,
        counter,
      };
      this.sessions.set(record.sessionId, record);
      return { ...record };
    }
    throw new AuthPolicyError("NO_SESSION", "No configured provider accepted the token.");
  }

  /** Resolve a live session, rejecting revoked, expired, or stale-counter tokens. */
  resolve(sessionId: string, counter: number, nowMs = Date.now()): SessionRecord | null {
    if (this.revoked.has(sessionId)) return null;
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    if (Date.parse(s.expiresAt) <= nowMs) return null;
    if (s.counter !== counter) return null; // anti-replay
    return { ...s };
  }

  revokeSession(sessionId: string): boolean {
    this.revoked.add(sessionId);
    return this.sessions.delete(sessionId);
  }

  /** Mark MFA satisfied for a session. */
  satisfyMfa(sessionId: string): SessionRecord {
    const s = this.sessions.get(sessionId);
    if (!s) throw new AuthPolicyError("NO_SESSION", "Unknown session.");
    s.mfaSatisfied = true;
    return { ...s };
  }

  /**
   * Step-up gate for a privileged operation.
   *
   * Dev sessions can NEVER satisfy this: they have no second factor, so
   * enabling a dev session must not unlock withdrawals or account recovery.
   */
  assertAuthorized(session: SessionRecord, operation: string): void {
    if (this.guard.getPolicy().requireMfaFor.includes(operation)) {
      if (session.provider === "dev") {
        throw new AuthPolicyError(
          "STEP_UP_UNAVAILABLE",
          `${operation} requires a production second factor; a dev session cannot authorize it.`,
        );
      }
      if (!session.mfaSatisfied) {
        throw new AuthPolicyError("STEP_UP_REQUIRED", `${operation} requires a second factor.`);
      }
    }
  }

  hasRole(session: SessionRecord, role: Role): boolean {
    return role === "player" || session.provider !== "dev";
  }

  guardRef(): ProductionGuard {
    return this.guard;
  }

  mfaRef(): MfaService {
    return this.mfa;
  }
}

export { DevAuthAdapter };
export type { AuthAdapter as AuthAdapterType };

/** Constant-time string compare, exported for adapters that need it. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
