import { describe, expect, it } from "vitest";
import {
  AuthPolicyError,
  AuthService,
  DevAuthAdapter,
  MfaService,
  MockFederatedAdapter,
  MockPasskeyAdapter,
  MockWalletAdapter,
  NotConfiguredAdapter,
  ProductionGuard,
  DEFAULT_AUTH_POLICY,
} from "../src/index.js";

const T0 = 1_700_000_000_000;

describe("dev auth adapter", () => {
  it("issues a verifiable session bound to a stable playerId", () => {
    const auth = new DevAuthAdapter({ secret: "s" });
    const { principal, token } = auth.loginDev("Tester", T0);
    expect(principal.provider).toBe("dev");
    expect(token.startsWith("lld1.")).toBe(true);
    expect(auth.verifyToken(token, T0 + 10)?.playerId).toBe(principal.playerId);
  });

  it("rejects tampered, expired, and revoked tokens", () => {
    const auth = new DevAuthAdapter({ secret: "s", ttlMs: 1000 });
    const { token } = auth.loginDev("Tester", T0);
    expect(auth.verifyToken(`${token}x`, T0 + 10)).toBeNull();
    expect(auth.verifyToken("garbage", T0 + 10)).toBeNull();
    expect(auth.verifyToken(token, T0 + 1001)).toBeNull();
    expect(auth.revoke(token.split(".")[1]!)).toBe(true);
    expect(auth.verifyToken(token, T0 + 10)).toBeNull();
  });
});

describe("provider adapters", () => {
  it("unconfigured providers never authenticate", () => {
    const a = new NotConfiguredAdapter("google", "no client id");
    expect(a.verifyToken("anything")).toBeNull();
  });

  it("mock federated, wallet, and passkey adapters issue and verify", () => {
    const google = new MockFederatedAdapter("google");
    const { token } = google.issue("G", T0);
    expect(google.verifyToken(token, T0 + 10)?.provider).toBe("google");

    const wallet = new MockWalletAdapter();
    const w = wallet.completeChallenge("0xAbC", "W", T0);
    expect(w.principal.playerId).toBe("wallet-0xabc"); // normalised
    expect(wallet.verifyToken(w.token, T0 + 10)).toBeTruthy();

    const passkey = new MockPasskeyAdapter();
    const p = passkey.completeAssertion("cred-1", "P", T0);
    expect(passkey.verifyToken(p.token, T0 + 10)?.playerId).toBe("passkey-cred-1");
  });
});

describe("production guard", () => {
  it("allows dev auth only outside production", () => {
    const guard = new ProductionGuard();
    const dev = new DevAuthAdapter({ secret: "s" });
    expect(() => guard.assertNoDevAuth([dev])).not.toThrow();
    expect(() => guard.assertProviderAllowed("dev")).not.toThrow();
  });

  it("refuses a dev adapter in a production profile", () => {
    const guard = new ProductionGuard({ ...DEFAULT_AUTH_POLICY, production: true });
    const dev = new DevAuthAdapter({ secret: "s" });
    expect(() => guard.assertNoDevAuth([dev])).toThrow(AuthPolicyError);
    expect(() => guard.assertProviderAllowed("dev")).toThrow(/DEV_AUTH_IN_PRODUCTION/);
  });

  it("refuses a production profile with no real provider", () => {
    const guard = new ProductionGuard({ ...DEFAULT_AUTH_POLICY, production: true });
    const google = new MockFederatedAdapter("google");
    expect(() => guard.assertNoDevAuth([google])).toThrow(/NO_PRODUCTION_PROVIDER/);
  });

  it("accepts a production profile with a real provider configured", () => {
    const guard = new ProductionGuard({ ...DEFAULT_AUTH_POLICY, production: true, allowedProviders: ["google"] });
    const google = new MockFederatedAdapter("google");
    expect(() => guard.assertNoDevAuth([google])).not.toThrow();
  });
});

describe("auth service", () => {
  it("establishes a session from the first accepting provider", () => {
    const dev = new DevAuthAdapter({ secret: "s" });
    const svc = new AuthService([new NotConfiguredAdapter("google", "x"), dev]);
    const { token } = dev.loginDev("P", T0);
    const session = svc.establish(token, T0 + 10);
    expect(session.provider).toBe("dev");
    expect(session.mfaSatisfied).toBe(false);
    expect(session.counter).toBe(1);
  });

  it("rejects a token no provider accepts", () => {
    const svc = new AuthService([new DevAuthAdapter({ secret: "s" })]);
    expect(() => svc.establish("nope", T0)).toThrow(/NO_SESSION/);
  });

  it("rejects revoked, expired, and replayed sessions", () => {
    const dev = new DevAuthAdapter({ secret: "s", ttlMs: 1000 });
    const svc = new AuthService([dev]);
    const { token } = dev.loginDev("P", T0);
    const s = svc.establish(token, T0 + 10);
    expect(svc.resolve(s.sessionId, s.counter, T0 + 20)).toBeTruthy();
    expect(svc.resolve(s.sessionId, s.counter, T0 + 2000)).toBeNull(); // expired
    // Replay: an older counter is rejected.
    expect(svc.resolve(s.sessionId, s.counter + 1, T0 + 20)).toBeNull();
    expect(svc.revokeSession(s.sessionId)).toBe(true);
    expect(svc.resolve(s.sessionId, s.counter, T0 + 30)).toBeNull();
  });

  it("increments the counter per establishment, blocking replay of a prior token", () => {
    const dev = new DevAuthAdapter({ secret: "s" });
    const svc = new AuthService([dev]);
    const { token } = dev.loginDev("P", T0);
    const first = svc.establish(token, T0 + 10);
    const second = svc.establish(token, T0 + 20);
    expect(second.counter).toBe(first.counter + 1);
    // The first token is now stale.
    expect(svc.resolve(first.sessionId, first.counter, T0 + 30)).toBeNull();
    expect(svc.resolve(second.sessionId, second.counter, T0 + 30)).toBeTruthy();
  });

  it("never lets a dev session satisfy step-up", () => {
    const dev = new DevAuthAdapter({ secret: "s" });
    const svc = new AuthService([dev]);
    const { token } = dev.loginDev("P", T0);
    const s = svc.establish(token, T0);
    svc.satisfyMfa(s.sessionId);
    expect(() => svc.assertAuthorized(svc.resolve(s.sessionId, s.counter, T0)!, "withdraw")).toThrow(
      /STEP_UP_UNAVAILABLE/,
    );
  });

  it("requires MFA for a real provider on a privileged operation", () => {
    const google = new MockFederatedAdapter("google");
    const guard = new ProductionGuard({ ...DEFAULT_AUTH_POLICY, allowedProviders: ["google"] });
    const svc = new AuthService([google], guard);
    const { token } = google.issue("G", T0);
    const s = svc.establish(token, T0 + 10);
    expect(() => svc.assertAuthorized(s, "withdraw")).toThrow(/STEP_UP_REQUIRED/);
    svc.satisfyMfa(s.sessionId);
    expect(() => svc.assertAuthorized(svc.resolve(s.sessionId, s.counter, T0)!, "withdraw")).not.toThrow();
  });

  it("does not gate ordinary operations behind MFA", () => {
    const dev = new DevAuthAdapter({ secret: "s" });
    const svc = new AuthService([dev]);
    const { token } = dev.loginDev("P", T0);
    const s = svc.establish(token, T0);
    expect(() => svc.assertAuthorized(s, "play-match")).not.toThrow();
  });
});

describe("MFA service", () => {
  it("tracks enrolled factors and single-use backup codes", () => {
    const mfa = new MfaService();
    mfa.enroll("p1", "totp", "Authenticator", T0);
    mfa.enroll("p1", "backup-code", "Backup", T0);
    expect(mfa.hasFactor("p1")).toBe(true);
    expect(mfa.listFor("p1")).toHaveLength(2);
    expect(mfa.consumeBackupCode("123456")).toBe(true);
    expect(mfa.consumeBackupCode("123456")).toBe(false); // single use
    expect(mfa.consumeBackupCode("654321")).toBe(true);
    const e = mfa.listFor("p1")[0]!;
    expect(mfa.revoke(e.id)).toBe(true);
    expect(mfa.revoke("nope")).toBe(false);
  });
});
