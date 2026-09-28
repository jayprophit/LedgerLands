# Game Rules — classic-v1

Ruleset: `classic-v1` · Board: `classic-v1-board-1` (40 tiles, original names).

## Economy (simulated sats)

- Pass Origin Gate: **+200**
- Network Levy (income tax): **min(200, 10% of balance)**
- Harbor Tithe (luxury tax): **75**
- Quarantine release fine: **50**
- Starting balances: starter 5,000 · standard 15,000 · high-roller 30,000
- Unmortgage cost: mortgage value + 10% (rounded up)

## Movement

Two six-sided dice. Doubles grant an extra roll (`pendingExtraRoll`).
Three consecutive doubles → Quarantine Hub. Passing Origin Gate credits 200.

## Detention (Quarantine Hub)

- Enter via Security Lock tile, Quarantine Order card, or 3× doubles.
- While detained, each ROLL turn increments `detentionTurns`:
  - doubles → released, then move normally;
  - 3rd failed attempt → pay 50 automatically, then move;
  - otherwise turn passes.
- `PAY_DETENTION_FINE` (50) or `USE_DETENTION_CARD` (pardon chip) releases outside the roll flow.

## Properties

Each purchasable tile has `purchasePrice`, `houseCost`, `rentByDevelopment[0..5]`
(level 5 = hotel-equivalent), `mortgageValue = floor(price/2)`.

- Rent: base level rate; level-0 rent **×2** when owner holds the full group (monopoly).
- Transit rent: **250 × transits owned**. Service rent: **150 × services owned**.
- Mortgaged properties charge **no rent**.
- Building requires: full group ownership, property not mortgaged, even-building
  (no property more than 1 level above its lowest sibling), funds, below max level.
- Mortgage requires: owned, not mortgaged, development 0. Unmortgage requires funds for value+10%.

## Auctions

`DECLINE_PROPERTY` (or `START_AUCTION`) opens a single active auction.
`PLACE_BID` must exceed current highest and be within balance.
`PASS_AUCTION` records a pass. `COMPLETE_AUCTION` settles to highest bidder or
closes empty. Auctions persist across turns so multiplayer timers can be added.

## Trades

`PROPOSE_TRADE` (sats + property ids each side) → `ACCEPTED`/`REJECTED`/`CANCELLED`.
Validation at propose AND accept: ownership, no developed properties in the
transfer, sufficient sats. Settlement is atomic. Bankrupt players' pending
trades auto-cancel.

## Event cards (Signal deck, 12 original cards)

Drawn on EVENT tiles, deterministic from match seed + rng state:
Signal Boost +100, Grid Dividend +50, Cache Found +150, Drift Bonus +75,
Founder Grant +200, Toll Audit −75, Relay Maintenance −50, Spectrum Fee −100,
Tailwind +3 spaces, Headwind −3 spaces, Quarantine Order (go to jail),
Pardon Chip (keep; frees from detention once).

## Bankruptcy & winning

Any balance dropping below 0 triggers settlement:
debt to a player → properties transfer to the creditor;
debt to the bank → properties return to the bank undeveloped.
Last solvent player in a 2+ player match wins (`MATCH_COMPLETED`).
Solo matches end by surrender or mutual agreement in the client.

## Commands / events

See `packages/shared-types/src/index.ts` for the full `GameCommand` /
`GameEvent` unions. State is reconstructable from `seed + command list`
(`replayCommands`); every mutation appends revisioned events.
