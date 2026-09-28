/**
 * Blockchain adapter abstractions. Real-value networks stay disabled behind
 * feature flags; these interfaces let the game settle through adapters later
 * without coupling the engine to any chain.
 */

export type ChainId = "SIM" | "BTC_TESTNET" | "EVM_TESTNET";

export interface AssetConfig {
  symbol: string;
  chain: ChainId;
  /** Verified contract address for EVM assets; undefined for native BTC/SIM. */
  contractAddress?: string;
  decimals: number;
  enabled: boolean;
}

/** External FUNToken reference — never deploy a counterfeit FUN contract. */
export const FUN_TOKEN_REFERENCE: AssetConfig = {
  symbol: "FUN",
  chain: "EVM_TESTNET",
  decimals: 8,
  enabled: false,
};

export const SUPPORTED_ASSETS: AssetConfig[] = [
  { symbol: "SIM_SAT", chain: "SIM", decimals: 0, enabled: true },
  { symbol: "BTC", chain: "BTC_TESTNET", decimals: 8, enabled: false },
  { ...FUN_TOKEN_REFERENCE },
];

export interface WalletAdapter {
  readonly chain: ChainId;
  connect(): Promise<{ address: string }>;
  getBalance(address: string): Promise<bigint>;
}

export interface SettlementAdapter {
  lockEntry(player: string, matchId: string, amount: bigint): Promise<{ escrowId: string }>;
  settle(matchId: string, payouts: Array<{ to: string; amount: bigint }>): Promise<{ txHash: string }>;
  refund(matchId: string): Promise<{ txHash: string }>;
}

export interface NftAdapter {
  mint(to: string, metadataUri: string): Promise<{ tokenId: string }>;
  ownerOf(tokenId: string): Promise<string>;
}

export interface RandomnessAdapter {
  /** Returns a verifiable seed commitment for a match. */
  commit(matchId: string): Promise<{ commitment: string }>;
  reveal(matchId: string): Promise<{ seed: string }>;
}

export interface SwapAdapter {
  quote(from: string, to: string, amountIn: bigint): Promise<{ amountOut: bigint }>;
}

export class SimulatedWalletAdapter implements WalletAdapter {
  readonly chain: ChainId = "SIM";
  private balances = new Map<string, bigint>();
  async connect(): Promise<{ address: string }> {
    return { address: "sim-player" };
  }
  async getBalance(address: string): Promise<bigint> {
    return this.balances.get(address) ?? 0n;
  }
  /** Test-only faucet. */
  faucet(address: string, amount: bigint): void {
    this.balances.set(address, (this.balances.get(address) ?? 0n) + amount);
  }
}

export class SimulatedSettlementAdapter implements SettlementAdapter {
  private escrows = new Map<string, bigint>();
  async lockEntry(player: string, matchId: string, amount: bigint): Promise<{ escrowId: string }> {
    const key = `${matchId}:${player}`;
    this.escrows.set(key, (this.escrows.get(key) ?? 0n) + amount);
    return { escrowId: key };
  }
  async settle(matchId: string, payouts: Array<{ to: string; amount: bigint }>): Promise<{ txHash: string }> {
    void matchId;
    void payouts;
    return { txHash: `sim-settle-${matchId}` };
  }
  async refund(matchId: string): Promise<{ txHash: string }> {
    return { txHash: `sim-refund-${matchId}` };
  }
}

export interface FeatureFlags {
  REAL_MONEY: boolean;
  BLOCKCHAIN: boolean;
  WITHDRAWALS: boolean;
  STAKING: boolean;
  MARKETPLACE: boolean;
  DEX_SWAPS: boolean;
  NFT_MINTING: boolean;
  RANKED: boolean;
  TOURNAMENTS: boolean;
}

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  REAL_MONEY: false,
  BLOCKCHAIN: false,
  WITHDRAWALS: false,
  STAKING: false,
  MARKETPLACE: false,
  DEX_SWAPS: false,
  NFT_MINTING: false,
  RANKED: true,
  TOURNAMENTS: true,
};

export function flagsFromEnv(env: Record<string, string | undefined>): FeatureFlags {
  const on = (v?: string) => v === "1" || v === "true";
  return {
    REAL_MONEY: false, // never enable from env alone
    BLOCKCHAIN: on(env.LEDGERLANDS_BLOCKCHAIN),
    WITHDRAWALS: false,
    STAKING: on(env.LEDGERLANDS_STAKING),
    MARKETPLACE: on(env.LEDGERLANDS_MARKETPLACE),
    DEX_SWAPS: false,
    NFT_MINTING: on(env.LEDGERLANDS_NFT_MINTING),
    RANKED: true,
    TOURNAMENTS: true,
  };
}
