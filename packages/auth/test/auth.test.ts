import { describe, expect, it } from "vitest";
import { AuthService, DevAuthAdapter } from "../src/index.js";

describe("DevAuthAdapter", () => {
  it("mints a verifiable dev session bound to a stable playerId", () => {
    const auth = new DevAuthAdapter({ secret: "test-secret" });
    const { principal, token } = auth.loginDev("Tester");
    expect(principal.provider).toBe("dev");
    expect(principal.roles).toEqual(["player"]);
    expect(token.startsWith("lld1.")).toBe(true);
    const verified = auth.verifyToken(token);
    expect(verified?.playerId).toBe(principal.playerId);
    expect(verified?.displayName).toBe("Tester");
  });

  it("rejects tampered, expired, and revoked tokens", () => {
    const auth = new DevAuthAdapter({ secret: "s", ttlMs: 1000 });
    const { token } = auth.loginDev("Tester", 1_000_000);
    expect(auth.verifyToken(`${token}tampered`, 1_000_500)).toBeNull();
    expect(auth.verifyToken("garbage", 1_000_500)).toBeNull();
    expect(auth.verifyToken(token, 1_000_000 + 1001)).toBeNull();
    const sessionId = token.split(".")[1]!;
    expect(auth.revoke(sessionId)).toBe(true);
    expect(auth.verifyToken(token, 1_000_500)).toBeNull();
  });

  it("never satisfies a privileged operation on a dev session", () => {
    const dev = new DevAuthAdapter({ secret: "s" });
    const svc = new AuthService([dev]);
    const { token } = dev.loginDev("Tester", 1_000_000);
    const session = svc.establish(token, 1_000_000);
    // Even after MFA is "satisfied", a dev session must be refused.
    svc.satisfyMfa(session.sessionId);
    const live = svc.resolve(session.sessionId, session.counter, 1_000_000)!;
    try {
      svc.assertAuthorized(live, "withdraw");
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("STEP_UP_UNAVAILABLE");
    }
  });
});
