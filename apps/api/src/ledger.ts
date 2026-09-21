import { randomUUID } from "node:crypto";

export interface LedgerEntry {
  id: string;
  accountId: string;
  amount: number;
  direction: "DEBIT" | "CREDIT";
  category: "practice" | "promotional" | "locked" | "pending";
  reference: string;
  createdAt: string;
}

export class PracticeLedger {
  private readonly entries: LedgerEntry[] = [];

  record(entry: Omit<LedgerEntry, "id" | "createdAt">): LedgerEntry {
    if (!Number.isSafeInteger(entry.amount) || entry.amount < 0) {
      throw new Error("Ledger amount must be a non-negative safe integer in the smallest practice unit.");
    }
    const stored = { ...entry, id: randomUUID(), createdAt: new Date().toISOString() };
    this.entries.push(stored);
    return stored;
  }

  balance(accountId: string, category: LedgerEntry["category"] = "practice"): number {
    return this.entries
      .filter((e) => e.accountId === accountId && e.category === category)
      .reduce((sum, e) => sum + (e.direction === "CREDIT" ? e.amount : -e.amount), 0);
  }

  history(accountId: string): LedgerEntry[] {
    return this.entries.filter((e) => e.accountId === accountId).map((e) => ({ ...e }));
  }
}
