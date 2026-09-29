import { randomUUID } from "node:crypto";
import { DoubleEntryLedger } from "@ledgerlands/ledger";

export type TournamentStatus =
  | "DRAFT"
  | "REGISTRATION"
  | "LOCKED"
  | "ACTIVE"
  | "SETTLING"
  | "COMPLETED"
  | "CANCELLED"
  | "REFUNDED"
  | "DISPUTED";

export type BracketFormat = "SINGLE_ELIMINATION" | "DOUBLE_ELIMINATION" | "ROUND_ROBIN" | "SWISS";

export type BracketSide = "WINNERS" | "LOSERS" | "GRAND_FINAL";

export interface BracketMatch {
  id: string;
  round: number;
  seedA?: string | undefined;
  seedB?: string | undefined;
  winnerId?: string;
  matchId?: string;
  /** True when decided by first-round bye (no game played). */
  bye?: boolean;
  /** Id of the round-(round+1) match this match feeds. Makes advancement explicit. */
  targetMatchId?: string;
  /** Which bracket this match belongs to (single-elim leaves it undefined). */
  bracket?: BracketSide;
}

export interface Tournament {
  id: string;
  name: string;
  format: BracketFormat;
  status: TournamentStatus;
  entryFee: number;
  maxPlayers: number;
  prizeSplitBps: number[];
  entries: string[];
  bracket: BracketMatch[];
  /** Players knocked out after a second loss (double elimination). */
  eliminated?: string[];
  /** Double-elimination players holding one loss and awaiting their next match. */
  losersPool?: string[];
  championId?: string;
  createdAt: string;
  updatedAt: string;
}

export class TournamentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "TournamentError";
    this.code = code;
  }
}

/**
 * Practice-sat tournament service. Prize settlement posts balanced ledger legs
 * with idempotency keys, so retries never double-pay.
 */
export class TournamentService {
  private readonly tournaments = new Map<string, Tournament>();
  constructor(private readonly ledger = new DoubleEntryLedger()) {}

  create(params: { name: string; format?: BracketFormat; entryFee?: number; maxPlayers?: number; prizeSplitBps?: number[] }): Tournament {
    const name = params.name.trim();
    if (!name) throw new TournamentError("INVALID_NAME", "Tournament name is required.");
    const format = params.format ?? "SINGLE_ELIMINATION";
    if (format !== "SINGLE_ELIMINATION" && format !== "DOUBLE_ELIMINATION") {
      throw new TournamentError("UNSUPPORTED_FORMAT", `${format} is reserved for a later milestone; single or double elimination only.`);
    }
    const entryFee = params.entryFee ?? 0;
    if (!Number.isSafeInteger(entryFee) || entryFee < 0) throw new TournamentError("INVALID_FEE", "entryFee must be a non-negative integer.");
    const split = params.prizeSplitBps ?? [7000, 3000];
    if (split.reduce((x, y) => x + y, 0) !== 10000) throw new TournamentError("INVALID_SPLIT", "prizeSplitBps must sum to 10000.");
    const t: Tournament = {
      id: randomUUID(),
      name,
      format,
      status: "DRAFT",
      entryFee,
      maxPlayers: params.maxPlayers ?? 8,
      prizeSplitBps: split,
      entries: [],
      bracket: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.tournaments.set(t.id, t);
    return this.copy(t);
  }

  openRegistration(id: string): Tournament {
    return this.transition(id, "DRAFT", "REGISTRATION");
  }

  register(id: string, userId: string): Tournament {
    const t = this.require(id);
    if (t.status !== "REGISTRATION") throw new TournamentError("NOT_OPEN", "Registration is not open.");
    if (t.entries.includes(userId)) return this.copy(t);
    if (t.entries.length >= t.maxPlayers) throw new TournamentError("FULL", "Tournament is full.");
    t.entries.push(userId);
    if (t.entryFee > 0) {
      this.ledger.post({
        playerId: userId,
        amount: t.entryFee,
        debitAccount: "PLAYER_AVAILABLE",
        creditAccount: "PRIZE_POOL",
        type: "tournament",
        idempotencyKey: `tny-entry-${t.id}-${userId}`,
        metadata: { tournamentId: t.id },
      });
    }
    this.touch(t);
    return this.copy(t);
  }

  lock(id: string): Tournament {
    const t = this.require(id);
    if (t.status !== "REGISTRATION") throw new TournamentError("BAD_TRANSITION", "Lock requires REGISTRATION.");
    if (t.entries.length < 2) throw new TournamentError("NOT_ENOUGH_PLAYERS", "Need at least 2 entries.");
    if (t.format === "DOUBLE_ELIMINATION") {
      t.bracket = buildDoubleElim(t.entries);
    } else {
      t.bracket = buildSingleElim(t.entries);
    }
    t.status = "LOCKED";
    this.touch(t);
    return this.copy(t);
  }

  start(id: string): Tournament {
    return this.transition(id, "LOCKED", "ACTIVE");
  }

  /** Report a bracket result; auto-advances winners and completes the event. */
  reportResult(id: string, bracketMatchId: string, winnerId: string): Tournament {
    const t = this.require(id);
    if (t.status !== "ACTIVE") throw new TournamentError("NOT_ACTIVE", "Tournament is not active.");
    const m = t.bracket.find((b) => b.id === bracketMatchId);
    if (!m) throw new TournamentError("MATCH_NOT_FOUND", "Bracket match not found.");
    if (m.bye) throw new TournamentError("BYE_MATCH", "Bye matches are decided at lock; nothing to report.");
    if (m.winnerId) throw new TournamentError("ALREADY_REPORTED", "Result already recorded.");
    if (m.seedA !== winnerId && m.seedB !== winnerId) throw new TournamentError("NOT_PARTICIPANT", "Winner is not in this bracket match.");
    // A match with only one seed is not playable: the other participant has not
    // been decided yet (this matters in the losers bracket of double elim).
    if (!m.seedA || !m.seedB) throw new TournamentError("SEED_UNRESOLVED", "This bracket match is waiting on another result.");
    m.winnerId = winnerId;
    this.advance(t, m, winnerId);
    if (t.format === "DOUBLE_ELIMINATION") this.afterDoubleElimResult(t, m, winnerId);
    this.touch(t);
    return this.copy(t);
  }

  /** Loser count per player, used to decide elimination in double elimination. */
  lossesOf(bracket: readonly BracketMatch[], playerId: string): number {
    return bracket.filter((b) => b.winnerId && b.seedA !== b.winnerId && b.seedA === playerId).length +
      bracket.filter((b) => b.winnerId && b.seedB !== b.winnerId && b.seedB === playerId).length;
  }

  /** Players still alive in a double-elimination event (0 or 1 losses). */
  aliveDoubleElim(bracket: readonly BracketMatch[], entries: readonly string[]): string[] {
    return entries.filter((p) => this.lossesOf(bracket, p) < 2);
  }

  /** Explicit, replayable advancement: winner flows into the linked next-round match. */
  private advance(t: Tournament, m: BracketMatch, winnerId: string): void {
    if (m.targetMatchId) {
      const next = t.bracket.find((b) => b.id === m.targetMatchId);
      if (!next) throw new TournamentError("MATCH_NOT_FOUND", "Target bracket match not found.");
      if (next.seedA === undefined) next.seedA = winnerId;
      else if (next.seedB === undefined) next.seedB = winnerId;
      else throw new TournamentError("SLOT_TAKEN", "Next-round slot already filled.");
      return;
    }
    if (t.format === "DOUBLE_ELIMINATION" && m.bracket !== "GRAND_FINAL") {
      // Winners-bracket final (and any other unlinked match) does not crown a
      // champion in double elimination: the grand final must still be played.
      return;
    }
    t.championId = winnerId;
    t.status = "SETTLING";
    this.settle(t);
  }

  /**
   * Double elimination bookkeeping.
   * - Winners match: the loser joins the losers pool with a single loss.
   * - Losers match: the loser takes a second loss and is eliminated; the winner
   *   returns to the pool (a single loss) to face the next dropper.
   * - Grand final: handled by `advance`.
   */
  private afterDoubleElimResult(t: Tournament, m: BracketMatch, winnerId: string): void {
    // The grand final is the end of the event: nobody drops back to the pool.
    if (m.bracket === "GRAND_FINAL") return;
    const loser = m.seedA === winnerId ? m.seedB : m.seedA;
    if (!loser) return;
    if (m.bracket === "LOSERS") {
      // Second loss: out of the event entirely.
      if (!(t.eliminated ?? []).includes(loser)) t.eliminated = [...(t.eliminated ?? []), loser];
      this.pushLoser(t, winnerId);
      this.stageGrandFinalIfReady(t);
      return;
    }
    this.pushLoser(t, loser);
    this.stageGrandFinalIfReady(t);
  }

  /**
   * Losers pool. A single-elimination ladder over the pool is created on demand
   * (never pre-sized), so the bracket is exact for any entry count and every
   * match is a real reported result.
   */
  private pushLoser(t: Tournament, playerId: string): void {
    const pool = t.losersPool ?? [];
    pool.push(playerId);
    t.losersPool = pool;
    this.drainLosersPool(t);
  }

  private drainLosersPool(t: Tournament): void {
    const pool = t.losersPool ?? [];
    while (pool.length >= 2) {
      const a = pool.shift()!;
      const b = pool.shift()!;
      t.bracket.push({ id: randomUUID(), round: nextLosersRound(t), bracket: "LOSERS", seedA: a, seedB: b });
    }
    t.losersPool = pool;
  }

  private stageGrandFinalIfReady(t: Tournament): void {
    const undefeated = t.entries.filter((p) => this.lossesOf(t.bracket, p) === 0);
    const alive = this.aliveDoubleElim(t.bracket, t.entries);
    const grand = t.bracket.find((b) => b.bracket === "GRAND_FINAL" && !b.seedA && !b.seedB);
    if (!grand || undefeated.length !== 1 || alive.length !== 2) return;
    const champion = undefeated[0]!;
    const challenger = alive.find((p) => p !== champion);
    if (!challenger) return;
    grand.seedA = champion;
    grand.seedB = challenger;
  }

  cancel(id: string): Tournament {
    const t = this.require(id);
    if (t.status === "COMPLETED" || t.status === "REFUNDED") throw new TournamentError("TERMINAL", "Tournament already settled.");
    // Refund collected entry fees exactly once (idempotent keys).
    for (const userId of t.entries) {
      if (t.entryFee > 0) {
        this.ledger.post({
          playerId: userId,
          amount: t.entryFee,
          debitAccount: "PRIZE_POOL",
          creditAccount: "PLAYER_AVAILABLE",
          type: "refund",
          idempotencyKey: `tny-refund-${t.id}-${userId}`,
          metadata: { tournamentId: t.id },
        });
      }
    }
    t.status = t.status === "SETTLING" ? "DISPUTED" : "CANCELLED";
    if (t.status === "CANCELLED" && t.entries.length > 0) t.status = "REFUNDED";
    this.touch(t);
    return this.copy(t);
  }

  get(id: string): Tournament | undefined {
    const t = this.tournaments.get(id);
    return t ? this.copy(t) : undefined;
  }

  list(): Tournament[] {
    return [...this.tournaments.values()].map((t) => this.copy(t));
  }

  private settle(t: Tournament): void {
    const pool = t.entryFee * t.entries.length;
    if (pool <= 0 || !t.championId) {
      t.status = "COMPLETED";
      return;
    }
    const runnerUp = runnerUpOf(t);
    const payouts: Array<{ to: string; bps: number }> = [{ to: t.championId, bps: t.prizeSplitBps[0] ?? 10000 }];
    if (runnerUp && t.prizeSplitBps[1]) payouts.push({ to: runnerUp, bps: t.prizeSplitBps[1] });
    let paid = 0;
    payouts.forEach((p, i) => {
      const amount = i === payouts.length - 1 ? pool - paid : Math.floor((pool * p.bps) / 10000);
      paid += amount;
      if (amount <= 0) return;
      this.ledger.post({
        playerId: p.to,
        amount,
        debitAccount: "PRIZE_POOL",
        creditAccount: "PLAYER_AVAILABLE",
        type: "tournament",
        idempotencyKey: `tny-payout-${t.id}-${p.to}`,
        metadata: { tournamentId: t.id, place: i + 1 },
      });
    });
    t.status = "COMPLETED";
  }

  private transition(id: string, from: TournamentStatus, to: TournamentStatus): Tournament {
    const t = this.require(id);
    if (t.status !== from) throw new TournamentError("BAD_TRANSITION", `Requires ${from}, currently ${t.status}.`);
    t.status = to;
    this.touch(t);
    return this.copy(t);
  }

  private require(id: string): Tournament {
    const t = this.tournaments.get(id);
    if (!t) throw new TournamentError("NOT_FOUND", `Tournament ${id} was not found.`);
    return t;
  }

  private copy(t: Tournament): Tournament {
    return structuredClone(t);
  }

  private touch(t: Tournament): void {
    t.updatedAt = new Date().toISOString();
  }
}

function maxRound(bracket: readonly BracketMatch[]): number {
  return bracket.reduce((m, b) => Math.max(m, b.round), 0);
}

function nextLosersRound(t: Pick<Tournament, "bracket">): number {
  const existing = t.bracket.filter((b) => b.bracket === "LOSERS");
  return existing.length === 0 ? 1 : maxRound(existing) + 1;
}

function runnerUpOf(t: Tournament): string | undefined {
  // The deciding match is the last one that actually crowned a champion.
  const decided = t.bracket.filter((b) => b.winnerId);
  const final = decided.at(-1);
  if (!final?.winnerId) return undefined;
  return final.seedA === final.winnerId ? final.seedB : final.seedA;
}

function nextPowerOfTwo(n: number): number {
  let p = 2;
  while (p < n) p *= 2;
  return p;
}

/**
 * Single elimination with deterministic byes.
 *
 * Registration order is the seed order; the draw fills sequentially, so byes
 * fall to the END of registration (late registrants meet an empty slot). Round-1
 * byes are pre-decided at lock and flagged `bye` so audits never see them as
 * played matches. Every other match is decided by a reported result, and each
 * match links to its `targetMatchId` so advancement is explicit and replayable.
 */
function buildSingleElim(entries: string[]): BracketMatch[] {
  const size = nextPowerOfTwo(entries.length);
  const rounds = Math.log2(size);
  const slots = size / 2; // matches in round 1
  // Playable round-1 matches, then one bye per remaining player. Every match
  // gets at least one real registrant, so no phantom/empty match ever exists.
  const fullMatches = Math.max(0, entries.length - slots);
  const byeCount = slots - fullMatches;
  const bracket: BracketMatch[] = [];

  // Round 1.
  const round1: BracketMatch[] = [];
  let i = 0;
  for (let f = 0; f < fullMatches; f += 1) {
    round1.push({ id: randomUUID(), round: 1, seedA: entries[i++], seedB: entries[i++] });
  }
  for (let b = 0; b < byeCount; b += 1) {
    const p = entries[i++]!;
    round1.push({ id: randomUUID(), round: 1, seedA: p, bye: true, winnerId: p });
  }

  // Later rounds: create shells and link each match to the one it feeds.
  const roundsOf: BracketMatch[][] = [round1];
  let current = round1;
  for (let r = 2; r <= rounds; r += 1) {
    const next: BracketMatch[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push({ id: randomUUID(), round: r });
    }
    for (let i = 0; i < current.length; i += 1) {
      const target = next[Math.floor(i / 2)];
      if (target) current[i]!.targetMatchId = target.id;
    }
    roundsOf.push(next);
    current = next;
  }

  for (const r of roundsOf) bracket.push(...r);

  // Advance pre-decided byes into their target round.
  for (const m of round1) {
    if (!m.bye || !m.winnerId || !m.targetMatchId) continue;
    const target = bracket.find((b) => b.id === m.targetMatchId);
    if (!target) continue;
    if (target.seedA === undefined) target.seedA = m.winnerId;
    else if (target.seedB === undefined) target.seedB = m.winnerId;
  }
  return bracket;
}

/**
 * Double elimination. The winners bracket is the single-elim skeleton (tagged
 * `WINNERS`); losers matches are created on demand from the losers pool rather
 * than pre-sized shells, so the ladder is exact for any entry count and every
 * losers match is a real reported result. The grand final is staged once
 * exactly one unbeaten player and one other player remain, and only the grand
 * final crowns a champion. A single grand-final match (no bracket reset) is a
 * documented follow-up.
 */
function buildDoubleElim(entries: string[]): BracketMatch[] {
  const winners = buildSingleElim(entries).map((m) => ({ ...m, bracket: "WINNERS" as BracketSide }));
  const grand: BracketMatch = { id: randomUUID(), round: maxRound(winners) + 1, bracket: "GRAND_FINAL" };
  return [...winners, grand];
}
