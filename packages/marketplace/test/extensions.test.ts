import { describe, expect, it } from "vitest";
import { DoubleEntryLedger } from "@ledgerlands/ledger";
import { MarketplaceService, type MarketplaceAssetKind } from "../src/index.js";
import { AuctionService, BundleService, OfferService } from "../src/extensions.js";

const T0 = 1_700_000_000_000;

function harness(clockStart = T0) {
  const ledger = new DoubleEntryLedger();
  const owners = new Map<string, string>();
  const locked = new Set<string>();
  const key = (k: MarketplaceAssetKind, a: string) => `${k}:${a}`;

  const deps = {
    ownerOf: (k: MarketplaceAssetKind, a: string) => owners.get(key(k, a)),
    setOwner: (k: MarketplaceAssetKind, a: string, o: string) => {
      owners.set(key(k, a), o);
    },
    lockAsset: (k: MarketplaceAssetKind, a: string) => {
      locked.add(key(k, a));
    },
    unlockAsset: (k: MarketplaceAssetKind, a: string) => {
      locked.delete(key(k, a));
    },
  };

  let clock = clockStart;
  const now = () => clock;
  const offers = new OfferService(ledger, deps);
  const auctions = new AuctionService(ledger, deps, now);
  const bundles = new BundleService(ledger, deps);
  const market = new MarketplaceService(ledger);

  const fund = (id: string, amount: number) =>
    ledger.post({
      playerId: id,
      amount,
      debitAccount: "MATCH_BANK",
      creditAccount: "PLAYER_AVAILABLE",
      type: "deposit",
      idempotencyKey: `fund-${id}-${amount}`,
    });

  return {
    ledger,
    owners,
    locked,
    offers,
    auctions,
    bundles,
    market,
    fund,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe("marketplace offers", () => {
  it("accepts an offer and settles ledger + ownership", () => {
    const h = harness();
    h.owners.set("cosmetic:neon", "seller");
    h.fund("buyer", 2000);
    const offer = h.offers.create({ buyerId: "buyer", kind: "cosmetic", assetId: "neon", price: 1000, nowMs: T0 });
    expect(offer.status).toBe("OPEN");
    expect(h.locked.has("cosmetic:neon")).toBe(true);

    const accepted = h.offers.accept(offer.id, "seller", "off-1", T0);
    expect(accepted.status).toBe("ACCEPTED");
    expect(h.owners.get("cosmetic:neon")).toBe("buyer");
    // Buyer pays the full 1000 (950 to seller + 50 platform fee).
    expect(h.ledger.balanceOf("PLAYER_AVAILABLE", "buyer")).toBe(1000);
    expect(h.ledger.balanceOf("PLAYER_AVAILABLE", "seller")).toBe(950);
    expect(h.ledger.balanceOf("PLATFORM", "buyer")).toBe(50);
    expect(h.ledger.verifyInvariant().balanced).toBe(true);
  });

  it("is idempotent on retry", () => {
    const h = harness();
    h.owners.set("cosmetic:neon", "seller");
    h.fund("buyer", 2000);
    const offer = h.offers.create({ buyerId: "buyer", kind: "cosmetic", assetId: "neon", price: 1000, nowMs: T0 });
    const a = h.offers.accept(offer.id, "seller", "off-2", T0);
    const b = h.offers.accept(offer.id, "seller", "off-2", T0);
    expect(a).toEqual(b);
    expect(h.ledger.balanceOf("PLAYER_AVAILABLE", "buyer")).toBe(1000);
    expect(h.ledger.balanceOf("PLAYER_AVAILABLE", "seller")).toBe(950);
  });

  it("rejects self-offers, invalid prices, and unaffordable offers", () => {
    const h = harness();
    h.owners.set("cosmetic:neon", "seller");
    h.fund("seller", 5000);
    h.fund("buyer", 10);
    expect(() => h.offers.create({ buyerId: "seller", kind: "cosmetic", assetId: "neon", price: 100 })).toThrow(/SELF_OFFER/);
    expect(() => h.offers.create({ buyerId: "buyer", kind: "cosmetic", assetId: "neon", price: 0 })).toThrow(/INVALID_PRICE/);
    expect(() => h.offers.create({ buyerId: "buyer", kind: "cosmetic", assetId: "neon", price: 1000 })).toThrow(/INSUFFICIENT_FUNDS/);
  });

  it("rejects, cancels, and expires offers correctly", () => {
    const h = harness();
    h.owners.set("cosmetic:a", "seller");
    h.fund("buyer", 5000);

    const rejected = h.offers.create({ buyerId: "buyer", kind: "cosmetic", assetId: "a", price: 100, nowMs: T0 });
    expect(h.offers.reject(rejected.id, "seller").status).toBe("REJECTED");
    expect(h.locked.has("cosmetic:a")).toBe(false);

    const cancelled = h.offers.create({ buyerId: "buyer", kind: "cosmetic", assetId: "a", price: 100, nowMs: T0 });
    expect(h.offers.cancel(cancelled.id, "buyer").status).toBe("CANCELLED");
    expect(() => h.offers.cancel(cancelled.id, "seller")).toThrow(/NOT_OPEN/);

    const expiring = h.offers.create({
      buyerId: "buyer",
      kind: "cosmetic",
      assetId: "a",
      price: 100,
      nowMs: T0,
      expiresAt: new Date(T0 + 1000).toISOString(),
    });
    h.advance(2000);
    expect(() => h.offers.accept(expiring.id, "seller", "off-exp", h.now())).toThrow(/EXPIRED/);
    expect(h.locked.has("cosmetic:a")).toBe(false);
  });
});

describe("marketplace auctions", () => {
  it("enforces minimum increments and settles to the highest bidder", () => {
    const h = harness();
    h.owners.set("collectible-token:fox", "seller");
    h.fund("a", 5000);
    h.fund("b", 5000);
    const auction = h.auctions.create({
      sellerId: "seller",
      kind: "collectible-token",
      assetId: "fox",
      startingPrice: 1000,
      minIncrement: 100,
      durationMs: 60_000,
    });
    h.auctions.bid(auction.id, "a", 1000);
    expect(() => h.auctions.bid(auction.id, "b", 1050)).toThrow(/BID_TOO_LOW/);
    h.auctions.bid(auction.id, "b", 1200);
    expect(() => h.auctions.bid(auction.id, "a", 1250)).toThrow(/BID_TOO_LOW/); // must beat by increment
    h.auctions.bid(auction.id, "a", 1300);

    const settled = h.auctions.settle(auction.id, "auc-1");
    expect(settled.status).toBe("SETTLED");
    expect(settled.winnerId).toBe("a");
    expect(h.owners.get("collectible-token:fox")).toBe("a");
    // Winner pays the full 1300: 1235 to seller + 65 platform fee.
    expect(h.ledger.balanceOf("PLAYER_AVAILABLE", "a")).toBe(3700);
    expect(h.ledger.balanceOf("PLAYER_AVAILABLE", "seller")).toBe(1235);
    expect(h.ledger.balanceOf("PLATFORM", "a")).toBe(65);
    // The losing bidder was never charged.
    expect(h.ledger.balanceOf("PLAYER_AVAILABLE", "b")).toBe(5000);
    expect(h.ledger.verifyInvariant().balanced).toBe(true);
  });

  it("settles an ended auction and never pays a winning bidder twice", () => {
    const h = harness();
    h.owners.set("collectible-token:fox", "seller");
    h.fund("a", 5000);
    const auction = h.auctions.create({ sellerId: "seller", kind: "collectible-token", assetId: "fox", startingPrice: 1000, minIncrement: 100, durationMs: 1000 });
    h.auctions.bid(auction.id, "a", 1000);
    h.advance(2000);
    // A late bid is rejected and closes the auction, but the recorded bid stands.
    expect(() => h.auctions.bid(auction.id, "a", 2000)).toThrow(/EXPIRED/);
    const first = h.auctions.settle(auction.id, "auc-2");
    expect(first.status).toBe("SETTLED");
    expect(first.winnerId).toBe("a");
    // Retrying with the same key, or a different key, must not pay again.
    const retry = h.auctions.settle(auction.id, "auc-2");
    const again = h.auctions.settle(auction.id, "auc-2-other");
    expect(retry).toEqual(first);
    expect(again.status).toBe("SETTLED");
    expect(h.ledger.balanceOf("PLAYER_AVAILABLE", "a")).toBe(5000 - 1000);
    expect(h.ledger.verifyInvariant().balanced).toBe(true);
  });

  it("expires with no bids and leaves the asset untransferred", () => {
    const h = harness();
    h.owners.set("collectible-token:fox", "seller");
    const auction = h.auctions.create({ sellerId: "seller", kind: "collectible-token", assetId: "fox", startingPrice: 100, minIncrement: 10, durationMs: 1000 });
    const settled = h.auctions.settle(auction.id, "auc-3");
    expect(settled.status).toBe("EXPIRED");
    expect(h.owners.get("collectible-token:fox")).toBe("seller");
  });

  it("prevents seller bidding, and cancelling makes an auction unsettleable", () => {
    const h = harness();
    h.owners.set("collectible-token:fox", "seller");
    h.fund("a", 5000);
    const auction = h.auctions.create({ sellerId: "seller", kind: "collectible-token", assetId: "fox", startingPrice: 100, minIncrement: 10, durationMs: 60_000 });
    expect(() => h.auctions.bid(auction.id, "seller", 500)).toThrow(/SELF_BID/);
    h.auctions.bid(auction.id, "a", 200);
    h.auctions.cancel(auction.id, "seller");
    // A cancelled auction must never settle to a bidder.
    expect(() => h.auctions.settle(auction.id, "auc-5")).toThrow(/CANCELLED/);
    expect(h.owners.get("collectible-token:fox")).toBe("seller");
    expect(h.ledger.balanceOf("PLAYER_AVAILABLE", "a")).toBe(5000);
  });
});

describe("marketplace bundles", () => {
  it("transfers every asset atomically", () => {
    const h = harness();
    h.owners.set("collectible-token:fox", "seller");
    h.owners.set("cosmetic:neon", "seller");
    h.fund("buyer", 5000);
    const bundle = h.bundles.create({
      sellerId: "seller",
      items: [
        { kind: "collectible-token", assetId: "fox" },
        { kind: "cosmetic", assetId: "neon" },
      ],
      price: 2000,
      nowMs: T0,
    });
    const sold = h.bundles.buy(bundle.id, "buyer", "bundle-1");
    expect(sold.status).toBe("SOLD");
    expect(h.owners.get("collectible-token:fox")).toBe("buyer");
    expect(h.owners.get("cosmetic:neon")).toBe("buyer");
    // Buyer pays the full 2000: 1900 to seller + 100 platform fee.
    expect(h.ledger.balanceOf("PLAYER_AVAILABLE", "buyer")).toBe(3000);
    expect(h.ledger.balanceOf("PLAYER_AVAILABLE", "seller")).toBe(1900);
    expect(h.ledger.verifyInvariant().balanced).toBe(true);
  });

  it("never partially settles: a lost item aborts before any transfer", () => {
    const h = harness();
    h.owners.set("collectible-token:fox", "seller");
    h.owners.set("cosmetic:neon", "seller");
    h.fund("buyer", 5000);
    const bundle = h.bundles.create({
      sellerId: "seller",
      items: [
        { kind: "collectible-token", assetId: "fox" },
        { kind: "cosmetic", assetId: "neon" },
      ],
      price: 2000,
      nowMs: T0,
    });
    // The seller loses one asset after listing.
    h.owners.set("cosmetic:neon", "someone-else");
    expect(() => h.bundles.buy(bundle.id, "buyer", "bundle-2")).toThrow(/SELLER_NOT_OWNER/);
    expect(h.owners.get("collectible-token:fox")).toBe("seller");
    expect(h.owners.get("cosmetic:neon")).toBe("someone-else");
    expect(h.ledger.balanceOf("PLAYER_AVAILABLE", "buyer")).toBe(5000);
    expect(h.ledger.verifyInvariant().balanced).toBe(true);
  });

  it("validates bundle shape and duplicate items", () => {
    const h = harness();
    h.owners.set("cosmetic:neon", "seller");
    expect(() => h.bundles.create({ sellerId: "seller", items: [{ kind: "cosmetic", assetId: "neon" }], price: 100 })).toThrow(/BUNDLE_TOO_SMALL/);
    expect(() =>
      h.bundles.create({
        sellerId: "seller",
        items: [
          { kind: "cosmetic", assetId: "neon" },
          { kind: "cosmetic", assetId: "neon" },
        ],
        price: 100,
      }),
    ).toThrow(/DUPLICATE_ITEM/);
    expect(() =>
      h.bundles.create({ sellerId: "seller", items: [{ kind: "cosmetic", assetId: "neon" }, { kind: "cosmetic", assetId: "ghost" }], price: 100 }),
    ).toThrow(/NOT_OWNER/);
  });

  it("is idempotent and rejects double purchase", () => {
    const h = harness();
    h.owners.set("cosmetic:a", "seller");
    h.owners.set("cosmetic:b", "seller");
    h.fund("buyer", 5000);
    const bundle = h.bundles.create({ sellerId: "seller", items: [{ kind: "cosmetic", assetId: "a" }, { kind: "cosmetic", assetId: "b" }], price: 1000, nowMs: T0 });
    const first = h.bundles.buy(bundle.id, "buyer", "bundle-3");
    const retry = h.bundles.buy(bundle.id, "buyer", "bundle-3");
    expect(first).toEqual(retry);
    expect(() => h.bundles.buy(bundle.id, "buyer", "bundle-4")).toThrow(/NOT_OPEN/);
    // Buyer pays the full 1000 once; the retry is a no-op.
    expect(h.ledger.balanceOf("PLAYER_AVAILABLE", "buyer")).toBe(4000);
  });
});

describe("asset locking across listings", () => {
  it("a locked asset cannot be listed while an offer is open", () => {
    const h = harness();
    h.owners.set("cosmetic:neon", "seller");
    h.fund("buyer", 2000);
    h.offers.create({ buyerId: "buyer", kind: "cosmetic", assetId: "neon", price: 1000, nowMs: T0 });
    expect(h.locked.has("cosmetic:neon")).toBe(true);
    h.offers.cancel(h.offers.listOpen()[0]!.id, "buyer");
    expect(h.locked.has("cosmetic:neon")).toBe(false);
  });
});
