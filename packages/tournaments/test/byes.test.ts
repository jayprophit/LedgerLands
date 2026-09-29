import { describe, expect, it } from "vitest";
import { DoubleEntryLedger } from "@ledgerlands/ledger";
import { TournamentService } from "../src/index.js";

function service() {
  const ledger = new DoubleEntryLedger();
  return { ledger, svc: new TournamentService(ledger) };
}

function run(count: number, entryFee = 0) {
  const { ledger, svc } = service();
  const players = Array.from({ length: count }, (_, i) => `p${i + 1}`);
  for (const p of players) {
    ledger.post({
      playerId: p,
      amount: 1000,
      debitAccount: "MATCH_BANK",
      creditAccount: "PLAYER_AVAILABLE",
      type: "deposit",
      idempotencyKey: `fund-${p}`,
    });
  }
  const t = svc.create({ name: `Cup ${count}`, entryFee, maxPlayers: 16 });
  svc.openRegistration(t.id);
  for (const p of players) svc.register(t.id, p);
  svc.lock(t.id);
  svc.start(t.id);
  return { svc, ledger, id: t.id, players };
}

/** Play every playable match (round ascending) until the tournament completes. */
function playOut(svc: TournamentService, id: string): string | undefined {
  for (let guard = 0; guard < 64; guard += 1) {
    const t = svc.get(id);
    if (!t) throw new Error("missing");
    if (t.status === "COMPLETED") return t.championId;
    const playable = t.bracket
      .filter((b) => !b.bye && !b.winnerId && b.seedA && b.seedB)
      .sort((x, y) => x.round - y.round);
    if (playable.length === 0) throw new Error(`stuck: status=${t.status} bracket=${JSON.stringify(t.bracket)}`);
    for (const m of playable) {
      svc.reportResult(id, m.id, m.seedA!);
    }
  }
  return undefined;
}

describe("tournament byes", () => {
  for (const count of [2, 3, 4, 5, 6, 7, 8, 9, 16]) {
    it(`completes a ${count}-player bracket with a single champion`, () => {
      const { svc, id, players } = run(count);
      const locked = svc.get(id)!;
      const expectedSize = 2 ** Math.ceil(Math.log2(count));
      const expectedByes = expectedSize - count;
      const round1 = locked.bracket.filter((b) => b.round === 1);
      expect(round1).toHaveLength(expectedSize / 2);
      const byes = round1.filter((b) => b.bye);
      expect(byes).toHaveLength(expectedByes);
      // No phantom participants: every seed is a real registrant.
      const seeds = locked.bracket.flatMap((b) => [b.seedA, b.seedB]).filter((s): s is string => Boolean(s));
      for (const s of seeds) expect(players).toContain(s);
      expect(new Set(seeds).size).toBe(count);
      // Every round-1 bye already advanced into its target slot.
      for (const m of byes) {
        const target = locked.bracket.find((b) => b.id === m.targetMatchId)!;
        expect([target.seedA, target.seedB]).toContain(m.winnerId);
      }
      const champion = playOut(svc, id);
      expect(champion).toBeTruthy();
      expect(players).toContain(champion!);
      expect(svc.get(id)!.status).toBe("COMPLETED");
    });
  }

  it("pays exactly two prizes with no phantom payouts on a 3-player event", () => {
    const { svc, ledger, id } = run(3, 1000);
    playOut(svc, id);
    const t = svc.get(id)!;
    expect(t.championId).toBeTruthy();
    const paid = playersPaid(ledger);
    expect(paid).toHaveLength(2);
    // 3000 pool: 70/30 split, remainder to champion.
    expect(paid.reduce((sum, p) => sum + p.amount, 0)).toBe(3000);
    const champion = t.championId!;
    const championShare = paid.find((p) => p.playerId === champion)!.amount;
    expect(championShare).toBeGreaterThanOrEqual(2100);
    expect(ledger.verifyInvariant().balanced).toBe(true);
    // A losing player who never won a match still has no payout leg.
    const losers = t.entries.filter((e) => e !== champion);
    for (const l of losers) {
      const share = paid.find((p) => p.playerId === l);
      if (share) expect(share.amount).toBeLessThan(1500);
    }
  });

  it("refuses to report a result for a bye match", () => {
    const { svc, id } = run(5);
    const bye = svc.get(id)!.bracket.find((b) => b.bye)!;
    expect(() => svc.reportResult(id, bye.id, bye.winnerId!)).toThrow(/BYE_MATCH/);
  });
});

function playersPaid(ledger: DoubleEntryLedger): Array<{ playerId: string; amount: number }> {
  const totals = new Map<string, number>();
  for (const p of ledger.history()) {
    if (p.type !== "tournament" || p.idempotencyKey.includes("-entry-")) continue;
    totals.set(p.playerId!, (totals.get(p.playerId!) ?? 0) + p.amount);
  }
  return [...totals].map(([playerId, amount]) => ({ playerId, amount }));
}
