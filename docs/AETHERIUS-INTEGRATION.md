# Aetherius OS Integration

LedgerLands is a first-class Aetherius OS application and must retain an independent repository/release history.

## Application identity

- App ID: `com.aetherius.ledgerlands`
- Category: `games`
- Repository target: `jayprophit/LedgerLands`
- Legacy concept name: CryptoMonopoly (do not use as production branding)

## Integration contract

Aetherius should discover/register LedgerLands using `integrations/aetherius/app.manifest.json` through the shared Application Registry.

LedgerLands should consume Aetherius shared services as they become stable:

1. Identity/Profile — use Aetherius identity rather than maintaining a second platform login when launched inside Aetherius.
2. Policy — every privileged capability is evaluated by Aetherius RBAC/ABAC before Agent Bridge execution.
3. File/Storage — save local app data, exports and replays through the permission-aware storage provider.
4. Settings/Config — read layered system/user/application configuration.
5. Search — publish safe searchable objects such as help, games, achievements and owned collectibles.
6. Notifications — match invites, tournament starts, rewards and system notices.
7. Application Registry — register metadata, health, version, permissions and entrypoint.
8. Genesis — optional assistant/coach/explainer integration; Genesis must not manipulate hidden outcomes.
9. Agent Bridge — later wallet/device/external-service adapters; real-value finance capabilities remain denied until explicitly enabled by policy and compliance gates.

## Aetherius-side work required

The Aetherius OS repository should add a registry entry or dynamic manifest discovery path for `com.aetherius.ledgerlands`. Do not hard-code a special game launcher if the generic Application Registry exists.

Expected conceptual flow:

```text
Aetherius Shell
  -> Application Registry
  -> LedgerLands manifest
  -> Policy evaluation
  -> Launch web/native surface
  -> Shared Identity/Settings/Storage/Notifications
  -> optional Genesis assistance
  -> optional Agent Bridge adapters
```

## Security defaults

`finance.transact`, wallet deposit and wallet withdrawal are DENY by default in `capabilities.json`.

A future compliance-approved build can introduce a separate permission profile and testnet/mainnet adapters without changing the deterministic game engine.
