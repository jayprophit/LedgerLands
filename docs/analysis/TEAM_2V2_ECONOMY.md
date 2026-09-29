# TEAM_2V2 economy: what the cooperation actually produces

Paired experiment, 1000 games per arm, difficulty NORMAL, 1500 starting balance per
player. Game *n* uses the same seed in both arms, so the arms differ **only** by the
`team-v1` rules. Raw output: `TEAM_2V2_ECONOMY.json`. Reproduce with
`npm run build && TEAM_GAMES=1000 node scripts/team-economy.mjs`.

This is evidence for a decision about D1-D5, not a decision. Nothing here changes the
rules, and nothing here prohibits a strategy that turns out to be legal.

## Headline

| | FFA_4 | TEAM_2V2 |
| --- | --- | --- |
| games | 1000 | 1000 |
| completed | 971 (97.1%) | 931 (93.1%) |
| bankruptcies per game | 2.97 | 2.01 |
| rent per game | 56.4 | 45.5 |
| teammate rent exemptions | 0 | 23,453 (23.5/game) |
| trade proposals | 2,019 | 8,474 |
| trade accept rate | 60.9% | 83.0% |
| teammate trades | 0 | 6,250 |
| auctions started | 20,986 | 20,645 |
| bids per auction | 4.05 | 4.43 |
| avg top-holder share of property | 0.988 | 0.721 |

The headline is the last row. In FFA a single player ends up holding essentially the
whole board (0.988). In 2v2 the largest holder averages 0.721, and the largest single
*team member* holds 0.750 of their own team's property. Teammates accumulate a lot
together — that is the point of the mode — but the result is not a monopoly held by one
player.

## Is the cooperation degenerate?

Four probes, counted rather than prohibited.

**Carry player (funneling).** Real but bounded. The average largest member holds 75% of
the team's property and 68% of its cash, with 57% of sets concentrated on one member.
That is a meaningfully designated player, not a rounding error. It is also not a
runaway: no member reaches the 0.988 concentration FFA produces.

**Circular zero-sum swapping.** 2,981 circular pairs across 1000 games, ~3 per game.
A circular pair is A→B then B→A returning assets to their origin. The valuation models
differ per owner, so both sides can rationally want the swap, but a closed loop moves
nothing and costs two turns. It is a real inefficiency, at low enough frequency not to
dominate.

**Sacrificial trades.** 1,630 (1.63/game), moving 2.35M sats. These are trades where
one side knowingly gives up more board value than it receives, and 78 of them happened
on teams that went on to win. This is the clearest genuinely degenerate behaviour in the
data. Whether tightening the mutual-benefit price band would remove them is untested —
I attempted that probe and it did not change the outcome, so the sensitivity is an open
question rather than a finding.

**Teammate auction rivalry.** 12,183 auctions (59% of all auctions) involved both
teammates bidding, destroying 6.05M sats. Under D4 teammates bid against each other
because auctions are individual. This is the single largest sats sink in the entire
experiment — more than three times the value moved by sacrificial trades. Bots cap
their own bids, which is why it terminates, but the cap is a bot behaviour and not a
rule.

## Where the numbers are fragile

- **Completion is 93% for TEAM, not 100%.** Games that hit the command safety cap are
  counted as incomplete. The residue is auction-heavy.
- **A 30,000 starting balance makes auctions impossible** and was the original
  parameter. Bots could always afford any tile, so none ever declined and no auction
  opened, and the entire D4 dimension measured zero for a reason unrelated to team
  rules. Everything above uses 1500. `TEAM_BALANCE` overrides it. This is the most
  important knob in the experiment and it was wrong at first.
- **The trade rate is a policy artifact, not a game property.** The bots only propose
  mutually beneficial trades and refuse to re-propose a rejected one, so the accept
  rate reflects that filter, not the market.
- **336 of 20,645 TEAM auctions never completed.** Those are still open at the safety
  cap, and they are the bulk of why completion is 93% rather than 100%.

## Bugs this experiment found

Every one of these produced a plausible-looking number and no test failure.

1. **The AI never declined.** `actionsThisTurn` treated `PROPERTY_OFFERED` as "already
   declined", but the engine emits that when a player *lands* on unowned land. The
   decline branch was dead code, so no auction could ever open. Now keyed on
   `AUCTION_STARTED`.
2. **Auctions deadlocked.** A bot that would not raise simply ended its turn and stayed
   in the auction, so nobody was ever out and the match hung. Fixed with `PASS_AUCTION`.
3. **The simulator hid AI failures.** The driver swallowed illegal AI commands in an
   empty `catch`, so an AI whose every develop was illegal produced a clean-looking
   run. Rejections are now counted and reported per command type.
4. **Develop was offered illegally** for tiles in incomplete groups; the engine
   refused it every time and nothing said so.
5. **`cashValueFor` was difficulty-dependent**, so a tile and a sat were worth different
   amounts depending on who was asking, and "was that trade good?" stopped being
   answerable. Values are now computed at a reference difficulty; difficulty only
   changes tolerance.
6. **The suffix read path was broken and a test asserted the breakage.** The engine
   advances `revision` only when a command emits an event, so accepted no-event commands
   share a `resultRevision`. `suffixIsComplete` required *strictly* increasing
   revisions, so valid suffixes were rejected and every rebuild fell back to full
   replay. `MemoryBackend` and `FileBackend` also ignored `afterSeq` entirely and
   filtered on revision alone, and `snapshot-boundary.test.ts` had a test named
   "MemoryBackend cannot mask Postgres range bugs" asserting that limitation — with a
   comment saying such a change should fail the test and be rewritten. It did. All three
   backends now select on the storage sequence.

Item 6 is the one that mattered most beyond this task: the fast suffix path was dead in
production, so every match rebuild was paying for a full replay.

## Recommendation

Nothing in this data argues for changing D1-D5. Teammate rent exemption measurably
changes outcomes (fewer bankruptcies, 0.988 → 0.721 concentration) without producing a
single-player monopoly.

Two things are worth an owner decision, neither of which is a rule change:

- **Teammate auction rivalry destroys more sats than anything else measured** (6.05M vs
  2.35M for sacrificial trades). If that is unacceptable, the fix is a rule (shared
  bidding pool, or a team cap) — not a bot adjustment, which is already doing its best.
- **Sacrificial trades may be a policy artifact.** The bots only propose trades they
  score as mutually beneficial, so what counts as "sacrificial" is partly a function of
  the valuation model. Worth measuring deliberately rather than inheriting.
