import { randomUUID } from "node:crypto";
import { DoubleEntryLedger } from "@ledgerlands/ledger";
import { MARKETPLACE_FEE_BPS, MarketplaceError, type MarketplaceAssetKind } from "./index.js";

/**
 * Marketplace extensions: offers, auctions, and bundles.
 *
 * Every settlement goes through the same double-entry discipline as a plain
 * purchase (buyer debit → escrow → seller credit, plus platform fee), with
 * idempotency keys derived from the caller-supplied operation id. All of it
 * remains simulated sats.
 */

// ---- Offers (buyer-initiated, against an owned or listed asset) ----

export type OfferStatus = "OPEN" | "ACCEPTED" | "REJECTED" | "CANCELLED" | "EXPIRED";

export interface Offer {
  id: string;
  offerId: string;
  buyerId: string;
  sellerId: string;
  kind: MarketplaceAssetKind;
  assetId: string;
  price: number;
  status: OfferStatus;
  expiresAt?: string;
  createdAt: string;
  settlementId?: string;
}

export class OfferService {
  private readonly offers = new Map<string, Offer>();
  private readonly settled = new Set<string>();

  constructor(
    private readonly ledger: DoubleEntryLedger,
    private readonly deps: {
      ownerOf: (kind: MarketplaceAssetKind, assetId: string) => string | undefined;
      setOwner: (kind: MarketplaceAssetKind, assetId: string, ownerId: string) => void;
      /** Marks the asset so it cannot be listed while reserved by an offer. */
      lockAsset?: (kind: MarketplaceAssetKind, assetId: string) => void;
      unlockAsset?: (kind: MarketplaceAssetKind, assetId: string) => void;
    },
    private readonly feeBps = MARKETPLACE_FEE_BPS,
  ) {}

  /** Buyer-initiated. The seller is derived from current ownership. */
  create(params: {
    buyerId: string;
    kind: MarketplaceAssetKind;
    assetId: string;
    price: number;
    nowMs?: number;
    expiresAt?: string;
  }): Offer {
    if (!Number.isSafeInteger(params.price) || params.price <= 0) {
      throw new MarketplaceError("INVALID_PRICE", "Offer price must be a positive integer.");
    }
    const seller = this.deps.ownerOf(params.kind, params.assetId);
    if (!seller) throw new MarketplaceError("NOT_OWNED", "Asset does not exist or has no owner.");
    if (seller === params.buyerId) throw new MarketplaceError("SELF_OFFER", "Cannot make an offer on your own asset.");
    if (this.ledger.balanceOf("PLAYER_AVAILABLE", params.buyerId) < params.price) {
      throw new MarketplaceError("INSUFFICIENT_FUNDS", "Buyer lacks funds for the offered price.");
    }
    const offer: Offer = {
      id: randomUUID(),
      offerId: randomUUID(),
      buyerId: params.buyerId,
      sellerId: seller,
      kind: params.kind,
      assetId: params.assetId,
      price: params.price,
      status: "OPEN",
      createdAt: new Date(params.nowMs ?? Date.now()).toISOString(),
      ...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt } : {}),
    };
    this.offers.set(offer.id, offer);
    this.deps.lockAsset?.(params.kind, params.assetId);
    return { ...offer };
  }

  accept(offerId: string, sellerId: string, idempotencyKey: string, nowMs = Date.now()): Offer {
    const o = this.require(offerId);
    if (this.settled.has(idempotencyKey)) return { ...o };
    if (o.status !== "OPEN") throw new MarketplaceError("NOT_OPEN", `Offer is ${o.status}.`);
    if (o.sellerId !== sellerId) throw new MarketplaceError("NOT_SELLER", "Only the asset owner may accept.");
    if (o.expiresAt && Date.parse(o.expiresAt) <= nowMs) {
      o.status = "EXPIRED";
      this.deps.unlockAsset?.(o.kind, o.assetId);
      throw new MarketplaceError("EXPIRED", "Offer has expired.");
    }
    if (this.deps.ownerOf(o.kind, o.assetId) !== o.sellerId) {
      throw new MarketplaceError("SELLER_NOT_OWNER", "Seller no longer owns the asset.");
    }
    if (this.ledger.balanceOf("PLAYER_AVAILABLE", o.buyerId) < o.price) {
      throw new MarketplaceError("INSUFFICIENT_FUNDS", "Buyer no longer has the offered funds.");
    }
    this.settle(o, idempotencyKey);
    o.status = "ACCEPTED";
    return { ...o };
  }

  reject(offerId: string, actorId: string): Offer {
    const o = this.require(offerId);
    if (o.status !== "OPEN") throw new MarketplaceError("NOT_OPEN", `Offer is ${o.status}.`);
    if (actorId !== o.sellerId && actorId !== o.buyerId) {
      throw new MarketplaceError("NOT_PARTY", "Only a party to the offer may reject it.");
    }
    o.status = "REJECTED";
    this.deps.unlockAsset?.(o.kind, o.assetId);
    return { ...o };
  }

  cancel(offerId: string, buyerId: string): Offer {
    const o = this.require(offerId);
    if (o.status !== "OPEN") throw new MarketplaceError("NOT_OPEN", `Offer is ${o.status}.`);
    if (o.buyerId !== buyerId) throw new MarketplaceError("NOT_BUYER", "Only the buyer may cancel an offer.");
    o.status = "CANCELLED";
    this.deps.unlockAsset?.(o.kind, o.assetId);
    return { ...o };
  }

  sweepExpired(nowMs = Date.now()): number {
    let n = 0;
    for (const o of this.offers.values()) {
      if (o.status !== "OPEN" || !o.expiresAt) continue;
      if (Date.parse(o.expiresAt) > nowMs) continue;
      o.status = "EXPIRED";
      this.deps.unlockAsset?.(o.kind, o.assetId);
      n += 1;
    }
    return n;
  }

  listOpen(): Offer[] {
    return [...this.offers.values()].filter((o) => o.status === "OPEN").map((o) => ({ ...o }));
  }

  get(offerId: string): Offer | undefined {
    const o = this.offers.get(offerId);
    return o ? { ...o } : undefined;
  }

  /** Shared escrow-routed settlement, identical in shape to a direct purchase. */
  private settle(o: Offer, idempotencyKey: string): void {
    const fee = Math.floor((o.price * this.feeBps) / 10000);
    const toSeller = o.price - fee;
    let buyerLeg = false;
    try {
      this.ledger.post({
        playerId: o.buyerId,
        amount: toSeller,
        debitAccount: "PLAYER_AVAILABLE",
        creditAccount: "MATCH_ESCROW",
        type: "marketplace",
        idempotencyKey: `${idempotencyKey}-escrow`,
        metadata: { offerId: o.offerId },
      });
      buyerLeg = true;
      this.ledger.post({
        playerId: o.sellerId,
        amount: toSeller,
        debitAccount: "MATCH_ESCROW",
        creditAccount: "PLAYER_AVAILABLE",
        type: "marketplace",
        idempotencyKey: `${idempotencyKey}-seller`,
        metadata: { offerId: o.offerId, buyerId: o.buyerId },
      });
      if (fee > 0) {
        this.ledger.post({
          playerId: o.buyerId,
          amount: fee,
          debitAccount: "PLAYER_AVAILABLE",
          creditAccount: "PLATFORM",
          type: "fee",
          idempotencyKey: `${idempotencyKey}-fee`,
          metadata: { offerId: o.offerId },
        });
      }
    } catch (error) {
      if (buyerLeg) {
        this.ledger.post({
          playerId: o.buyerId,
          amount: toSeller,
          debitAccount: "MATCH_ESCROW",
          creditAccount: "PLAYER_AVAILABLE",
          type: "refund",
          idempotencyKey: `${idempotencyKey}-compensate`,
          metadata: { offerId: o.offerId, reason: "settlement-aborted" },
        });
      }
      throw error;
    }
    this.deps.setOwner(o.kind, o.assetId, o.buyerId);
    this.settled.add(idempotencyKey);
  }

  private require(offerId: string): Offer {
    const o = this.offers.get(offerId);
    if (!o) throw new MarketplaceError("NOT_FOUND", "Offer not found.");
    return o;
  }
}

// ---- Auctions ----

export type AuctionStatus = "OPEN" | "SETTLED" | "CANCELLED" | "EXPIRED";

export interface Auction {
  id: string;
  auctionId: string;
  kind: MarketplaceAssetKind;
  assetId: string;
  sellerId: string;
  startingPrice: number;
  minIncrement: number;
  status: AuctionStatus;
  highestBid?: { bidderId: string; amount: number };
  endsAt: string;
  createdAt: string;
  winnerId?: string;
}

export class AuctionService {
  private readonly auctions = new Map<string, Auction>();
  private readonly settled = new Set<string>();

  constructor(
    private readonly ledger: DoubleEntryLedger,
    private readonly deps: {
      ownerOf: (kind: MarketplaceAssetKind, assetId: string) => string | undefined;
      setOwner: (kind: MarketplaceAssetKind, assetId: string, ownerId: string) => void;
    },
    /** Authoritative server time, injected so tests never race the wall clock. */
    private readonly now: () => number = () => Date.now(),
    private readonly feeBps = MARKETPLACE_FEE_BPS,
  ) {}

  create(params: {
    sellerId: string;
    kind: MarketplaceAssetKind;
    assetId: string;
    startingPrice: number;
    minIncrement: number;
    durationMs: number;
  }): Auction {
    if (!Number.isSafeInteger(params.startingPrice) || params.startingPrice <= 0) {
      throw new MarketplaceError("INVALID_PRICE", "startingPrice must be a positive integer.");
    }
    if (!Number.isSafeInteger(params.minIncrement) || params.minIncrement <= 0) {
      throw new MarketplaceError("INVALID_INCREMENT", "minIncrement must be a positive integer.");
    }
    if (params.durationMs <= 0) throw new MarketplaceError("INVALID_DURATION", "Auction duration must be positive.");
    if (this.deps.ownerOf(params.kind, params.assetId) !== params.sellerId) {
      throw new MarketplaceError("NOT_OWNER", "Seller does not own the asset.");
    }
    for (const a of this.auctions.values()) {
      if (a.status === "OPEN" && a.kind === params.kind && a.assetId === params.assetId) {
        throw new MarketplaceError("ALREADY_LISTED", "Asset is already in an open auction.");
      }
    }
    const now = this.now();
    const auction: Auction = {
      id: randomUUID(),
      auctionId: randomUUID(),
      kind: params.kind,
      assetId: params.assetId,
      sellerId: params.sellerId,
      startingPrice: params.startingPrice,
      minIncrement: params.minIncrement,
      status: "OPEN",
      endsAt: new Date(now + params.durationMs).toISOString(),
      createdAt: new Date(now).toISOString(),
    };
    this.auctions.set(auction.id, auction);
    return { ...auction };
  }

  /** Bids must be >= startingPrice and rise by at least minIncrement. */
  bid(auctionId: string, bidderId: string, amount: number): Auction {
    const a = this.require(auctionId);
    if (a.status !== "OPEN") throw new MarketplaceError("NOT_OPEN", `Auction is ${a.status}.`);
    if (Date.parse(a.endsAt) <= this.now()) {
      a.status = "EXPIRED";
      throw new MarketplaceError("EXPIRED", "Auction has ended.");
    }
    if (bidderId === a.sellerId) throw new MarketplaceError("SELF_BID", "Seller cannot bid on their own auction.");
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new MarketplaceError("INVALID_BID", "Bid must be a positive integer.");
    }
    const floor = a.highestBid ? a.highestBid.amount + a.minIncrement : a.startingPrice;
    if (amount < floor) {
      throw new MarketplaceError("BID_TOO_LOW", `Bid must be at least ${floor}.`);
    }
    if (this.ledger.balanceOf("PLAYER_AVAILABLE", bidderId) < amount) {
      throw new MarketplaceError("INSUFFICIENT_FUNDS", "Bidder lacks funds.");
    }
    a.highestBid = { bidderId, amount };
    return { ...a };
  }

  cancel(auctionId: string, actorId: string): Auction {
    const a = this.require(auctionId);
    if (a.status !== "OPEN") throw new MarketplaceError("NOT_OPEN", `Auction is ${a.status}.`);
    if (actorId !== a.sellerId) throw new MarketplaceError("NOT_SELLER", "Only the seller may cancel.");
    a.status = "CANCELLED";
    return { ...a };
  }

  /**
   * Finalize: highest bidder wins, or the asset stays with the seller.
   *
   * Settling is permitted for an auction that has merely *ended* (`OPEN` past
   * its deadline, or already flipped to `EXPIRED` by a late bid attempt): a
   * recorded highest bid must always be honoured, otherwise a winning bidder
   * could be denied settlement by bidding at the buzzer. `CANCELLED` and
   * `SETTLED` auctions are terminal and are not settleable again.
   */
  settle(auctionId: string, idempotencyKey: string): Auction {
    const a = this.require(auctionId);
    if (this.settled.has(idempotencyKey)) return { ...a };
    if (a.status === "SETTLED") return { ...a };
    if (a.status === "CANCELLED") throw new MarketplaceError("CANCELLED", "Auction was cancelled.");
    if (a.status !== "OPEN" && a.status !== "EXPIRED") {
      throw new MarketplaceError("NOT_OPEN", `Auction is ${a.status}.`);
    }
    if (!a.highestBid) {
      a.status = "EXPIRED";
      return { ...a };
    }
    const amount = a.highestBid.amount;
    const winner = a.highestBid.bidderId;
    if (this.deps.ownerOf(a.kind, a.assetId) !== a.sellerId) {
      throw new MarketplaceError("SELLER_NOT_OWNER", "Seller no longer owns the asset.");
    }
    if (this.ledger.balanceOf("PLAYER_AVAILABLE", winner) < amount) {
      throw new MarketplaceError("INSUFFICIENT_FUNDS", "Winner no longer has the funds.");
    }
    const fee = Math.floor((amount * this.feeBps) / 10000);
    const toSeller = amount - fee;
    let buyerLeg = false;
    try {
      this.ledger.post({
        playerId: winner,
        amount: toSeller,
        debitAccount: "PLAYER_AVAILABLE",
        creditAccount: "MATCH_ESCROW",
        type: "marketplace",
        idempotencyKey: `${idempotencyKey}-escrow`,
        metadata: { auctionId: a.auctionId },
      });
      buyerLeg = true;
      this.ledger.post({
        playerId: a.sellerId,
        amount: toSeller,
        debitAccount: "MATCH_ESCROW",
        creditAccount: "PLAYER_AVAILABLE",
        type: "marketplace",
        idempotencyKey: `${idempotencyKey}-seller`,
        metadata: { auctionId: a.auctionId, winnerId: winner },
      });
      if (fee > 0) {
        this.ledger.post({
          playerId: winner,
          amount: fee,
          debitAccount: "PLAYER_AVAILABLE",
          creditAccount: "PLATFORM",
          type: "fee",
          idempotencyKey: `${idempotencyKey}-fee`,
          metadata: { auctionId: a.auctionId },
        });
      }
    } catch (error) {
      if (buyerLeg) {
        this.ledger.post({
          playerId: winner,
          amount: toSeller,
          debitAccount: "MATCH_ESCROW",
          creditAccount: "PLAYER_AVAILABLE",
          type: "refund",
          idempotencyKey: `${idempotencyKey}-compensate`,
          metadata: { auctionId: a.auctionId, reason: "settlement-aborted" },
        });
      }
      throw error;
    }
    this.deps.setOwner(a.kind, a.assetId, winner);
    a.status = "SETTLED";
    a.winnerId = winner;
    this.settled.add(idempotencyKey);
    return { ...a };
  }

  get(auctionId: string): Auction | undefined {
    const a = this.auctions.get(auctionId);
    return a ? { ...a } : undefined;
  }

  listOpen(): Auction[] {
    return [...this.auctions.values()].filter((a) => a.status === "OPEN").map((a) => ({ ...a }));
  }

  private require(auctionId: string): Auction {
    const a = this.auctions.get(auctionId);
    if (!a) throw new MarketplaceError("NOT_FOUND", "Auction not found.");
    return a;
  }
}

// ---- Bundles (all-or-nothing) ----

export interface Bundle {
  id: string;
  bundleId: string;
  sellerId: string;
  items: Array<{ kind: MarketplaceAssetKind; assetId: string }>;
  price: number;
  status: "OPEN" | "SOLD" | "CANCELLED";
  createdAt: string;
}

export class BundleService {
  private readonly bundles = new Map<string, Bundle>();
  private readonly settled = new Set<string>();

  constructor(
    private readonly ledger: DoubleEntryLedger,
    private readonly deps: {
      ownerOf: (kind: MarketplaceAssetKind, assetId: string) => string | undefined;
      setOwner: (kind: MarketplaceAssetKind, assetId: string, ownerId: string) => void;
    },
    private readonly feeBps = MARKETPLACE_FEE_BPS,
  ) {}

  create(params: { sellerId: string; items: Array<{ kind: MarketplaceAssetKind; assetId: string }>; price: number; nowMs?: number }): Bundle {
    if (params.items.length < 2) throw new MarketplaceError("BUNDLE_TOO_SMALL", "A bundle needs at least two assets.");
    if (!Number.isSafeInteger(params.price) || params.price <= 0) {
      throw new MarketplaceError("INVALID_PRICE", "Bundle price must be a positive integer.");
    }
    const seen = new Set<string>();
    for (const item of params.items) {
      const key = `${item.kind}:${item.assetId}`;
      if (seen.has(key)) throw new MarketplaceError("DUPLICATE_ITEM", "Bundle contains a duplicate asset.");
      seen.add(key);
      if (this.deps.ownerOf(item.kind, item.assetId) !== params.sellerId) {
        throw new MarketplaceError("NOT_OWNER", `Seller does not own ${item.assetId}.`);
      }
    }
    const bundle: Bundle = {
      id: randomUUID(),
      bundleId: randomUUID(),
      sellerId: params.sellerId,
      items: params.items.map((i) => ({ ...i })),
      price: params.price,
      status: "OPEN",
      createdAt: new Date(params.nowMs ?? Date.now()).toISOString(),
    };
    this.bundles.set(bundle.id, bundle);
    return { ...bundle };
  }

  /**
   * Atomic purchase. Every item is validated BEFORE any ledger leg is posted,
   * and ownership transfer happens only after all legs succeed — so a bundle
   * can never settle partially.
   */
  buy(bundleId: string, buyerId: string, idempotencyKey: string): Bundle {
    const b = this.require(bundleId);
    if (this.settled.has(idempotencyKey)) return { ...b };
    if (b.status !== "OPEN") throw new MarketplaceError("NOT_OPEN", `Bundle is ${b.status}.`);
    if (buyerId === b.sellerId) throw new MarketplaceError("SELF_BUY", "Policy forbids buying your own bundle.");
    if (this.ledger.balanceOf("PLAYER_AVAILABLE", buyerId) < b.price) {
      throw new MarketplaceError("INSUFFICIENT_FUNDS", "Buyer lacks funds.");
    }
    // Pre-flight: every item must still be owned by the seller.
    for (const item of b.items) {
      if (this.deps.ownerOf(item.kind, item.assetId) !== b.sellerId) {
        throw new MarketplaceError("SELLER_NOT_OWNER", `Seller no longer owns ${item.assetId}.`);
      }
    }
    const fee = Math.floor((b.price * this.feeBps) / 10000);
    const toSeller = b.price - fee;
    let buyerLeg = false;
    try {
      this.ledger.post({
        playerId: buyerId,
        amount: toSeller,
        debitAccount: "PLAYER_AVAILABLE",
        creditAccount: "MATCH_ESCROW",
        type: "marketplace",
        idempotencyKey: `${idempotencyKey}-escrow`,
        metadata: { bundleId: b.bundleId },
      });
      buyerLeg = true;
      this.ledger.post({
        playerId: b.sellerId,
        amount: toSeller,
        debitAccount: "MATCH_ESCROW",
        creditAccount: "PLAYER_AVAILABLE",
        type: "marketplace",
        idempotencyKey: `${idempotencyKey}-seller`,
        metadata: { bundleId: b.bundleId, buyerId },
      });
      if (fee > 0) {
        this.ledger.post({
          playerId: buyerId,
          amount: fee,
          debitAccount: "PLAYER_AVAILABLE",
          creditAccount: "PLATFORM",
          type: "fee",
          idempotencyKey: `${idempotencyKey}-fee`,
          metadata: { bundleId: b.bundleId },
        });
      }
    } catch (error) {
      if (buyerLeg) {
        this.ledger.post({
          playerId: buyerId,
          amount: toSeller,
          debitAccount: "MATCH_ESCROW",
          creditAccount: "PLAYER_AVAILABLE",
          type: "refund",
          idempotencyKey: `${idempotencyKey}-compensate`,
          metadata: { bundleId: b.bundleId, reason: "settlement-aborted" },
        });
      }
      throw error;
    }
    // All legs posted: transfer every asset.
    for (const item of b.items) this.deps.setOwner(item.kind, item.assetId, buyerId);
    b.status = "SOLD";
    this.settled.add(idempotencyKey);
    return { ...b };
  }

  cancel(bundleId: string, sellerId: string): Bundle {
    const b = this.require(bundleId);
    if (b.status !== "OPEN") throw new MarketplaceError("NOT_OPEN", `Bundle is ${b.status}.`);
    if (b.sellerId !== sellerId) throw new MarketplaceError("NOT_SELLER", "Only the seller may cancel.");
    b.status = "CANCELLED";
    return { ...b };
  }

  get(bundleId: string): Bundle | undefined {
    const b = this.bundles.get(bundleId);
    return b ? { ...b } : undefined;
  }

  listOpen(): Bundle[] {
    return [...this.bundles.values()].filter((b) => b.status === "OPEN").map((b) => ({ ...b }));
  }

  private require(bundleId: string): Bundle {
    const b = this.bundles.get(bundleId);
    if (!b) throw new MarketplaceError("NOT_FOUND", "Bundle not found.");
    return b;
  }
}
