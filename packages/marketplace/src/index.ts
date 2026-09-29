import { randomUUID } from "node:crypto";
import { DoubleEntryLedger } from "@ledgerlands/ledger";

/**
 * Simulated marketplace sandbox. No real money: every purchase settles
 * atomically through the double-entry ledger (buyer debit, seller credit,
 * asset transfer, optional platform fee) with idempotency keys.
 */

export type MarketplaceAssetKind = "collectible-token" | "cosmetic" | "board-theme" | "dice";
export type ListingStatus = "OPEN" | "SOLD" | "CANCELLED" | "EXPIRED";

export interface MarketplaceListing {
  id: string;
  sellerId: string;
  assetKind: MarketplaceAssetKind;
  assetId: string;
  price: number;
  status: ListingStatus;
  createdAt: string;
  expiresAt?: string;
}

export const MARKETPLACE_FEE_BPS = 500; // 5% to PLATFORM

export class MarketplaceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "MarketplaceError";
    this.code = code;
  }
}

export class MarketplaceService {
  private readonly listings = new Map<string, MarketplaceListing>();
  private readonly assets = new Map<string, string>(); // assetKey -> ownerId
  private readonly settledKeys = new Set<string>();
  constructor(private readonly ledger = new DoubleEntryLedger()) {}

  assetKey(kind: MarketplaceAssetKind, assetId: string): string {
    return `${kind}:${assetId}`;
  }

  /** Sandbox seeding: register asset ownership (stands in for inventory/NFT ownership). */
  registerAsset(kind: MarketplaceAssetKind, assetId: string, ownerId: string): void {
    this.assets.set(this.assetKey(kind, assetId), ownerId);
  }

  ownerOf(kind: MarketplaceAssetKind, assetId: string): string | undefined {
    return this.assets.get(this.assetKey(kind, assetId));
  }

  list(sellerId: string, kind: MarketplaceAssetKind, assetId: string, price: number, opts?: { expiresAt?: string }): MarketplaceListing {
    if (!Number.isSafeInteger(price) || price <= 0) throw new MarketplaceError("INVALID_PRICE", "Price must be a positive integer.");
    const key = this.assetKey(kind, assetId);
    if (this.assets.get(key) !== sellerId) throw new MarketplaceError("NOT_OWNER", "Seller does not own this asset.");
    for (const l of this.listings.values()) {
      if (l.status === "OPEN" && l.assetKind === kind && l.assetId === assetId) {
        throw new MarketplaceError("ALREADY_LISTED", "Asset is already listed.");
      }
    }
    const listing: MarketplaceListing = {
      id: randomUUID(),
      sellerId,
      assetKind: kind,
      assetId,
      price,
      status: "OPEN",
      createdAt: new Date().toISOString(),
      ...(opts?.expiresAt ? { expiresAt: opts.expiresAt } : {}),
    };
    this.listings.set(listing.id, listing);
    return { ...listing };
  }

  cancel(listingId: string, sellerId: string): MarketplaceListing {
    const l = this.require(listingId);
    if (l.sellerId !== sellerId) throw new MarketplaceError("NOT_SELLER", "Only the seller may cancel.");
    if (l.status !== "OPEN") throw new MarketplaceError("NOT_OPEN", "Listing is not open.");
    l.status = "CANCELLED";
    return { ...l };
  }

  /**
   * Atomic purchase: validate everything, then settle ledger legs + transfer.
   * Retries with the same idempotencyKey return the prior result once only.
   */
  buy(buyerId: string, listingId: string, idempotencyKey: string): MarketplaceListing {
    const l = this.require(listingId);
    if (this.settledKeys.has(idempotencyKey)) return { ...l };
    if (l.status !== "OPEN") throw new MarketplaceError("NOT_OPEN", "Listing is not open.");
    if (l.expiresAt && Date.parse(l.expiresAt) <= Date.now()) {
      l.status = "EXPIRED";
      throw new MarketplaceError("EXPIRED", "Listing has expired.");
    }
    if (buyerId === l.sellerId) throw new MarketplaceError("SELF_BUY", "Policy forbids buying your own listing.");
    if (this.assets.get(this.assetKey(l.assetKind, l.assetId)) !== l.sellerId) {
      throw new MarketplaceError("SELLER_NOT_OWNER", "Seller no longer owns this asset.");
    }
    const buyerFunds = this.ledger.balanceOf("PLAYER_AVAILABLE", buyerId);
    if (buyerFunds < l.price) throw new MarketplaceError("INSUFFICIENT_FUNDS", "Buyer lacks funds.");
    const fee = Math.floor((l.price * MARKETPLACE_FEE_BPS) / 10000);
    const toSeller = l.price - fee;
    // Peer transfer routes through MATCH_ESCROW (net zero) because ledger legs
    // require distinct debit/credit accounts. On mid-settlement failure, the
    // buyer leg is compensated back before the error propagates.
    let buyerLegCommitted = false;
    try {
      this.ledger.post({
        playerId: buyerId,
        amount: toSeller,
        debitAccount: "PLAYER_AVAILABLE",
        creditAccount: "MATCH_ESCROW",
        type: "marketplace",
        idempotencyKey: `${idempotencyKey}-escrow`,
        metadata: { listingId, sellerId: l.sellerId },
      });
      buyerLegCommitted = true;
      this.ledger.post({
        playerId: l.sellerId,
        amount: toSeller,
        debitAccount: "MATCH_ESCROW",
        creditAccount: "PLAYER_AVAILABLE",
        type: "marketplace",
        idempotencyKey: `${idempotencyKey}-seller`,
        metadata: { listingId, buyerId },
      });
      if (fee > 0) {
        this.ledger.post({
          playerId: buyerId,
          amount: fee,
          debitAccount: "PLAYER_AVAILABLE",
          creditAccount: "PLATFORM",
          type: "fee",
          idempotencyKey: `${idempotencyKey}-fee`,
          metadata: { listingId },
        });
      }
    } catch (error) {
      if (buyerLegCommitted) {
        this.ledger.post({
          playerId: buyerId,
          amount: toSeller,
          debitAccount: "MATCH_ESCROW",
          creditAccount: "PLAYER_AVAILABLE",
          type: "refund",
          idempotencyKey: `${idempotencyKey}-compensate`,
          metadata: { listingId, reason: "settlement-aborted" },
        });
      }
      throw error;
    }
    this.assets.set(this.assetKey(l.assetKind, l.assetId), buyerId);
    l.status = "SOLD";
    this.settledKeys.add(idempotencyKey);
    return { ...l };
  }

  sweepExpired(nowMs = Date.now()): number {
    let n = 0;
    for (const l of this.listings.values()) {
      if (l.status === "OPEN" && l.expiresAt && Date.parse(l.expiresAt) <= nowMs) {
        l.status = "EXPIRED";
        n += 1;
      }
    }
    return n;
  }

  get(listingId: string): MarketplaceListing | undefined {
    const l = this.listings.get(listingId);
    return l ? { ...l } : undefined;
  }

  listOpen(): MarketplaceListing[] {
    return [...this.listings.values()].filter((l) => l.status === "OPEN").map((l) => ({ ...l }));
  }

  private require(listingId: string): MarketplaceListing {
    const l = this.listings.get(listingId);
    if (!l) throw new MarketplaceError("NOT_FOUND", "Listing not found.");
    return l;
  }
}
