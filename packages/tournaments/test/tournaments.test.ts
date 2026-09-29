import { describe, expect, it } from "vitest";
import { DoubleEntryLedger } from "@ledgerlands/ledger";
import { TournamentService } from "../src/index.js";

function fourPlayer(fee = 1000) {
  const svc = new TournamentService(new DoubleEntryLedger());
  // Fund players so entry fees can be paid from PLAYER_AVAILABLE.
  const ledger = (svc as unknown as { ledger: DoubleEntryLedger }).ledger;
  for (const u of ["u1", "u2", "u3", "u4"]) {
    ledger.post({
      playerId: u,
      amount: 1000,
      debitAccount: "MATCH_BANK",
      creditAccount: "PLAYER_AVAILABLE",
      type: "deposit",
      idempotencyKey: `fund-${u}`,
    });
  }
  const t = svc.create({ name: "Friday Cup", entryFee: fee, maxPlayers: 4 });
  svc.openRegistration(t.id);
  for (const u of ["u1", "u2", "u3", "u4"]) svc.register(t.id, u);
  svc.lock(t.id);
  svc.start(t.id);
  return svc;
}

describe("tournaments", () => {
  it("runs a 4-player single elimination to a settled champion", () => {
    const svc = fourPlayer();
    const id = svc.list()[0]!.id;
    const locked = svc.get(id)!;
    expect(locked.bracket).toHaveLength(3);
    const semis = locked.bracket.filter((b) => b.round === 1);
    let t = svc.reportResult(id, semis[0]!.id, "u1");
    t = svc.reportResult(id, semis[1]!.id, "u3");
    const final = t.bracket.find((b) => b.round === 2)!;
    expect(final.seedA).toBe("u1");
    expect(final.seedB).toBe("u3");
    t = svc.reportResult(id, final.id, "u1");
    expect(t.status).toBe("COMPLETED");
    expect(t.championId).toBe("u1");
    // Pool 4000 → champion 2800, runner-up 1200.
    const ledger = (svc as unknown as { ledger: DoubleEntryLedger }).ledger;
    expect(ledger.balanceOf("PLAYER_AVAILABLE", "u1")).toBe(2800);
    expect(ledger.balanceOf("PLAYER_AVAILABLE", "u3")).toBe(1200);
    expect(ledger.verifyInvariant().balanced).toBe(true);
  });

  it("rejects double-reporting and bad transitions", () => {
    const svc = fourPlayer(0);
    const id = svc.list()[0]!.id;
    const semi = svc.get(id)!.bracket[0]!;
    svc.reportResult(id, semi.id, semi.seedA!);
    expect(() => svc.reportResult(id, semi.id, semi.seedA!)).toThrow();
    expect(() => svc.start(id)).toThrow();
  });

  it("supports odd entry counts via byes and refunds on cancel", () => {
    const svc = new TournamentService(new DoubleEntryLedger());
    const ledger = (svc as unknown as { ledger: DoubleEntryLedger }).ledger;
    for (const u of ["a", "b", "c"]) {
      ledger.post({
        playerId: u,
        amount: 500,
        debitAccount: "MATCH_BANK",
        creditAccount: "PLAYER_AVAILABLE",
        type: "deposit",
        idempotencyKey: `fund-${u}`,
      });
    }
    const t = svc.create({ name: "Odd Cup", entryFee: 500 });
    svc.openRegistration(t.id);
    svc.register(t.id, "a");
    svc.register(t.id, "b");
    svc.register(t.id, "c");
    // Non-power-of-two is allowed: one round-1 match plus one bye.
    const locked = svc.lock(t.id);
    const round1 = locked.bracket.filter((m) => m.round === 1);
    expect(round1).toHaveLength(2);
    expect(round1.filter((m) => m.bye)).toHaveLength(1);
    const cancelled = svc.cancel(t.id);
    expect(cancelled.status).toBe("REFUNDED");
    expect(ledger.balanceOf("PLAYER_AVAILABLE", "a")).toBe(500);
  });

  it("rejects locking with fewer than two entries", () => {
    const svc = new TournamentService(new DoubleEntryLedger());
    const t = svc.create({ name: "Solo Cup" });
    svc.openRegistration(t.id);
    svc.register(t.id, "only");
    expect(() => svc.lock(t.id)).toThrow(/NOT_ENOUGH_PLAYERS/);
  });
});
