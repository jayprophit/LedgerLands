import { randomUUID } from "node:crypto";

/**
 * Double-entry practice ledger.
 * Every movement posts a balanced pair: debit one account, credit another.
 * Invariant: sum(debits) === sum(credits) per transaction and globally.
 */

export type LedgerAccountCode =
  | "PLAYER_AVAILABLE"
  | "PLAYER_MATCH_LOCKED"
  | "MATCH_BANK"
  | "MATCH_ESCROW"
  | "PRIZE_POOL"
  | "REWARD_POOL"
  | "PLATFORM"
  | "WITHDRAWAL_PENDING";

export type LedgerEntryType =
  | "deposit"
  | "entry_lock"
  | "entry_release"
  | "property_purchase"
  | "rent"
  | "tax"
  | "card_effect"
  | "building"
  | "mortgage"
  | "unmortgage"
  | "auction_settlement"
  | "trade_settlement"
  | "reward"
  | "quest_reward"
  | "login_reward"
  | "refund"
  | "withdrawal"
  | "fee"
  | "adjustment";

export interface LedgerPosting {
  id: string;
  transactionId: string;
  playerId?: string;
  matchId?: string;
  asset: "SIM_SAT";
  amount: number;
  debitAccount: LedgerAccountCode;
  creditAccount: LedgerAccountCode;
  type: LedgerEntryType;
  timestamp: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export class LedgerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

export class DoubleEntryLedger {
  private readonly postings: LedgerPosting[] = [];
  private readonly keys = new Set<string>();

  post(entry: {
    playerId?: string;
    matchId?: string;
    asset?: "SIM_SAT";
    amount: number;
    debitAccount: LedgerAccountCode;
    creditAccount: LedgerAccountCode;
    type: LedgerEntryType;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  }): LedgerPosting[] {
    if (!Number.isSafeInteger(entry.amount) || entry.amount <= 0) {
      throw new LedgerError("INVALID_AMOUNT", "Ledger amount must be a positive safe integer.");
    }
    if (entry.debitAccount === entry.creditAccount) {
      throw new LedgerError("SAME_ACCOUNT", "Debit and credit accounts must differ.");
    }
    if (this.keys.has(entry.idempotencyKey)) {
      return this.postings.filter((p) => p.idempotencyKey === entry.idempotencyKey).map((p) => ({ ...p }));
    }
    const transactionId = randomUUID();
    const timestamp = new Date().toISOString();
    // Balanced pair: debit leg + credit leg share transactionId + idempotencyKey.
    const legs: LedgerPosting[] = [
      {
        id: randomUUID(),
        transactionId,
        ...(entry.playerId !== undefined ? { playerId: entry.playerId } : {}),
        ...(entry.matchId !== undefined ? { matchId: entry.matchId } : {}),
        asset: entry.asset ?? "SIM_SAT",
        amount: entry.amount,
        debitAccount: entry.debitAccount,
        creditAccount: entry.creditAccount,
        type: entry.type,
        timestamp,
        idempotencyKey: entry.idempotencyKey,
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
      },
    ];
    this.postings.push(...legs);
    this.keys.add(entry.idempotencyKey);
    return legs.map((p) => ({ ...p }));
  }

  /** Net balance of an account for a player (credits - debits from account perspective). */
  balanceOf(account: LedgerAccountCode, playerId?: string): number {
    let sum = 0;
    for (const p of this.postings) {
      if (playerId !== undefined && p.playerId !== playerId) continue;
      if (p.creditAccount === account) sum += p.amount;
      if (p.debitAccount === account) sum -= p.amount;
    }
    return sum;
  }

  history(playerId?: string): LedgerPosting[] {
    return this.postings.filter((p) => (playerId === undefined ? true : p.playerId === playerId)).map((p) => ({ ...p }));
  }

  /** Global invariant: every posting is balanced by construction; verify no same-account legs and positive amounts. */
  verifyInvariant(): { postings: number; balanced: boolean } {
    for (const p of this.postings) {
      if (p.debitAccount === p.creditAccount) return { postings: this.postings.length, balanced: false };
      if (!Number.isSafeInteger(p.amount) || p.amount <= 0) return { postings: this.postings.length, balanced: false };
    }
    return { postings: this.postings.length, balanced: true };
  }
}
