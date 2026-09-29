# Design: 2v2 team play

Status: **PROPOSED — awaiting owner decision.** No engine code has been
changed. This document exists because the team model changes the economics, the
win condition, and the ruleset version, and those are product decisions, not
implementation details.

## Why this cannot be bolted on

`packages/game-engine` currently assumes one thing about players everywhere:

- `PlayerState.ownerId` is a `PlayerId` (`packages/shared-types/src/index.ts:43`)
- `MatchState.players` is a flat `PlayerState[]`; the turn is
  `currentPlayerIndex` into that array (`engine.ts:363`)
- bankruptcy and the win condition are per-player: a match ends when
  `active.length <= 1` (`engine.ts:357`)
- the engine hard-rejects anything other than 1–4 players (`engine.ts:54`)

Team play touches all four. Every one of those is used by auctions, trades,
rent, mortgages, and the replay hash chain, so a partial change would produce
matches that replay inconsistently. The ruleset must be a new version
(`team-v1`), not a variant of `classic-v1`, so old replays keep replaying
identically.

## Open decisions

These are the questions that must be answered before implementation. Each has a
recommendation, and the recommendation is not a decision.

### D1. Rent and tax attribution

A team collects rent from a team-monopoly tile. Who is credited?

- (a) the **team pool** — a shared team balance, spent by either member.
- (b) the **landlord's opponent** — credited to the *player* who lands, so a
  team-mate can never be enriched by a good roll.
- (c) **split** evenly across the whole team.

Recommendation: **(b)**. A shared pool is the single most likely source of
partner-abuse exploits: one member spends money the other earned, and a
dispute about it is unresolvable from the event log alone. (b) keeps every
ledger line attributable to one `playerId`, which the existing double-entry
journal and the trade/auction validation already assume.

### D2. Team bankruptcy

If one member goes bankrupt, what happens?

- (a) team is eliminated;
- (b) the member is replaced by a bot and the team continues;
- (c) the team continues with a reduced roster (no replacement).

Recommendation: **(a)**, elimination, with the *other* team's members still
required to be active for the match to end. Rationale: (b) and (c) both need a
roster-mutation path inside the event-sourced turn loop, which means an
insertion into `MatchState.players` and a re-index of `currentPlayerIndex` — a
replay-divergence risk for very little gameplay value in a play-money game.

### D3. Winning

- (a) **last team standing** (both opponents eliminated);
- (b) **net worth at a turn limit**;
- (c) both.

Recommendation: **(a)** as the primary, with (b) only as a tiebreak when a turn
limit is configured. A turn limit is a safety valve for stalls, not a scoring
mode; making it a scoring mode means the interesting play is "stall until turn
N", which is a worse game than the one being designed.

### D4. Bids, trades, and mortgages

Can a team bid on an auction, or is that individual-only?

Recommendation: **individual-only, first version.** Teammate collusion at an
auction is trivially exploitable (bid for a property your partner will not pay
for, to deny the other team), and the anti-collusion analysis is a project in
itself. A team that wants a property buys it or trades for it.

### D5. Starting balances

- (a) same per player (4 × 15000 = 60000 total);
- (b) scaled down per player so the *team* total matches a 2-player game
  (4 × 7500).

Recommendation: **(a)** for the first implementation, and document the
divergence. Teams are stronger than individuals (rent income is collected
faster with four pieces on the board), so the balance is the tuning knob, not
the starting balance. Lowering it makes a 2v2 match feel punishing without
fixing anything. Revisit once win-rate data exists.

## Recommended shape if approved

```
interface TeamState {
  id: TeamId;
  memberIds: [PlayerId, PlayerId];
}

MatchState.teams?: TeamState[];         // absent for 1–4 individual play
Ruleset.version: "team-v1";
```

- A match with `teams` is either 2v2 (4 players) or **1v1** (2 players), so the
  team code path is exercised by a two-player match and does not need four
  humans to test.
- `PlayerState` is unchanged. Teams are an overlay, not a replacement — this
  keeps 1–4 individual play, ranked, and every existing replay valid.
- Team rules are resolved through a single pure function
  (`teamOf(playerId, match)`, `isOpposingTeam(a, b, match)`) so no rent or
  auction path grows a conditional of its own.

## Sequencing

1. Owner answers D1–D5. Nothing is implemented before that.
2. `team-v1` ruleset + `teams` on `MatchState`, behind the same engine.
3. `isOpposingTeam` gate in rent, auctions, and trades; D4 if individual-only.
4. Team-aware win condition (D3) and elimination (D2).
5. Tests first: team rent attribution, team elimination, cross-team trade
   refusal, and a **replay determinism test** that a seeded 2v2 match replays
   to an identical state hash.
6. Playwright: a bot-only 2v2 match end to end.

## Cost, stated honestly

This is a larger change than the marketplace extension. It touches the engine's
central state shape, the win condition, the rent path, and the ruleset registry,
and it needs its own determinism proof. The live-PostgreSQL gate is still open
and unrelated to it, so this does not unblock anything else.

The cheaper alternative, if 2v2 is a nice-to-have rather than a requirement: keep
individual play as the shipped mode and treat teams as a future ruleset
(`team-v1`) once the persistence layer is verified against a live database.
That ordering gets both, in the order that de-risks more per unit of work.
