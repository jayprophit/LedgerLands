# Replay / Dispute system

Every match stores a command log and emits a revisioned event stream. The
replay export (`GET /api/matches/:id/replay`) bundles both.

## What the export contains

| Field | Meaning |
|---|---|
| `rulesetVersion` | Ruleset in force (`classic-v1` …). Matches never reinterpret mid-flight. |
| `boardVersion` | Board data version (`classic-v1-board-1`). |
| `matchId`, `seed` | Match identity and the RNG seed the whole match derives from. |
| `players` | Seat list with ids/names. |
| `commands` | Every accepted command in order, with `commandId`, actor and result revision. |
| `events` | The full server event stream with `atRevision`. |
| `finalState` | Reconstructed final state. |
| `settlement` | Winner plus per-player final balances. |
| `chainHash` | SHA-256 hash chain over the events (see below). |

## What the chain hash guarantees — and what it does not

The chain hash is computed as:

```
prev = "GENESIS"
for each event in order:
    prev = sha256(prev + JSON(event))
chainHash = prev
```

This gives **tamper evidence**: if any stored event is altered, removed, or
reordered, the recomputed hash no longer matches the recorded one.

It explicitly does **not** prove:

- that the original server computed those events correctly,
- that the events are free of engine bugs,
- that no collusion or fraud occurred,
- who produced the log (there is no signature key on the export).

`match-store` stores `resultRevision` per command and `version` per snapshot so
a verifier can replay `initial + commands` and compare both the final state and
the hash. An independent auditor with the same ruleset version can therefore
reproduce the match — but "reproducible" is a stronger claim than
"hash-consistent", and only the former is meaningful for disputes.

## Independent verification

```
seed + rulesetVersion + boardVersion + commands
  → replayCommands()  → state
  → compare with finalState, events, chainHash
```

`packages/match-store/test/postgres.test.ts` asserts exactly this
(full replay == snapshot-and-tail), and the rebuild tests in
`packages/match-store/test/store.test.ts` assert state equality after a
simulated process restart.

## Manifests and optional signing

The chain hash binds the *events*. A **manifest** binds the chain to the match's
identity, and an optional signature binds the manifest to a key.

```
manifestHash = sha256(exportVersion, matchId, boardVersion, rulesetVersion,
                      seed, eventCount, firstHash, finalHash, settlement)
signature    = sign(manifestHash)
```

`issuedAt` is deliberately **excluded** from the hash, so a manifest is
content-addressed: two independent exports of the same match always produce the
same `manifestHash`, which is what makes filed evidence comparable. Verification
recomputes the digest, so editing any bound field invalidates the signature.

`ReplaySigner` has three implementations:

| Signer | Use | What it proves |
|---|---|---|
| `Ed25519Signer` | real attribution (asymmetric) | which key signed this manifest |
| `HmacDevSigner` | local development only | nothing about *which* server (symmetric) |
| `UnsignedManifest` | default when no key is configured | nothing; the manifest is untrusted evidence |

Configure the real signer with `LEDGERLANDS_REPLAY_SIGNER_KEY` (base64 PKCS#8).
**No private key is committed to this repository.** The default is
`UnsignedManifest`, so a missing key cannot silently produce something that
looks signed.

## Dispute workflow

`DisputeService` (simulated) implements:

```
OPEN → UNDER_REVIEW → RESOLVED | REJECTED
OPEN → CANCELLED
```

A dispute records the reporter, category, reason, the `replayFinalHash` and
`replayManifestHash` **as filed**, the export version, the evidence bundle
(manifest + signature + events), and an append-only `history`. `revalidate()`
re-verifies filed evidence against a signer and checks it still matches the
hashes captured at open time.

This is a simulated workflow: the resolver is a role string with no identity
provider behind it, and a resolved dispute records a decision **without
automatically re-settling a match**.

## Current gaps (honest list)

1. **Signing is optional and off by default** — the real signer needs a managed
   key; production key management is a later security milestone.
2. **Snapshots accelerate replay** (see `docs/PERSISTENCE.md`); a Postgres
   suffix read is implemented but unproven without a live DB.
3. **The dispute workflow is simulated** — no admin identity provider, no
   automatic correction, no notification path.
4. **Command actor is recorded, not authenticated at export time**; the
   dev auth adapter is explicitly not an authorization boundary.
