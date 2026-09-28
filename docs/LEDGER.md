# Ledger — double-entry practice journal

Package: `packages/ledger` (`DoubleEntryLedger`). The API's legacy
single-sided `PracticeLedger` (`apps/api/src/ledger.ts`) remains for the
dev faucet; match settlement migrates to the double-entry journal.

## Principle

Never model money as a lone `balance -= amount`. Every movement posts one
balanced record with `debitAccount ≠ creditAccount` and a positive integer
amount. Balances are derived by summing postings.

## Accounts

`PLAYER_AVAILABLE` · `PLAYER_MATCH_LOCKED` · `MATCH_BANK` · `MATCH_ESCROW` ·
`PRIZE_POOL` · `REWARD_POOL` · `PLATFORM` · `WITHDRAWAL_PENDING`

## Posting shape

`transactionId, playerId?, matchId?, asset (SIM_SAT), amount,
debitAccount, creditAccount, type, timestamp, idempotencyKey, metadata?`

Entry types: deposit, entry_lock, entry_release, property_purchase, rent,
tax, card_effect, building, mortgage, unmortgage, auction_settlement,
trade_settlement, reward, quest_reward, login_reward, refund, withdrawal,
fee, adjustment.

## Guarantees

- Retried posts with the same `idempotencyKey` return the original legs
  without duplicating.
- `verifyInvariant()` checks every leg is positive-amount and cross-account.
- Tests (`packages/ledger/test/ledger.test.ts`, 3/3): balanced post +
  balance derivation, idempotent retry, rejection of zero/same-account posts.
- Engine-level conservation is separately tested (trade preserves the sum
  of player balances; purchases debit exactly the price).
