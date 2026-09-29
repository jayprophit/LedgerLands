# Simulation baseline: FFA_4 vs TEAM_2V2

**This is a recorded baseline, not a balance verdict.** No economic constant
was changed to produce it. The numbers below exist so that a future team
ruleset (shared treasury, shared property, different starting cash) can be
designed against evidence instead of intuition, exactly as the directive
requires.

Reproduce with:

```
npm run build
node scripts/simulate-teams.mjs              # 200 games per mode
TEAM_SIM_GAMES=500 node scripts/simulate-teams.mjs
```

Machine-readable: [`BASELINE_2V2.json`](./BASELINE_2V2.json).

## Setup

- 4 bots, identical policy in both modes: use the AI's choice when legal,
  otherwise buy when affordable with a 2,000 reserve, otherwise end the turn.
- Same seeds (`1 + n * 7919`) in both modes, so the comparison is paired.
- `TEAM_2V2` is `team-v1`: individual wallets, teammate rent exempt, team
  eliminated when all members are, last solvent team wins.
- 200 games per mode.

## Results

| Metric | FFA_4 | TEAM_2V2 |
|---|---|---|
| completion rate | 0.24 | 0.28 |
| average turns | 229.4 | 226.0 |
| median turns | 245 | 244 |
| bankruptcies per game | 1.195 | 0.925 |
| rent events per game | 118.00 | 76.71 |
| average rent charged | 229 | 223 |
| teammate rent exemptions | 0 | 8,205 |
| auctions completed | 606 | 622 |
| bids per auction | 0.99 | 0.97 |
| trades proposed | 0 | 0 |
| cards drawn | 6,656 | 6,552 |
| average top-holder property share | 0.587 | 0.522 |
| average team cash gap | n/a | 11,426 |

Winners:

- FFA_4 — p0 17, p1 10, p2 12, p3 9 (48 completed games; 152 unfinished)
- TEAM_2V2 — t1 30, t0 26 (56 completed games; 144 unfinished)

## What the numbers actually say

**Rent volume drops by about a third** (118 → 77 per game). That is the direct,
expected consequence of D1: a teammate landing on a partner's property pays
nothing, so a fifth of all would-be rent payments never happen. 8,205 exemptions
over 200 games is ~41 per game, which is the size of the effect.

**Bankruptcies drop** (1.195 → 0.925 per game) and the average top-holder
property share falls (0.587 → 0.522). Both point the same way: with a teammate
immune to rent, the leading player has fewer ways to be stripped, so the
distribution is less concentrated. This is the opposite of the usual
criticism of team play being degenerate, and it is worth noticing rather than
assuming.

**Match length is essentially unchanged** (229.4 → 226.0 average turns, median
245 → 244). The 2v2 format did not make games longer or shorter under this
policy.

**Win rates are close to even** (t0 26, t1 30 of 56). The two teams are
symmetric by construction — same seats, same policy, same rules — so a large gap
would have indicated a seating or fairness bug rather than a balance finding.
This is a sanity check, not a balance result.

**Completion rate is low in both modes** (~0.25). Over half of all games hit the
600-command safety limit without a winner. This is a property of the bot policy
and the 4-player board, not of team play, and it is present identically in FFA.
Any future ruleset comparison must hold the policy constant and read the
*relative* numbers, not the absolute ones.

## Limitations, stated rather than buried

1. **The bots never trade.** `tradesProposed` is 0 in both modes, so the D4
   decision that teammate trades are allowed through the ordinary path is
   covered by unit tests but **not exercised by this simulation**. The trade
   frequency metric exists in the script and is simply reporting zero. Adding
   bot trading is the highest-value next simulation work.
2. **Auctions are near-degenerate.** `bidsPerAuction` is ~1.0, meaning auctions
   usually end with the decliner bidding rather than with competition. So
   "teammate auction competition" is likewise untested by simulation.
3. **One policy, one difficulty.** All bots use the same decision function.
   Mirrored skill levels would be needed to model a real lobby.
4. **200 games is a small sample** for a property-trading game. The directive
   says not to rebalance from a handful of games; this is recorded as a starting
   point, not a conclusion, and nothing was tuned from it.
5. **No anti-collusion measurement.** D4 deliberately declines to invent
   anti-collusion rules until simulation shows they are needed. This baseline
   does not test teammate collusion, because the bots cannot collude.

## What would justify changing the constants

Nothing here yet. If a later run shows, for example, that teammate rent immunity
is worth more than ~20% of a team's income, a dedicated competitive ruleset
with per-player starting cash scaled to a 2-player total would be a reasonable
response. The measurement to make that call is the exemption count and the
rent-per-game ratio above, and both are reported for exactly that reason.
