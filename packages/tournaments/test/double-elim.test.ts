import { describe, expect, it } from "vitest";
import { DoubleEntryLedger } from "@ledgerlands/ledger";
import { TournamentService } from "../src/index.js";

function setup(count: number, format: "SINGLE_ELIMINATION" | "DOUBLE_ELIMINATION" = "DOUBLE_ELIMINATION", entryFee = 0) {
  const ledger = new DoubleEntryLedger();
  const svc = new TournamentService(ledger);
  const players = Array.from({ length: count }, (_, i) => `p${i + 1}`);
  for (const p of players) {
    ledger.post({
      playerId: p,
      amount: 2000,
      debitAccount: "MATCH_BANK",
      creditAccount: "PLAYER_AVAILABLE",
      type: "deposit",
      idempotencyKey: `fund-${p}`,
    });
  }
  const t = svc.create({ name: `DE ${count}`, format, entryFee, maxPlayers: 16 });
  svc.openRegistration(t.id);
  for (const p of players) svc.register(t.id, p);
  svc.lock(t.id);
  svc.start(t.id);
  return { svc, ledger, id: t.id, players };
}

/** Play one playable match (winners first, then losers, then grand final). */
function step(svc: TournamentService, id: string, pick: (a: string, b: string) => string): boolean {
  const t = svc.get(id)!;
  const playable = t.bracket.filter((b) => !b.bye && !b.winnerId && b.seedA && b.seedB);
  if (playable.length === 0) return false;
  const order: Record<string, number> = { WINNERS: 0, LOSERS: 1, GRAND_FINAL: 2 };
  playable.sort((x, y) => (order[x.bracket ?? "WINNERS"] - order[y.bracket ?? "WINNERS"]) || x.round - y.round);
  const m = playable[0]!;
  svc.reportResult(id, m.id, pick(m.seedA!, m.seedB!));
  return true;
}

function playOut(svc: TournamentService, id: string, pick: (a: string, b: string) => string) {
  for (let i = 0; i < 128; i += 1) {
    if (svc.get(id)!.status === "COMPLETED") return;
    if (!step(svc, id, pick)) return;
  }
}

describe("double elimination", () => {
  it("builds a tagged winners bracket and an empty grand final", () => {
    const { svc, id } = setup(4);
    const t = svc.get(id)!;
    const winners = t.bracket.filter((b) => b.bracket === "WINNERS");
    const grand = t.bracket.filter((b) => b.bracket === "GRAND_FINAL");
    expect(winners).toHaveLength(3); // 2 semis + final for 4 players
    expect(winners.every((b) => b.bracket === "WINNERS")).toBe(true);
    expect(grand).toHaveLength(1);
    expect(grand[0]!.seedA).toBeUndefined();
    expect(grand[0]!.seedB).toBeUndefined();
    // Losers matches appear on demand, not at lock.
    expect(t.bracket.filter((b) => b.bracket === "LOSERS")).toHaveLength(0);
  });

  it("reaches a champion and records two-loss eliminations", () => {
    for (const count of [3, 4, 5, 6, 8]) {
      const { svc, id, players } = setup(count);
      playOut(svc, id, (a) => a);
      const t = svc.get(id)!;
      expect(t.status).toBe("COMPLETED");
      expect(players).toContain(t.championId!);
      const grand = t.bracket.find((b) => b.bracket === "GRAND_FINAL")!;
      expect(grand.seedA).toBeTruthy();
      expect(grand.seedB).toBeTruthy();
      expect(grand.winnerId).toBe(t.championId);
      // Every eliminated player took at least two losses.
      for (const p of t.eliminated ?? []) {
        expect(svc.lossesOf(t.bracket, p)).toBeGreaterThanOrEqual(2);
      }
      // Nobody is eliminated twice.
      expect(new Set(t.eliminated ?? []).size).toBe((t.eliminated ?? []).length);
      // The champion lost at most once (single grand final).
      expect(svc.lossesOf(t.bracket, t.championId!)).toBeLessThanOrEqual(1);
      // Losers-bracket matches were all real (two seeds, reported result).
      for (const m of t.bracket.filter((b) => b.bracket === "LOSERS")) {
        expect(m.seedA).toBeTruthy();
        expect(m.seedB).toBeTruthy();
        expect(m.winnerId).toBeTruthy();
      }
    }
  });

  it("never crowns a champion before the grand final is played", () => {
    const { svc, id } = setup(4);
    // Drive only the winners bracket to completion.
    for (let i = 0; i < 8; i += 1) {
      const t = svc.get(id)!;
      const wb = t.bracket.find((b) => b.bracket === "WINNERS" && !b.winnerId && b.seedA && b.seedB);
      if (!wb) break;
      svc.reportResult(id, wb.id, wb.seedA!);
    }
    const afterWinners = svc.get(id)!;
    // A winners-bracket win is not a title in double elimination.
    expect(afterWinners.championId).toBeUndefined();
    expect(afterWinners.status).toBe("ACTIVE");
    const undefeated = afterWinners.entries.filter((p) => svc.lossesOf(afterWinners.bracket, p) === 0);
    expect(undefeated).toHaveLength(1);

    // The grand final is only staged once exactly two players remain alive.
    expect(afterWinners.bracket.find((b) => b.bracket === "GRAND_FINAL")!.seedA).toBeUndefined();
    playOut(svc, id, (a) => a);
    const t = svc.get(id)!;
    expect(t.status).toBe("COMPLETED");
    const grand = t.bracket.find((b) => b.bracket === "GRAND_FINAL")!;
    expect(grand.seedA).toBeTruthy();
    expect(grand.seedB).toBeTruthy();
    // Both grand finalists had to survive the losers bracket.
    expect(grand.seedA).toBe(undefeated[0]);
  });

  it("settles prizes for at most two players", () => {
    const { svc, ledger, id } = setup(4, "DOUBLE_ELIMINATION", 1000);
    playOut(svc, id, (a) => a);
    expect(svc.get(id)!.status).toBe("COMPLETED");
    const payouts = new Map<string, number>();
    for (const p of ledger.history()) {
      if (p.type !== "tournament" || p.idempotencyKey.includes("-entry-")) continue;
      payouts.set(p.playerId!, (payouts.get(p.playerId!) ?? 0) + p.amount);
    }
    expect(payouts.size).toBeLessThanOrEqual(2);
    expect([...payouts.values()].reduce((a, b) => a + b, 0)).toBe(4000);
    expect(ledger.verifyInvariant().balanced).toBe(true);
  });

  it("keeps single elimination behaviour intact", () => {
    const { svc, id } = setup(4, "SINGLE_ELIMINATION");
    const t = svc.get(id)!;
    expect(t.bracket).toHaveLength(3);
    expect(t.bracket.every((b) => b.bracket === undefined)).toBe(true);
    playOut(svc, id, (a) => a);
    expect(svc.get(id)!.status).toBe("COMPLETED");
  });

  it("rejects a result for an unseeded match", () => {
    const { svc, id } = setup(4);
    // Winners final has only one seed until both semis are decided.
    const t = svc.get(id)!;
    const unseeded = t.bracket.find((b) => b.round === 2 && !b.seedB)!;
    expect(() => svc.reportResult(id, unseeded.id, unseeded.seedA!)).toThrow(/SEED_UNRESOLVED/);
  });
});
