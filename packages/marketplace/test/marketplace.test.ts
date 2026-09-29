import { describe, expect, it } from "vitest";
import { DoubleEntryLedger } from "@ledgerlands/ledger";
import { MarketplaceService } from "../src/index.js";

function funded(ledger: DoubleEntryLedger, userId: string, amount: number): void {
  ledger.post({
    playerId: userId,
    amount,
    debitAccount: "MATCH_BANK",
    creditAccount: "PLAYER_AVAILABLE",
    type: "deposit",
    idempotencyKey: `fund-${userId}-${amount}`,
  });
}

describe("marketplace sandbox", () => {
  it("settles LIST → BUY atomically with fee split", () => {
    const ledger = new DoubleEntryLedger();
    funded(ledger, "buyer", 2000);
    const svc = new MarketplaceService(ledger);
    svc.registerAsset("collectible-token", "spire-fox", "seller");
    const listing = svc.list("seller", "collectible-token", "spire-fox", 1000);
    expect(listing.status).toBe("OPEN");
    const sold = svc.buy("buyer", listing.id, "buy-1");
    expect(sold.status).toBe("SOLD");
    expect(svc.ownerOf("collectible-token", "spire-fox")).toBe("buyer");
    // 5% fee: buyer 2000-1000=1000; seller +950; platform +50; escrow nets 0.
    expect(ledger.balanceOf("PLAYER_AVAILABLE", "buyer")).toBe(1000);
    expect(ledger.balanceOf("PLAYER_AVAILABLE", "seller")).toBe(950);
    expect(ledger.balanceOf("PLATFORM", "buyer")).toBe(50);
    expect(ledger.balanceOf("MATCH_ESCROW", "buyer") + ledger.balanceOf("MATCH_ESCROW", "seller")).toBe(0);
    expect(ledger.verifyInvariant().balanced).toBe(true);
  });

  it("is idempotent on retry and rejects double purchase", () => {
    const ledger = new DoubleEntryLedger();
    funded(ledger, "buyer", 2000);
    const svc = new MarketplaceService(ledger);
    svc.registerAsset("cosmetic", "neon-dice", "seller");
    const listing = svc.list("seller", "cosmetic", "neon-dice", 500);
    const a = svc.buy("buyer", listing.id, "buy-2");
    const b = svc.buy("buyer", listing.id, "buy-2");
    expect(a).toEqual(b);
    expect(ledger.balanceOf("PLAYER_AVAILABLE", "buyer")).toBe(1500);
    expect(() => svc.buy("buyer", listing.id, "buy-3")).toThrow(/NOT_OPEN/);
  });

  it("enforces ownership, funds, self-buy, and expiry policy", () => {
    const ledger = new DoubleEntryLedger();
    funded(ledger, "buyer", 100);
    funded(ledger, "seller", 100);
    const svc = new MarketplaceService(ledger);
    expect(() => svc.list("seller", "cosmetic", "ghost", 100)).toThrow(/NOT_OWNER/);
    expect(() => svc.list("seller", "cosmetic", "ghost", 0)).toThrow(/INVALID_PRICE/);
    svc.registerAsset("board-theme", "midnight", "seller");
    const listing = svc.list("seller", "board-theme", "midnight", 500);
    expect(() => svc.buy("seller", listing.id, "self")).toThrow(/SELF_BUY/);
    expect(() => svc.buy("buyer", listing.id, "poor")).toThrow(/INSUFFICIENT_FUNDS/);
    expect(() => svc.cancel(listing.id, "buyer")).toThrow(/NOT_SELLER/);
    const cancelled = svc.cancel(listing.id, "seller");
    expect(cancelled.status).toBe("CANCELLED");
    expect(() => svc.buy("buyer", listing.id, "late")).toThrow(/NOT_OPEN/);

    svc.registerAsset("dice", "old", "seller");
    const exp = svc.list("seller", "dice", "old", 50, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(() => svc.buy("buyer", exp.id, "stale")).toThrow(/EXPIRED/);
    expect(svc.sweepExpired()).toBe(0); // already marked EXPIRED by the buy attempt
  });
});
