import { describe, expect, it } from "vitest";
import { DevAuthAdapter } from "../src/index.js";

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

  it("refuses step-up for privileged operations on dev sessions", () => {
    const auth = new DevAuthAdapter({ secret: "s" });
    const { principal } = auth.loginDev("Tester");
    try {
      auth.assertStepUp(principal, "withdraw");
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("STEP_UP_REQUIRED");
    }
  });
});
