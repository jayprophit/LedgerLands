import { describe, expect, it } from "vitest";
import { DoubleEntryLedger } from "../src/index.js";

describe("double-entry ledger", () => {
  it("posts balanced legs and keeps invariant", () => {
    const ledger = new DoubleEntryLedger();
    ledger.post({
      playerId: "p1",
      amount: 15000,
      debitAccount: "MATCH_BANK",
      creditAccount: "PLAYER_AVAILABLE",
      type: "deposit",
      idempotencyKey: "dep-p1-1",
    });
    ledger.post({
      playerId: "p1",
      matchId: "m1",
      amount: 15000,
      debitAccount: "PLAYER_AVAILABLE",
      creditAccount: "PLAYER_MATCH_LOCKED",
      type: "entry_lock",
      idempotencyKey: "lock-p1-m1",
    });
    expect(ledger.verifyInvariant().balanced).toBe(true);
    expect(ledger.balanceOf("PLAYER_AVAILABLE", "p1")).toBe(0);
    expect(ledger.balanceOf("PLAYER_MATCH_LOCKED", "p1")).toBe(15000);
  });

  it("is idempotent on retry with same key", () => {
    const ledger = new DoubleEntryLedger();
    const a = ledger.post({
      playerId: "p1",
      amount: 200,
      debitAccount: "MATCH_BANK",
      creditAccount: "PLAYER_MATCH_LOCKED",
      type: "reward",
      idempotencyKey: "rew-1",
    });
    const b = ledger.post({
      playerId: "p1",
      amount: 200,
      debitAccount: "MATCH_BANK",
      creditAccount: "PLAYER_MATCH_LOCKED",
      type: "reward",
      idempotencyKey: "rew-1",
    });
    expect(a).toEqual(b);
    expect(ledger.history("p1")).toHaveLength(1);
  });

  it("rejects invalid amounts and same-account legs", () => {
    const ledger = new DoubleEntryLedger();
    expect(() =>
      ledger.post({
        amount: 0,
        debitAccount: "MATCH_BANK",
        creditAccount: "PLAYER_AVAILABLE",
        type: "adjustment",
        idempotencyKey: "bad-1",
      }),
    ).toThrow();
    expect(() =>
      ledger.post({
        amount: 10,
        debitAccount: "PLATFORM",
        creditAccount: "PLATFORM",
        type: "fee",
        idempotencyKey: "bad-2",
      }),
    ).toThrow();
  });
});
