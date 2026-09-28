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

export interface BracketMatch {
  id: string;
  round: number;
  seedA?: string | undefined;
  seedB?: string | undefined;
  winnerId?: string;
  matchId?: string;
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
  championId?: string;
  createdAt: string;
  updatedAt: string;
}

export class TournamentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
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
    if (format !== "SINGLE_ELIMINATION") {
      throw new TournamentError("UNSUPPORTED_FORMAT", `${format} is reserved for a later milestone; SINGLE_ELIMINATION only in MVP.`);
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
    if (!isPowerOfTwo(t.entries.length)) {
      throw new TournamentError("NEEDS_POWER_OF_TWO", "MVP brackets need 2, 4 or 8 entries (byes are a follow-up).");
    }
    t.bracket = buildSingleElim(t.entries);
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
    if (m.winnerId) throw new TournamentError("ALREADY_REPORTED", "Result already recorded.");
    if (m.seedA !== winnerId && m.seedB !== winnerId) throw new TournamentError("NOT_PARTICIPANT", "Winner is not in this bracket match.");
    m.winnerId = winnerId;
    // Advance into next round slot.
    const next = t.bracket.find((b) => b.round === m.round + 1 && (b.seedA === undefined || b.seedB === undefined));
    if (next) {
      if (next.seedA === undefined) next.seedA = winnerId;
      else next.seedB = winnerId;
    } else if (m.round === maxRound(t.bracket)) {
      t.championId = winnerId;
      t.status = "SETTLING";
      this.settle(t);
    }
    this.touch(t);
    return this.copy(t);
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

function maxRound(bracket: BracketMatch[]): number {
  return bracket.reduce((m, b) => Math.max(m, b.round), 0);
}

function runnerUpOf(t: Tournament): string | undefined {
  const final = t.bracket.find((b) => b.round === maxRound(t.bracket));
  if (!final?.winnerId) return undefined;
  return final.seedA === final.winnerId ? final.seedB : final.seedA;
}

function isPowerOfTwo(n: number): boolean {
  return n >= 2 && (n & (n - 1)) === 0;
}

function buildSingleElim(entries: string[]): BracketMatch[] {
  const rounds = Math.log2(entries.length);
  const bracket: BracketMatch[] = [];
  let roundSeeds: Array<string | undefined> = [...entries];
  for (let r = 1; r <= rounds; r += 1) {
    const next: Array<string | undefined> = [];
    for (let i = 0; i < roundSeeds.length; i += 2) {
      bracket.push({ id: randomUUID(), round: r, seedA: roundSeeds[i], seedB: roundSeeds[i + 1] });
      next.push(undefined);
    }
    roundSeeds = next;
  }
  return bracket;
}
