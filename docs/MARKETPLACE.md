# Marketplace (simulated)

Canonical description of the collectible marketplace. Implements
`packages/marketplace`. **Every value here is a simulated sat.** There is no
deposit, no withdrawal, and no real-money settlement path in this package.

## Settlement discipline

All four operation types settle through the same shape:

```
buyer PLAYER_AVAILABLE  →  MATCH_ESCROW   (amount − platform fee)
        MATCH_ESCROW     →  seller PLAYER_AVAILABLE
        buyer PLAYER_AVAILABLE  →  PLATFORM  (MARKETPLACE_FEE_BPS = 5%)
```

The escrow hop exists because the ledger requires distinct debit/credit
accounts on every leg. It nets to zero. If a leg fails after the buyer leg is
posted, a compensating `refund` leg returns the funds before the error
propagates — so a failed settlement never leaves money stranded.

Every operation takes a caller-supplied `idempotencyKey` that seeds the ledger
legs (`-escrow`, `-seller`, `-fee`, `-compensate`). Retrying the same operation
returns the prior result without paying twice.

## Operations

| Operation | File | Lifecycle |
|---|---|---|
| Listing | `index.ts` | `OPEN → SOLD / CANCELLED / EXPIRED` |
| Purchase | `index.ts` | one-shot, idempotent |
| Offer | `extensions.ts` | `OPEN → ACCEPTED / REJECTED / CANCELLED / EXPIRED` |
| Auction | `extensions.ts` | `OPEN → SETTLED / EXPIRED / CANCELLED` |
| Bundle | `extensions.ts` | `OPEN → SOLD / CANCELLED` |

## Offers

Buyer-initiated; the seller is derived from current ownership, so an offer can
never be directed at the wrong party. Validated at creation: positive price,
seller exists, buyer is not the seller, buyer can already cover the price.

The open offer **locks the asset**, so it cannot be listed, auctioned, or
bundled while reserved. The lock is released on accept, reject, cancel, or
expiry.

Acceptance re-validates everything (offer still open, not expired, seller still
owns, buyer still has funds) before settling, and refuses offers from anyone
other than a party to the offer.

## Auctions

- `startingPrice` and `minIncrement` must be positive integers.
- A bid must be at least `startingPrice`, or at least
  `highestBid + minIncrement`.
- The seller cannot bid; a bidder must have funds for the full bid.
- `endsAt` is computed from an **injected** clock, so tests never race the wall
  clock and settlement uses authoritative server time.
- A late bid is rejected and flips the auction to `EXPIRED` — **but a recorded
  highest bid is still settleable**. Bidding at the buzzer must not be able to
  deny the winner settlement. A `CANCELLED` auction is terminal and can never
  settle to a bidder.
- Settlement is idempotent across both the same and a different idempotency
  key: the auction is `SETTLED`, so no second payment is possible.

## Bundles

All-or-nothing. Two guarantees:

1. **Pre-flight**: every item is verified as still seller-owned *before* any
   ledger leg is posted.
2. **Post-settlement**: ownership is transferred only after every leg succeeds.

A bundle with a single item is rejected at creation, so a "bundle" can never be
a disguised single listing. Duplicate items within a bundle are rejected.

If the seller loses one item after listing, the purchase aborts with no money
moved and no asset transferred — asserted explicitly in the tests.

## Security checks

- Cannot buy your own listing, offer, or bundle.
- Cannot sell an asset you do not own, or one already listed / in an open
  auction / locked by an open offer.
- Invalid, zero, or negative prices are rejected everywhere.
- Stale (expired) offers and auctions are rejected.
- Double purchase is impossible: status moves to a terminal state.
- Ledger stays balanced across every operation type, including failures.

## Known gaps

- No real escrow custody; `MATCH_ESCROW` is an accounting route, not held funds.
- No listing fees, no royalty mechanism, no price history or provenance.
- No bundle discounts or per-item pricing.
- Auctions have no anti-sniping extension (no automatic re-open on a late bid).
- All state is in-memory; no persistence for listings, offers, or auctions.
