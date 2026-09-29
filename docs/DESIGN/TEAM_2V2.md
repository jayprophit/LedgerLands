# Design: 2v2 team play

Status: **OWNER-RESOLVED AND IMPLEMENTED.** D1–D5 were decided by the owner and
shipped as ruleset `team-v1`. This document is now the record of what was
decided and why, not a list of open questions. Simulation evidence lives in
[`docs/simulation/TEAM_2V2_BASELINE.md`](../simulation/TEAM_2V2_BASELINE.md).

Implementation: `packages/game-engine/src/teams.ts` (the rules),
`packages/game-engine/src/rules.ts` (`team-v1`), `test/teams.test.ts` (matrix).

## The principle everything follows from

**A player owns the economy. A team owns the victory.**

```text
Player                    Team
├── wallet/balance         ├── teamId
├── properties             ├── member player ids
├── mortgages              ├── eliminated state
├── developments           └── victory relationship
├── jail state
├── bankruptcy state
└── turn state
```

No shared wallet. No shared property. There is no code path that could pool
either, and tests assert that a teammate cannot mortgage, develop, or buy
something the partner owns.

## Resolved decisions

### D1 — Rent attribution: individual ownership, teammate rent exempt

Property belongs to the individual player who owns it. An opponent landing on it
pays the owner in full. A teammate landing on it pays **nothing**, and the
exemption is recorded as a `TEAMMATE_RENT_EXEMPT` event.

Rationale: silently skipping the transfer would make a no-op indistinguishable
from a bug in an audit trail, and a dispute about who owes what has to be
answerable from the event log alone.

### D2 — Bankruptcy: individual, creditor-aware

A player can go bankrupt without eliminating their team. Assets resolve under the
existing creditor-aware rules: the estate goes to the creditor that was owed, or
returns to the bank if there is none. **A bankrupt player's estate never goes to
their teammate.**

The team is eliminated only when every member is out. Both elimination paths
(bankruptcy and surrender) share one helper so they cannot drift apart.

### D3 — Victory: last solvent team

A team wins when every player on every opposing team is eliminated. A1 bankrupt
with A2 active leaves Team A alive. Both out eliminates it.

No timed or score-based victory is implemented. If one is added it needs its own
ruleset version rather than an implicit fallback.

### D4 — Auctions and trades: individual participation, normal commands

Everyone, teammates included, bids and settles as themselves. Teammates may
trade, through the ordinary propose → validate → accept path. There is no direct
asset-gifting command and no privileged team-transfer endpoint, so every
transaction is recorded for replay and audit.

No anti-collusion rules are implemented. Inventing them without evidence would be
guesswork; the simulation baseline is the evidence that should drive them.

### D5 — Starting balance: full standard balance per player

Each of the four players starts with the full ruleset balance. 2v2 therefore
begins as **four individual players with two victory teams** — deliberately, and
deliberately *not* claimed to be balanced.

## The rule set is explicit, not scattered

```ts
// team-v1
teamRules: {
  economy: "INDIVIDUAL",
  propertyOwnership: "INDIVIDUAL",
  teammateRent: "EXEMPT",
  bankruptcy: "INDIVIDUAL",
  elimination: "ALL_MEMBERS",
  victory: "LAST_SOLVENT_TEAM",
  auctionParticipation: "INDIVIDUAL",
  teammateTrading: "ALLOWED",
  startingBalance: "STANDARD_PER_PLAYER",
}
```

Its **absence** from every other ruleset is the switch. A match with no `teams`
cannot trigger a team rule, which is why all 19 oracle goldens and the
clone-equivalence suite were unaffected by this work.

## Seating

Alternating by team: **A1 B1 A2 B2**, not A1 A2 B1 B2. Fewer consecutive
teammate turns, and a cleaner competitive baseline. The seat order is
authoritative state (the `players` array), not a presentation concern, and
`validateTeams` refuses a roster that would place teammates adjacently.

Matchmaking splits a matched group deterministically, taking alternating entries
so the two highest-rated candidates face each other. Party play (queueing with a
specific partner) is not implemented.

## Downstream

- **Ranked:** a team win converts to four individual results, one per member.
  Not a shared pool, not half the delta — both are defensible with no evidence
  behind them, and a pool would make teammates indistinguishable in a
  leaderboard. An eliminated player keeps a blank rating.
- **Matchmaking:** `TEAM_2V2` forms groups of four and passes `teams` to the
  match factory. `MatchFactory` receives `teams: []` for every other queue, so a
  1v1 cannot be mistaken for a team match.
- **Tournaments:** not integrated. A bracket round assumes one match per pair of
  participants; a 2v2 round is four participants with a team result. This needs
  its own format rather than a reuse of the existing one.

## Preserved for later, not implemented

`SHARED_TREASURY`, `SHARED_PROPERTY`, `TEAM_LOANS`, `TEAM_ASSIST`,
`TEAM_BUILDING`. Each is a new value of a `TeamRules` field, not a new engine
branch. The first implementation remains individual economy plus shared victory.

## Known gaps

1. **No party/duo queueing.** Teams are formed by the matcher, not chosen.
2. **No rating band for `TEAM_2V2`.** `compatible()` applies skill bands to
   `RANKED_1V1` only, so four players of any rating can be grouped. A ranked 2v2
   needs its own queue; this should not be changed silently.
3. **Bots do not trade, and auctions are near-degenerate** (≈1.0 bids per
   auction). D4's teammate-trade and teammate-auction decisions are covered by
   unit tests but **not** by simulation. Adding bot trading is the highest-value
   next simulation work.
4. **No tournament format for team rounds.**
5. **Balance is a baseline, not a result.** 200 paired games per mode. The
   measured effect of teammate rent immunity is a ~35% drop in rent events per
   game and a ~23% drop in bankruptcies per game. Nothing has been tuned in
   response, and nothing should be until the bot trade and auction gaps are
   closed.
