# Tournaments

Canonical description of the tournament domain. Implements
`packages/tournaments`. All prize settlement is **simulated sat** through the
double-entry ledger.

## Shared lifecycle

Every format shares one state machine:

```
DRAFT → REGISTRATION → LOCKED → ACTIVE → SETTLING → COMPLETED
                                  ↘ CANCELLED / REFUNDED / DISPUTED
```

Shared across formats: participants, lifecycle, prize settlement, disputes,
cancellation, and authoritative match references. `reportResult(id, matchId, winnerId)`
is the single write path for results in all four formats, so audit, replay and
dispute tooling is identical regardless of format.

## Formats

| Format | Structure | State it owns |
|---|---|---|
| `SINGLE_ELIMINATION` | seed-ordered bracket, byes for non-power-of-two | `bracket` |
| `DOUBLE_ELIMINATION` | winners bracket + losers ladder + grand final | `bracket`, `eliminated`, `losersPool` |
| `SWISS` | per-round pairings from standings | `swiss` (points, opponents, byes) |
| `ROUND_ROBIN` | circle-method fixture list | `roundRobin` (all fixtures, reported per round) |

Elimination formats share `BracketMatch.targetMatchId` for explicit, replayable
advancement. Swiss and round robin genuinely differ, so they carry their own
state rather than being forced into a common bracket shape — but each round is
still materialised as `BracketMatch` rows tagged with its `bracket` side, so
results are reported by the same match id and every result has the same audit
trail.

## Single elimination

Seed order = registration order. Non-power-of-two entry counts get byes: the
draw fills sequentially, so byes fall to the end of registration. Bye matches are
pre-decided at lock and flagged `bye: true`, so an auditor never sees them as
played matches. Verified for 2, 3, 4, 5, 6, 7, 8, 9 and 16 players.

## Double elimination

- Winners bracket = the single-elim skeleton, tagged `WINNERS`.
- Losers bracket matches are created **on demand** from a losers pool rather than
  pre-sized shells, so the ladder is exact for any entry count and every losers
  match is a real reported result.
- A second loss eliminates. The losers-bracket champion is staged into the grand
  final against the last unbeaten player.
- **Only the grand final crowns a champion.** A winners-bracket win is explicitly
  not a title.
- Single grand-final match; bracket reset is a documented follow-up.

## Swiss

Config: `rounds`, `pointsWin`, `pointsDraw`, `pointsLoss`, `pointsBye`
(defaults 3 / 3 / 1 / 0 / 3). Validated at create; `loss ≤ draw ≤ win` and
`pointsBye ≥ 0`.

**Pairing**

1. Round 1 mirrors top and bottom halves by seed (`firstRoundPairs`).
2. Later rounds pair within score groups, preferring opponents not yet faced.
3. A controlled float to the nearest score group is allowed when a group cannot
   be paired without a repeat.
4. Ties broken by the documented standings order, then by seed.

**Tiebreaks (deterministic, documented, and relied on by tests)**

1. match points
2. Buchholz — sum of opponents' current points
3. wins
4. seed order at lock (lower is better)

No randomness anywhere: the same results always produce the same standings.

**Byes**

- At most one per player, tracked with `hadBye` and recorded per round in
  `byeHistory`.
- A bye awards `pointsBye` (default = a full win) and **produces no financial
  leg** — it is not an entry, a payout, or a phantom participant.

## Round robin

Circle method: fix one participant, rotate the rest. Produces `n-1` rounds for
even `n`, each participant meeting every other exactly once — no duplicate
pairing within a cycle (asserted in tests, `C(4,2) = 6` distinct fixtures).

Odd fields get a `__BYE__` placeholder that never appears as a participant; each
bye is a real `b: undefined` fixture. A round advances only once every fixture
in it is decided, so a partial round cannot corrupt standings.

Standings: points, then wins, then seed.

## Settlement

`settle()` pays from `PRIZE_POOL` to first and second only, with the remainder
going to the champion so the pool is fully distributed and idempotency keys
(`tny-payout-<tournament>-<player>`) make retries safe. Refunds on cancel use
`PRIZE_POOL → PLAYER_AVAILABLE` with the same key discipline.

Verified invariant across all formats: payouts total the pool, at most two
players are paid, and the ledger stays balanced.

## Known gaps

- No grand-final bracket reset for double elimination.
- Swiss pairing is deterministic and repeat-avoiding but not theory-optimal
  (no float-down preference, no colour/rating seeding beyond lock order).
- No seeding input from ratings; seed order is registration order.
- No live-PostgreSQL persistence for tournament state (in-memory only).
