import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

/**
 * Replay manifests and optional signing.
 *
 * What the chain hash proves
 * -------------------------
 * The SHA-256 chain over the event stream provides **tamper evidence after
 * construction**: if any event is altered, removed, or reordered, recomputing
 * the chain no longer reproduces the recorded hash.
 *
 * What it does NOT prove
 * ----------------------
 * - that the server that produced the log behaved correctly;
 * - that the log is free of engine bugs;
 * - that no collusion or fraud occurred;
 * - who produced it. An unkeyed hash identifies nothing.
 *
 * A signature closes the attribution gap (and only that gap): it binds the
 * manifest to a key, so a verifier can attribute a log to a signer. It still
 * says nothing about the signer's honesty.
 *
 * The manifest hash is a *different* value from the event chain hash: it binds
 * the chain hash plus the match's identity and ruleset metadata, so a manifest
 * cannot be transplanted onto a different match.
 */

export const REPLAY_EXPORT_VERSION = 1;

export interface ReplayManifest {
  exportVersion: number;
  matchId: string;
  boardVersion: string;
  rulesetVersion: string;
  seed: number;
  eventCount: number;
  /** First chain link, so a partial export is still identifiable. */
  firstHash: string;
  /** Terminal chain link over the full event stream. */
  finalHash: string;
  settlement: { winnerId?: string; balances: Record<string, number> };
  /**
   * When the manifest was issued. Deliberately EXCLUDED from `manifestHash`:
   * the manifest is content-addressed, so two independent exports of the same
   * match agree even though they were produced at different times. Only the
   * signed digest is compared for evidence purposes.
   */
  issuedAt: string;
  /** Digest over every field above except `issuedAt` and `manifestHash`. */
  manifestHash: string;
}

export interface Signature {
  algorithm: "ed25519" | "hmac-sha256";
  keyId: string;
  value: string;
}

export interface ReplaySigner {
  readonly keyId: string;
  sign(manifest: ReplayManifest): Promise<Signature>;
  verify(manifest: ReplayManifest, signature: Signature): Promise<boolean>;
}

export class SigningError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "SigningError";
    this.code = code;
  }
}

/** The signable body: content fields only, excluding `issuedAt` and the hash. */
export type ReplayManifestBody = Omit<ReplayManifest, "manifestHash" | "issuedAt">;

/** The signable body of a manifest. */
export function manifestBody(manifest: ReplayManifest): ReplayManifestBody {
  return {
    exportVersion: manifest.exportVersion,
    matchId: manifest.matchId,
    boardVersion: manifest.boardVersion,
    rulesetVersion: manifest.rulesetVersion,
    seed: manifest.seed,
    eventCount: manifest.eventCount,
    firstHash: manifest.firstHash,
    finalHash: manifest.finalHash,
    settlement: manifest.settlement,
  };
}

/** Deterministic digest over the manifest body (content only, no timestamps). */
export function manifestDigest(input: ReplayManifestBody): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export type BuildManifestInput = Omit<ReplayManifest, "manifestHash" | "issuedAt" | "exportVersion"> & {
  exportVersion?: number;
  issuedAt?: string;
};

export function buildManifest(input: BuildManifestInput): ReplayManifest {
  const { issuedAt, exportVersion, ...rest } = input;
  // Build the body through the same field order `manifestBody` uses, so the
  // JSON serialization — and therefore the digest — is identical either way.
  const body: ReplayManifestBody = {
    exportVersion: exportVersion ?? REPLAY_EXPORT_VERSION,
    matchId: rest.matchId,
    boardVersion: rest.boardVersion,
    rulesetVersion: rest.rulesetVersion,
    seed: rest.seed,
    eventCount: rest.eventCount,
    firstHash: rest.firstHash,
    finalHash: rest.finalHash,
    settlement: rest.settlement,
  };
  return {
    ...body,
    issuedAt: issuedAt ?? new Date().toISOString(),
    manifestHash: manifestDigest(body),
  };
}

/** First chain link, i.e. sha256("GENESIS" + firstEvent). */
export function firstChainHash(firstEventJson: string): string {
  return createHash("sha256").update("GENESIS" + firstEventJson).digest("hex");
}

export class Ed25519Signer implements ReplaySigner {
  readonly algorithm = "ed25519" as const;
  readonly keyId: string;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(keyId: string, keys?: { privateKey: KeyObject; publicKey: KeyObject }) {
    this.keyId = keyId;
    if (keys) {
      this.privateKey = keys.privateKey;
      this.publicKey = keys.publicKey;
    } else {
      const pair = generateKeyPairSync("ed25519");
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
    }
  }

  /** Exported public key (SPKI DER, base64) so verifiers can be configured. */
  publicKeyBase64(): string {
    return this.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  }

  /** Rebuild a signer from an exported PKCS#8 private key (never commit one). */
  static fromPrivateKeyBase64(keyId: string, privateKeyBase64: string): Ed25519Signer {
    const privateKey = createPrivateKey({
      key: Buffer.from(privateKeyBase64, "base64"),
      format: "der",
      type: "pkcs8",
    });
    return new Ed25519Signer(keyId, { privateKey, publicKey: createPublicKey(privateKey) });
  }

  async sign(manifest: ReplayManifest): Promise<Signature> {
    if (manifestDigest(manifestBody(manifest)) !== manifest.manifestHash) {
      throw new SigningError("BAD_MANIFEST", "manifest hash does not match its own fields");
    }
    const sig = sign(null, Buffer.from(manifest.manifestHash, "hex"), this.privateKey);
    return { algorithm: "ed25519", keyId: this.keyId, value: sig.toString("base64") };
  }

  async verify(manifest: ReplayManifest, signature: Signature): Promise<boolean> {
    if (signature.algorithm !== "ed25519") return false;
    // Recompute the digest so a tampered field cannot verify.
    if (manifestDigest(manifestBody(manifest)) !== manifest.manifestHash) return false;
    try {
      return verify(null, Buffer.from(manifest.manifestHash, "hex"), this.publicKey, Buffer.from(signature.value, "base64"));
    } catch {
      return false;
    }
  }
}

/**
 * Development signer. HMAC is symmetric: anyone holding the secret can both
 * sign and verify, so it proves nothing about *which* server signed. It exists
 * only so local development can exercise the signed path end to end.
 */
export class HmacDevSigner implements ReplaySigner {
  readonly algorithm = "hmac-sha256" as const;
  constructor(
    readonly keyId: string,
    private readonly secret: string,
  ) {
    if (!secret) throw new SigningError("NO_SECRET", "HmacDevSigner requires a secret.");
  }

  async sign(manifest: ReplayManifest): Promise<Signature> {
    return {
      algorithm: "hmac-sha256",
      keyId: this.keyId,
      value: createHmac("sha256", this.secret).update(manifest.manifestHash).digest("hex"),
    };
  }

  async verify(manifest: ReplayManifest, signature: Signature): Promise<boolean> {
    if (signature.algorithm !== "hmac-sha256") return false;
    if (manifestDigest(manifestBody(manifest)) !== manifest.manifestHash) return false;
    const mac = createHmac("sha256", this.secret).update(manifest.manifestHash).digest("hex");
    return mac === signature.value;
  }
}

/** No-op signer: the manifest is produced and verified as untrusted evidence. */
export class UnsignedManifest implements ReplaySigner {
  readonly keyId = "none";
  async sign(): Promise<Signature> {
    return { algorithm: "hmac-sha256", keyId: "none", value: "" };
  }
  async verify(): Promise<boolean> {
    return true;
  }
}

export interface SignedReplay {
  manifest: ReplayManifest;
  signature: Signature;
  signerKeyId: string;
  signedAt: string;
}

export async function signReplay(signer: ReplaySigner, manifest: ReplayManifest): Promise<SignedReplay> {
  const signature = await signer.sign(manifest);
  return { manifest, signature, signerKeyId: signer.keyId, signedAt: new Date().toISOString() };
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  manifestHash: string;
}

export async function verifySignedReplay(
  verifier: ReplaySigner,
  signed: SignedReplay,
): Promise<VerifyResult> {
  if (signed.signature.keyId !== verifier.keyId) {
    return { valid: false, reason: `unknown key ${signed.signature.keyId}`, manifestHash: signed.manifest.manifestHash };
  }
  const recomputed = manifestDigest(manifestBody(signed.manifest));
  if (recomputed !== signed.manifest.manifestHash) {
    return { valid: false, reason: "manifest hash mismatch (fields were modified)", manifestHash: signed.manifest.manifestHash };
  }
  const ok = await verifier.verify(signed.manifest, signed.signature);
  return ok
    ? { valid: true, manifestHash: signed.manifest.manifestHash }
    : { valid: false, reason: "signature did not verify", manifestHash: signed.manifest.manifestHash };
}

/** A dispute-grade evidence bundle: the manifest, its signature, and the events. */
export interface ReplayEvidence {
  evidenceId: string;
  signed: SignedReplay;
  events: Array<{ type: string; atRevision: number }>;
}

export function evidenceIdFor(matchId: string, manifestHash: string): string {
  return createHash("sha256").update(`${matchId}:${manifestHash}`).digest("hex").slice(0, 32);
}

export function buildEvidence(signed: SignedReplay, events: Array<{ type: string; atRevision: number }>): ReplayEvidence {
  return {
    evidenceId: evidenceIdFor(signed.manifest.matchId, signed.manifest.manifestHash),
    signed,
    events,
  };
}

export function newDisputeId(): string {
  return `dsp-${randomUUID()}`;
}
