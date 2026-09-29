# Authentication

Canonical description of identity. Implements `packages/auth`.

**LedgerLands has no production identity provider.** The only adapter that
actually issues sessions is a development adapter, and the production guard
exists precisely to stop that from being mistaken for real authentication.

## Modules

| File | Responsibility |
|---|---|
| `core.ts` | identity model (`AuthPrincipal`) + `DevAuthAdapter` |
| `providers.ts` | inert and mock adapters for the future provider set |
| `service.ts` | session composition, MFA boundary, `ProductionGuard` |

## Identity model

```
AuthPrincipal
  principalId   stable account identity
  playerId      stable in-game identity — commands authorize against THIS,
                never a raw browser-supplied id
  sessionId     one login
  roles         player | moderator | admin
  provider      dev | email | google | apple | wallet | passkey | aetherius
  issuedAt / expiresAt
```

Authentication is kept entirely separate from game-engine state. The engine
never sees a provider, a token, or a role.

## DevAuthAdapter (DEVELOPMENT ONLY)

Issues HMAC-signed opaque sessions with **no password, no second factor, and no
KYC**. The secret defaults to a random per-process value, so sessions die with
the process unless `LEDGERLANDS_DEV_SECRET` is set. Tokens look like
`lld1.<sessionId>.<hmac>`; the HMAC is compared in constant time, and a
tampered, expired, or revoked token resolves to `null`.

## Provider set (architecture only)

`providers.ts` contains one adapter per intended provider:

- `NotConfiguredAdapter` — inert by construction. An unconfigured provider
  **cannot** authenticate anyone.
- `MockFederatedAdapter` — Google / Apple / Aetherius / email, for composing and
  testing session logic without contacting a provider.
- `MockWalletAdapter` — stands in for a signed wallet challenge-response
  (address normalisation is lowercased here; real deployments need EIP-55
  checksum validation).
- `MockPasskeyAdapter` — stands in for a WebAuthn assertion; no challenge
  ceremony is implemented.

None of these is an integration. Replacing them is future work.

## Production guard

The safeguard that matters:

- `assertNoDevAuth(adapters)` throws `DEV_AUTH_IN_PRODUCTION` if any dev adapter
  is present while `policy.production` is true.
- A production profile with no non-dev provider configured throws
  `NO_PRODUCTION_PROVIDER`.
- `assertProviderAllowed` rejects a provider outside the policy, and rejects
  `dev` outright in production.
- The API **exits rather than serving** if the guard fails at boot.

## Sessions and anti-replay

`AuthService.establish` accepts a token from the first *allowed* provider that
recognises it, and issues a `SessionRecord` with a monotonically increasing
`counter`. `resolve(sessionId, counter)` rejects:

- unknown or revoked sessions,
- expired sessions,
- a `counter` that does not match the live session — so a captured
  `(sessionId, counter)` pair is single-use.

Providers outside the policy are skipped rather than throwing, so adding a
future provider cannot break unrelated logins.

## Second factor

`MfaService` tracks enrolled factors (`totp`, `webauthn`, `sms`,
`backup-code`). Backup codes are single-use and tracked by hash.

`assertAuthorized(session, operation)` gates privileged operations
(`withdraw`, `change-payout-wallet`, `disable-mfa`, `account-recovery`,
`high-value-trade`):

- a **dev session can never satisfy step-up**, even after `satisfyMfa` —
  `STEP_UP_UNAVAILABLE`;
- a real provider must have `mfaSatisfied` — `STEP_UP_REQUIRED`;
- ordinary operations are not gated.

The API enforces this server-side at `POST /api/auth/authorize`, so the rule
does not depend on a client behaving.

## Known gaps

- No real provider integration, no password storage, no KYC/age verification.
- `hasRole` is a placeholder that does not yet consult a real role store.
- No session refresh or rotation beyond the counter mechanism.
- No wallet challenge ceremony, no WebAuthn ceremony, no TOTP verification —
  only enrollment bookkeeping.
