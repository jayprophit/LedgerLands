import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEATURE_FLAGS,
  FUN_TOKEN_REFERENCE,
  SUPPORTED_ASSETS,
  SimulatedSettlementAdapter,
  SimulatedWalletAdapter,
  flagsFromEnv,
  type FeatureFlags,
} from "../src/index.js";

/**
 * These tests exist to pin the safety invariant, not to test much else.
 * `REAL_MONEY` and `WITHDRAWALS` staying false is the single most important
 * property in this package; a refactor that makes them configurable would be a
 * breaking change, and these assertions are what makes that visible.
 */
describe("feature flags", () => {
  it("keeps every real-value path off by default", () => {
    expect(DEFAULT_FEATURE_FLAGS.REAL_MONEY).toBe(false);
    expect(DEFAULT_FEATURE_FLAGS.WITHDRAWALS).toBe(false);
    expect(DEFAULT_FEATURE_FLAGS.DEX_SWAPS).toBe(false);
    expect(DEFAULT_FEATURE_FLAGS.STAKING).toBe(false);
    expect(DEFAULT_FEATURE_FLAGS.BLOCKCHAIN).toBe(false);
    expect(DEFAULT_FEATURE_FLAGS.NFT_MINTING).toBe(false);
  });

  it("cannot be talked into enabling real money or withdrawals via env", () => {
    const hostile: Record<string, string> = {
      LEDGERLANDS_REAL_MONEY: "true",
      REAL_MONEY: "1",
      LEDGERLANDS_WITHDRAWALS: "true",
      WITHDRAWALS: "true",
      LEDGERLANDS_DEX_SWAPS: "1",
      DEX_SWAPS: "1",
      LEDGERLANDS_FUN_TOKEN: "1",
    };
    const flags = flagsFromEnv(hostile);
    expect(flags.REAL_MONEY).toBe(false);
    expect(flags.WITHDRAWALS).toBe(false);
    expect(flags.DEX_SWAPS).toBe(false);
  });

  it("still allows the play-money flags to be turned on", () => {
    const flags = flagsFromEnv({
      LEDGERLANDS_MARKETPLACE: "1",
      LEDGERLANDS_TOURNAMENTS: "true",
    });
    expect(flags.MARKETPLACE).toBe(true);
    expect(flags.TOURNAMENTS).toBe(true);
    expect(flags.REAL_MONEY).toBe(false);
  });

  it("treats only an exact truthy string as on", () => {
    expect(flagsFromEnv({ LEDGERLANDS_MARKETPLACE: "yes" }).MARKETPLACE).toBe(false);
    expect(flagsFromEnv({ LEDGERLANDS_MARKETPLACE: "0" }).MARKETPLACE).toBe(false);
    expect(flagsFromEnv({}).MARKETPLACE).toBe(false);
    expect(flagsFromEnv({ LEDGERLANDS_MARKETPLACE: "1" }).MARKETPLACE).toBe(true);
  });

  it("never reports a real-money flag as true in any env-derived result", () => {
    const env: Record<string, string> = {};
    for (const key of [
      "LEDGERLANDS_BLOCKCHAIN",
      "LEDGERLANDS_STAKING",
      "LEDGERLANDS_MARKETPLACE",
      "LEDGERLANDS_NFT_MINTING",
      "LEDGERLANDS_RANKED",
      "LEDGERLANDS_TOURNAMENTS",
    ]) {
      for (const value of ["1", "true"]) {
        env[key] = value;
        const flags: FeatureFlags = flagsFromEnv(env);
        expect(flags.REAL_MONEY).toBe(false);
        expect(flags.WITHDRAWALS).toBe(false);
        expect(flags.DEX_SWAPS).toBe(false);
      }
    }
  });
});

describe("asset registry", () => {
  it("ships only the simulated asset as enabled", () => {
    const enabled = SUPPORTED_ASSETS.filter((a) => a.enabled);
    expect(enabled.map((a) => a.symbol)).toEqual(["SIM_SAT"]);
  });

  it("does not enable a counterfeit FUN contract", () => {
    const fun = SUPPORTED_ASSETS.find((a) => a.symbol === "FUN");
    expect(fun).toBeDefined();
    expect(fun!.enabled).toBe(false);
    expect(fun!.chain).toBe(FUN_TOKEN_REFERENCE.chain);
    expect(fun!.decimals).toBe(FUN_TOKEN_REFERENCE.decimals);
    // A reference has no address of its own; a deployment must supply a verified one.
    expect(fun!.contractAddress).toBeUndefined();
  });

  it("keeps BTC disabled", () => {
    expect(SUPPORTED_ASSETS.find((a) => a.symbol === "BTC")!.enabled).toBe(false);
  });
});

describe("simulated adapters", () => {
  it("mints nothing and settles nothing on a real chain", async () => {
    const wallet = new SimulatedWalletAdapter();
    expect(wallet.chain).toBe("SIM");
    const { address } = await wallet.connect();
    expect(await wallet.getBalance(address)).toBe(0n);
    wallet.faucet(address, 5_000n);
    expect(await wallet.getBalance(address)).toBe(5_000n);
  });

  it("accumulates escrow per player and match without moving funds", async () => {
    const settlement = new SimulatedSettlementAdapter();
    const first = await settlement.lockEntry("p1", "m1", 100n);
    const second = await settlement.lockEntry("p1", "m1", 50n);
    expect(first.escrowId).toBe("m1:p1");
    expect(second.escrowId).toBe("m1:p1");
    const other = await settlement.lockEntry("p2", "m1", 100n);
    expect(other.escrowId).toBe("m1:p2");
    // settle/refund are simulated: they return a marker and transfer nothing.
    const settle = await settlement.settle("m1", [{ to: "p1", amount: 150n }]);
    expect(settle.txHash).toBe("sim-settle-m1");
    const refund = await settlement.refund("m1");
    expect(refund.txHash).toBe("sim-refund-m1");
  });
});
