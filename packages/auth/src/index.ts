/**
 * LedgerLands authentication.
 *
 * `core.ts`      — identity model + the DEVELOPMENT-ONLY DevAuthAdapter
 * `providers.ts` — inert/mock adapters for the future provider set
 * `service.ts`   — session composition, MFA boundary, production guard
 *
 * The production guard is the point of this package: `DevAuthAdapter` exists so
 * local development is ergonomic, and the guard exists so it can never be
 * mistaken for production identity.
 */

export * from "./core.js";
export * from "./service.js";
export * from "./providers.js";
