import { describe, expect, it } from "vitest";
import { DoubleEntryLedger } from "@ledgerlands/ledger";
import { MarketplaceService, type MarketplaceAssetKind } from "../src/index.js";
import { AuctionService, BundleService, OfferService } from "../src/extensions.js";

const T0 = 1_700_000_000_000;

function world() {
  const ledger = new DoubleEntryLedger();
  const market = new MarketplaceService(ledger);
  const owners = new Map<string, string>();
  const locked = new Set<string>();
  const key = (k: MarketplaceAssetKind, a: string) => `${k}:${a}`;
  const deps = {
    ownerOf: (k: MarketplaceAssetKind, a: string) => market.ownerOf(k, a),
    setOwner: (k: MarketplaceAssetKind, a: string, o: string) => market.registerAsset(k, a, o),
    lockAsset: (k: MarketplaceAssetKind, a: string) => {
      locked.add(key(k, a));
    },
    unlockAsset: (k: MarketplaceAssetKind, a: string) => {
      locked.delete(key(k, a));
    },
  };
  const offers = new OfferService(ledger, deps);
  const bundles = new BundleService(ledger, deps);
  let clock = T0;
  const auctions = new AuctionService(ledger, deps, () => clock);
  const fund = (id: string, amount: number) =>
    ledger.post({
      playerId: id,
      amount,
      debitAccount: "MATCH_BANK",
      creditAccount: "PLAYER_AVAILABLE",
      type: "deposit",
      idempotencyKey: `fund-${id}-${amount}`,
    });
  return { ledger, market, deps, owners, locked, offers, bundles, auctions, fund, now: () => clock, advance: (ms: number) => { clock += ms; } };
}

describe("marketplace extensions API surface", () => {
  it("buys a listed asset through the main service", () => {
    const w = world();
    w.market.registerAsset("cosmetic", "neon", "seller");
    w.fund("buyer", 3000);
    const listing = w.market.list("seller", "cosmetic", "neon", 1000);
    w.market.buy("buyer", listing.id, "mkt-1");
    expect(w.market.ownerOf("cosmetic", "neon")).toBe("buyer");
    expect(w.ledger.balanceOf("PLAYER_AVAILABLE", "buyer")).toBe(2000);
    expect(w.ledger.verifyInvariant().balanced).toBe(true);
  });

  it("accepts an offer against an already-listed asset and transfers once", () => {
    const w = world();
    w.market.registerAsset("collectible-token", "fox", "seller");
    w.fund("buyer", 5000);
    const offer = w.offers.create({ buyerId: "buyer", kind: "collectible-token", assetId: "fox", price: 1500, nowMs: T0 });
    w.offers.accept(offer.id, "seller", "api-off-1", T0);
    expect(w.market.ownerOf("collectible-token", "fox")).toBe("buyer");
    // The pre-existing listing must not be sellable now.
    expect(() => w.market.list("seller", "collectible-token", "fox", 2000)).toThrow(/NOT_OWNER/);
    expect(w.ledger.balanceOf("PLAYER_AVAILABLE", "buyer")).toBe(3500);
  });

  it("runs an auction to a winner with injected server time", () => {
    const w = world();
    w.market.registerAsset("board-theme", "midnight", "seller");
    w.fund("a", 4000);
    w.fund("b", 4000);
    const auction = w.auctions.create({ sellerId: "seller", kind: "board-theme", assetId: "midnight", startingPrice: 500, minIncrement: 100, durationMs: 5000 });
    w.auctions.bid(auction.id, "a", 500);
    w.auctions.bid(auction.id, "b", 900);
    w.advance(6000);
    const settled = w.auctions.settle(auction.id, "api-auc-1");
    expect(settled.winnerId).toBe("b");
    expect(w.market.ownerOf("board-theme", "midnight")).toBe("b");
    expect(w.ledger.verifyInvariant().balanced).toBe(true);
  });

  it("sells a bundle atomically", () => {
    const w = world();
    w.market.registerAsset("dice", "gold", "seller");
    w.market.registerAsset("cosmetic", "neon", "seller");
    w.fund("buyer", 4000);
    const bundle = w.bundles.create({
      sellerId: "seller",
      items: [
        { kind: "dice", assetId: "gold" },
        { kind: "cosmetic", assetId: "neon" },
      ],
      price: 2000,
      nowMs: T0,
    });
    w.bundles.buy(bundle.id, "buyer", "api-bundle-1");
    expect(w.market.ownerOf("dice", "gold")).toBe("buyer");
    expect(w.market.ownerOf("cosmetic", "neon")).toBe("buyer");
    expect(w.ledger.verifyInvariant().balanced).toBe(true);
  });

  it("keeps the ledger balanced across every operation type", () => {
    const w = world();
    for (const id of ["t1", "t2", "t3", "t4"]) w.market.registerAsset("collectible-token", id, "seller");
    w.fund("buyer", 20_000);
    w.fund("rival", 20_000);
    const listing = w.market.list("seller", "collectible-token", "t1", 1000);
    w.market.buy("buyer", listing.id, "mix-1");
    const offer = w.offers.create({ buyerId: "buyer", kind: "collectible-token", assetId: "t2", price: 900, nowMs: T0 });
    w.offers.accept(offer.id, "seller", "mix-2", T0);
    const auction = w.auctions.create({ sellerId: "seller", kind: "collectible-token", assetId: "t3", startingPrice: 800, minIncrement: 50, durationMs: 1000 });
    w.auctions.bid(auction.id, "rival", 800);
    w.advance(2000);
    w.auctions.settle(auction.id, "mix-3");
    // A single-item bundle is rejected at creation, so no settlement is attempted.
    expect(() =>
      w.bundles.create({ sellerId: "seller", items: [{ kind: "collectible-token", assetId: "t4" }], price: 500, nowMs: T0 }),
    ).toThrow(/BUNDLE_TOO_SMALL/);
    expect(w.ledger.verifyInvariant().balanced).toBe(true);
  });
});
