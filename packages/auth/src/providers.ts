/**
 * Stub adapters for the providers LedgerLands will eventually support.
 *
 * They exist so the composition, policy, and step-up code paths are exercised
 * end to end without contacting any external service. None of them can
 * actually authenticate anyone: they are deliberately inert and must be
 * replaced with real integrations.
 */

import { randomUUID } from "node:crypto";
import type { AuthAdapter, AuthPrincipal, AuthProvider, Role } from "./core.js";

export class NotConfiguredAdapter implements AuthAdapter {
  constructor(
    readonly provider: AuthProvider,
    private readonly reason: string,
  ) {}

  verifyToken(): AuthPrincipal | null {
    // Inert on purpose: an unconfigured provider must never authenticate.
    void this.reason;
    return null;
  }
}

export class MockFederatedAdapter implements AuthAdapter {
  readonly sessions = new Map<string, AuthPrincipal>();

  constructor(
    readonly provider: Extract<AuthProvider, "google" | "apple" | "aetherius" | "email">,
    private readonly ttlMs = 3_600_000,
  ) {}

  /** Test-only issuance path standing in for a real provider callback. */
  issue(displayName: string, nowMs = Date.now()): { principal: AuthPrincipal; token: string } {
    const token = `mock-${randomUUID()}`;
    const principal: AuthPrincipal = {
      principalId: randomUUID(),
      playerId: `${this.provider}-${randomUUID()}`,
      sessionId: randomUUID(),
      displayName,
      roles: ["player"] as Role[],
      provider: this.provider,
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + this.ttlMs).toISOString(),
    };
    this.sessions.set(token, principal);
    return { principal, token };
  }

  verifyToken(token: string, nowMs = Date.now()): AuthPrincipal | null {
    const p = this.sessions.get(token);
    if (!p) return null;
    if (Date.parse(p.expiresAt) <= nowMs) return null;
    return p;
  }
}

export class MockWalletAdapter implements AuthAdapter {
  readonly signatures = new Map<string, AuthPrincipal>();

  constructor(private readonly ttlMs = 3_600_000) {}

  /** Stands in for a signed wallet challenge-response. */
  completeChallenge(address: string, displayName: string, nowMs = Date.now()): { principal: AuthPrincipal; token: string } {
    const token = `wallet-${address}-${randomUUID()}`;
    const principal: AuthPrincipal = {
      principalId: randomUUID(),
      // Address normalisation is a real concern; lowercase is a placeholder for
      // EIP-55 checksum validation.
      playerId: `wallet-${address.toLowerCase()}`,
      sessionId: randomUUID(),
      displayName,
      roles: ["player"],
      provider: "wallet",
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + this.ttlMs).toISOString(),
    };
    this.signatures.set(token, principal);
    return { principal, token };
  }

  readonly provider: AuthProvider = "wallet";

  verifyToken(token: string, nowMs = Date.now()): AuthPrincipal | null {
    const p = this.signatures.get(token);
    if (!p) return null;
    if (Date.parse(p.expiresAt) <= nowMs) return null;
    return p;
  }
}

export class MockPasskeyAdapter implements AuthAdapter {
  readonly provider: AuthProvider = "passkey";
  private readonly assertions = new Map<string, AuthPrincipal>();

  /** Stands in for a WebAuthn assertion; no challenge ceremony here. */
  completeAssertion(credentialId: string, displayName: string, nowMs = Date.now()): { principal: AuthPrincipal; token: string } {
    const token = `passkey-${credentialId}-${randomUUID()}`;
    const principal: AuthPrincipal = {
      principalId: randomUUID(),
      playerId: `passkey-${credentialId}`,
      sessionId: randomUUID(),
      displayName,
      roles: ["player"],
      provider: "passkey",
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 3_600_000).toISOString(),
    };
    this.assertions.set(token, principal);
    return { principal, token };
  }

  verifyToken(token: string, nowMs = Date.now()): AuthPrincipal | null {
    const p = this.assertions.get(token);
    if (!p) return null;
    if (Date.parse(p.expiresAt) <= nowMs) return null;
    return p;
  }
}
