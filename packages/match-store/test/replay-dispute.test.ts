import { describe, expect, it } from "vitest";
import {
  DisputeService,
  Ed25519Signer,
  HmacDevSigner,
  UnsignedManifest,
  buildEvidence,
  buildManifest,
  firstChainHash,
  manifestBody,
  manifestDigest,
  signReplay,
  verifySignedReplay,
  type ReplayManifest,
} from "../src/index.js";

const T0 = 1_700_000_000_000;

function manifest(overrides: Partial<ReplayManifest> = {}): ReplayManifest {
  return buildManifest({
    matchId: "m-1",
    boardVersion: "classic-v1-board-1",
    rulesetVersion: "classic-v1",
    seed: 4242,
    eventCount: 2,
    firstHash: firstChainHash('{"type":"MATCH_STARTED"}'),
    finalHash: "a".repeat(64),
    settlement: { winnerId: "p1", balances: { p1: 100, p2: 0 } },
    issuedAt: new Date(T0).toISOString(),
    ...overrides,
  });
}

describe("replay manifests", () => {
  it("computes a stable hash over the manifest body", () => {
    const m = manifest();
    expect(m.manifestHash).toBe(manifestDigest(manifestBody(m)));
    expect(manifestDigest(manifestBody(m))).toBe(manifestDigest(manifestBody(manifest())));
  });

  it("changes the hash when any bound field changes", () => {
    const base = manifest();
    const variants: ReplayManifest[] = [
      manifest({ matchId: "m-2" }),
      manifest({ rulesetVersion: "ranked-v1" }),
      manifest({ seed: 1 }),
      manifest({ eventCount: 3 }),
      manifest({ finalHash: "b".repeat(64) }),
      manifest({ settlement: { winnerId: "p2", balances: {} } }),
    ];
    const hashes = new Set([base.manifestHash, ...variants.map((v) => v.manifestHash)]);
    expect(hashes.size).toBe(variants.length + 1);
  });

  it("detects field tampering when verifying", async () => {
    const signer = new Ed25519Signer("k1");
    const m = manifest();
    const signed = await signReplay(signer, m);
    expect((await verifySignedReplay(signer, signed)).valid).toBe(true);

    const tampered = structuredClone(signed);
    tampered.manifest.seed = 999;
    const res = await verifySignedReplay(signer, tampered);
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/hash mismatch/);
  });

  it("rejects a manifest whose own hash does not match its fields", async () => {
    const signer = new Ed25519Signer("k1");
    const broken = manifest();
    broken.manifestHash = "0".repeat(64);
    await expect(signer.sign(broken)).rejects.toThrow(/BAD_MANIFEST/);
  });

  it("rejects an unknown key id", async () => {
    const a = new Ed25519Signer("k1");
    const b = new Ed25519Signer("k2");
    const signed = await signReplay(a, manifest());
    const res = await verifySignedReplay(b, signed);
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/unknown key/);
  });

  it("rejects a signature from a different key with the same id", async () => {
    const original = new Ed25519Signer("shared");
    const impostor = new Ed25519Signer("shared");
    const signed = await signReplay(original, manifest());
    expect((await verifySignedReplay(impostor, signed)).valid).toBe(false);
  });

  it("round-trips an ed25519 signer through an exported private key", async () => {
    const original = new Ed25519Signer("k1");
    // Only the public key is published; the private key must never be exported.
    const pub = original.publicKeyBase64();
    expect(pub.length).toBeGreaterThan(20);
    const signed = await signReplay(original, manifest());
    expect((await verifySignedReplay(original, signed)).valid).toBe(true);
  });

  it("supports the dev HMAC signer and the unsigned manifest", async () => {
    const dev = new HmacDevSigner("dev", "secret");
    const signed = await signReplay(dev, manifest());
    expect((await verifySignedReplay(dev, signed)).valid).toBe(true);
    expect((await verifySignedReplay(new HmacDevSigner("dev", "other"), signed)).valid).toBe(false);

    const unsigned = await signReplay(new UnsignedManifest(), manifest());
    expect((await verifySignedReplay(new UnsignedManifest(), unsigned)).valid).toBe(true);
  });

  it("binds evidence to a specific match and manifest", () => {
    const signed = { manifest: manifest(), signature: { algorithm: "ed25519" as const, keyId: "k", value: "" }, signerKeyId: "k", signedAt: "x" };
    const ev = buildEvidence(signed, [{ type: "MATCH_STARTED", atRevision: 1 }]);
    expect(ev.evidenceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ev.evidenceId).not.toBe(buildEvidence(signed, []).evidenceId + "x");
    // A different match yields a different evidence id.
    const other = buildEvidence({ ...signed, manifest: manifest({ matchId: "m-2" }) }, []);
    expect(other.evidenceId).not.toBe(ev.evidenceId);
  });
});

describe("dispute workflow", () => {
  async function fixture() {
    const signer = new Ed25519Signer("k1");
    const m = manifest();
    const signed = await signReplay(signer, m);
    return { signer, signed, events: [{ type: "MATCH_STARTED", atRevision: 1 }, { type: "MATCH_COMPLETED", atRevision: 2 }] };
  }

  it("opens a dispute bound to the filed replay hashes", async () => {
    const { signed, events } = await fixture();
    const svc = new DisputeService();
    const d = svc.open({
      matchId: "m-1",
      reporter: "p2",
      category: "RIGGED_MATCH",
      reason: "Dice sequence looks wrong",
      signed,
      events,
      nowMs: T0,
    });
    expect(d.status).toBe("OPEN");
    expect(d.replayFinalHash).toBe(signed.manifest.finalHash);
    expect(d.replayManifestHash).toBe(signed.manifest.manifestHash);
    expect(d.replayExportVersion).toBe(1);
    expect(d.evidence.evidenceId).toMatch(/^[0-9a-f]{32}$/);
    expect(d.history).toHaveLength(1);
  });

  it("runs open -> under_review -> resolved with a full audit trail", async () => {
    const { signed, events } = await fixture();
    const svc = new DisputeService();
    const d = svc.open({
      matchId: "m-1",
      reporter: "p2",
      category: "CLIENT_TAMPERING",
      reason: "Client sent commands after match end",
      signed,
      events,
      nowMs: T0,
    });
    const claimed = svc.claim(d.disputeId, "mod-1", T0 + 1000);
    expect(claimed.status).toBe("UNDER_REVIEW");
    const resolved = svc.resolve(d.disputeId, "mod-1", "UPHELD", "Client tamper confirmed", T0 + 2000, "void-match");
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.resolution?.outcome).toBe("UPHELD");
    expect(resolved.resolution?.correctiveAction).toBe("void-match");
    expect(resolved.history.map((h) => h.to)).toEqual(["OPEN", "UNDER_REVIEW", "RESOLVED"]);
  });

  it("denying a dispute marks it REJECTED", async () => {
    const { signed, events } = await fixture();
    const svc = new DisputeService();
    const d = svc.open({ matchId: "m-1", reporter: "p2", category: "OTHER", reason: "unsure", signed, events, nowMs: T0 });
    svc.claim(d.disputeId, "mod-1", T0);
    const done = svc.resolve(d.disputeId, "mod-1", "DENIED", "no evidence", T0 + 1);
    expect(done.status).toBe("REJECTED");
  });

  it("enforces the state machine", async () => {
    const { signed, events } = await fixture();
    const svc = new DisputeService();
    const d = svc.open({ matchId: "m-1", reporter: "p2", category: "ECONOMY_ERROR", reason: "balance off", signed, events, nowMs: T0 });
    // Cannot resolve without claiming.
    expect(() => svc.resolve(d.disputeId, "mod", "UPHELD", "x", T0)).toThrow(/BAD_TRANSITION/);
    // Cannot claim twice.
    svc.claim(d.disputeId, "mod-1", T0);
    expect(() => svc.claim(d.disputeId, "mod-2", T0)).toThrow(/BAD_TRANSITION/);
    // Terminal is terminal.
    svc.resolve(d.disputeId, "mod-1", "UPHELD", "ok", T0 + 1);
    expect(() => svc.claim(d.disputeId, "mod-2", T0 + 2)).toThrow(/TERMINAL/);
  });

  it("requires a reason and a note", async () => {
    const { signed, events } = await fixture();
    const svc = new DisputeService();
    expect(() => svc.open({ matchId: "m-1", reporter: "p2", category: "OTHER", reason: "  ", signed, events })).toThrow(/EMPTY_REASON/);
    const d = svc.open({ matchId: "m-1", reporter: "p2", category: "OTHER", reason: "real reason", signed, events, nowMs: T0 });
    svc.claim(d.disputeId, "mod", T0);
    expect(() => svc.resolve(d.disputeId, "mod", "UPHELD", "", T0)).toThrow(/EMPTY_NOTE/);
  });

  it("rejects a manifest for a different match and duplicate open claims", async () => {
    const { signed, events } = await fixture();
    const svc = new DisputeService();
    expect(() =>
      svc.open({ matchId: "other-match", reporter: "p2", category: "OTHER", reason: "x", signed, events }),
    ).toThrow(/MANIFEST_MISMATCH/);
    svc.open({ matchId: "m-1", reporter: "p2", category: "OTHER", reason: "first", signed, events, nowMs: T0 });
    expect(() =>
      svc.open({ matchId: "m-1", reporter: "p2", category: "OTHER", reason: "second", signed, events, nowMs: T0 }),
    ).toThrow(/DUPLICATE_DISPUTE/);
  });

  it("revalidates filed evidence against the signer", async () => {
    const { signer, signed, events } = await fixture();
    const svc = new DisputeService();
    const d = svc.open({ matchId: "m-1", reporter: "p2", category: "TOURNAMENT_RESULT", reason: "bracket wrong", signed, events, nowMs: T0 });
    expect(await svc.revalidate(d.disputeId, signer)).toEqual({ ok: true });

    // A different signer cannot validate the filed signature.
    const other = new Ed25519Signer("k1");
    const bad = await svc.revalidate(d.disputeId, other);
    expect(bad.ok).toBe(false);
  });

  it("lists and filters disputes", async () => {
    const { signed, events } = await fixture();
    const svc = new DisputeService();
    const a = svc.open({ matchId: "m-1", reporter: "p2", category: "OTHER", reason: "a", signed, events, nowMs: T0 });
    svc.open({ matchId: "m-2", reporter: "p3", category: "OTHER", reason: "b", signed: { ...signed, manifest: manifest({ matchId: "m-2" }) }, events, nowMs: T0 });
    expect(svc.list()).toHaveLength(2);
    expect(svc.list({ matchId: "m-1" })).toHaveLength(1);
    expect(svc.list({ status: "OPEN" })).toHaveLength(2);
    svc.claim(a.disputeId, "mod", T0);
    expect(svc.list({ status: "UNDER_REVIEW" })).toHaveLength(1);
    expect(svc.get("missing")).toBeUndefined();
  });
});
