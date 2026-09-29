import {
  buildEvidence,
  evidenceIdFor,
  newDisputeId,
  type ReplayEvidence,
  type ReplayManifest,
  type ReplaySigner,
  type SignedReplay,
  verifySignedReplay,
} from "./replay-manifest.js";

/**
 * Dispute workflow.
 *
 * A dispute is a claim about a match, bound to a signed replay manifest. The
 * manifest hash is copied into the dispute record, so a later export can be
 * checked against what was filed at open time.
 *
 * This is a *simulated* workflow: the resolver is a local role string, there is
 * no admin identity provider behind it yet (see packages/auth), and nothing
 * here moves money. A resolved dispute records a decision; it does not
 * automatically re-settle a match.
 */

export type DisputeStatus = "OPEN" | "UNDER_REVIEW" | "RESOLVED" | "REJECTED" | "CANCELLED";

export type DisputeCategory =
  | "RIGGED_MATCH"
  | "CLIENT_TAMPERING"
  | "RANKING_ERROR"
  | "TOURNAMENT_RESULT"
  | "ECONOMY_ERROR"
  | "OTHER";

export interface DisputeResolution {
  outcome: "UPHELD" | "DENIED" | "PARTIAL";
  note: string;
  resolver: string;
  resolvedAt: string;
  /** Optional corrective action, recorded for audit only. */
  correctiveAction?: string;
}

export interface Dispute {
  disputeId: string;
  matchId: string;
  reporter: string;
  category: DisputeCategory;
  reason: string;
  status: DisputeStatus;
  /** Manifest hash captured when the dispute was opened. */
  replayFinalHash: string;
  replayManifestHash: string;
  replayExportVersion: number;
  evidence: ReplayEvidence;
  createdAt: string;
  updatedAt: string;
  resolution?: DisputeResolution;
  /** Append-only trail of every state change. */
  history: Array<{ at: string; from: DisputeStatus; to: DisputeStatus; by: string; note?: string }>;
}

export class DisputeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "DisputeError";
    this.code = code;
  }
}

const TERMINAL: DisputeStatus[] = ["RESOLVED", "REJECTED", "CANCELLED"];

export class DisputeService {
  private readonly disputes = new Map<string, Dispute>();

  /** Open a dispute against a signed replay. */
  open(params: {
    matchId: string;
    reporter: string;
    category: DisputeCategory;
    reason: string;
    signed: SignedReplay;
    events: Array<{ type: string; atRevision: number }>;
    nowMs?: number;
  }): Dispute {
    const now = new Date(params.nowMs ?? Date.now()).toISOString();
    if (!params.reason.trim()) throw new DisputeError("EMPTY_REASON", "A dispute needs a reason.");
    if (params.reason.length > 2_000) throw new DisputeError("REASON_TOO_LONG", "Reason exceeds 2000 characters.");
    const m = params.signed.manifest;
    if (m.matchId !== params.matchId) {
      throw new DisputeError("MANIFEST_MISMATCH", "Manifest is for a different match.");
    }
    // One open dispute per reporter per match: duplicates are rejected rather
    // than silently creating parallel claims.
    for (const d of this.disputes.values()) {
      if (d.matchId === params.matchId && d.reporter === params.reporter && !TERMINAL.includes(d.status)) {
        throw new DisputeError("DUPLICATE_DISPUTE", `Reporter already has an open dispute (${d.disputeId}).`);
      }
    }
    const evidence = buildEvidence(params.signed, params.events);
    const dispute: Dispute = {
      disputeId: newDisputeId(),
      matchId: params.matchId,
      reporter: params.reporter,
      category: params.category,
      reason: params.reason.trim(),
      status: "OPEN",
      replayFinalHash: m.finalHash,
      replayManifestHash: m.manifestHash,
      replayExportVersion: m.exportVersion,
      evidence,
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, from: "OPEN", to: "OPEN", by: params.reporter, note: "filed" }],
    };
    this.disputes.set(dispute.disputeId, dispute);
    return structuredClone(dispute);
  }

  claim(disputeId: string, reviewer: string, nowMs = Date.now()): Dispute {
    return this.transition(disputeId, "UNDER_REVIEW", reviewer, "claimed for review", nowMs);
  }

  resolve(
    disputeId: string,
    reviewer: string,
    outcome: DisputeResolution["outcome"],
    note: string,
    nowMs = Date.now(),
    correctiveAction?: string,
  ): Dispute {
    const at = new Date(nowMs).toISOString();
    if (!note.trim()) throw new DisputeError("EMPTY_NOTE", "A resolution needs a note.");
    const d = this.require(disputeId);
    if (d.status !== "UNDER_REVIEW") {
      throw new DisputeError("BAD_TRANSITION", `Cannot resolve from ${d.status}; claim it first.`);
    }
    const next: DisputeStatus = outcome === "DENIED" ? "REJECTED" : "RESOLVED";
    d.status = next;
    d.resolution = {
      outcome,
      note: note.trim(),
      resolver: reviewer,
      resolvedAt: at,
      ...(correctiveAction !== undefined ? { correctiveAction } : {}),
    };
    d.history.push({ at, from: "UNDER_REVIEW", to: next, by: reviewer, note: note.trim() });
    d.updatedAt = at;
    return structuredClone(d);
  }

  cancel(disputeId: string, actor: string, nowMs = Date.now()): Dispute {
    return this.transition(disputeId, "CANCELLED", actor, "cancelled", nowMs);
  }

  get(disputeId: string): Dispute | undefined {
    const d = this.disputes.get(disputeId);
    return d ? structuredClone(d) : undefined;
  }

  list(filter?: { matchId?: string; status?: DisputeStatus }): Dispute[] {
    return [...this.disputes.values()]
      .filter((d) => (filter?.matchId ? d.matchId === filter.matchId : true))
      .filter((d) => (filter?.status ? d.status === filter.status : true))
      .map((d) => structuredClone(d));
  }

  /**
   * Re-verify filed evidence against a signer. A mismatch means the replay no
   * longer matches what was filed — the single most important dispute check.
   */
  async revalidate(disputeId: string, verifier: ReplaySigner): Promise<{ ok: boolean; reason?: string }> {
    const d = this.require(disputeId);
    const result = await verifySignedReplay(verifier, d.evidence.signed);
    if (!result.valid) {
      return { ok: false, ...(result.reason !== undefined ? { reason: result.reason } : {}) };
    }
    if (result.manifestHash !== d.replayManifestHash) {
      return { ok: false, reason: "manifest hash differs from the value filed at open time" };
    }
    if (d.evidence.signed.manifest.finalHash !== d.replayFinalHash) {
      return { ok: false, reason: "event chain hash differs from the value filed at open time" };
    }
    if (d.evidence.evidenceId !== evidenceIdFor(d.matchId, d.replayManifestHash)) {
      return { ok: false, reason: "evidence id does not bind to this match and manifest" };
    }
    return { ok: true };
  }

  private transition(
    disputeId: string,
    to: DisputeStatus,
    by: string,
    note: string,
    nowMs: number,
  ): Dispute {
    const at = new Date(nowMs).toISOString();
    const d = this.require(disputeId);
    if (TERMINAL.includes(d.status)) throw new DisputeError("TERMINAL", `Dispute is already ${d.status}.`);
    if (to === "UNDER_REVIEW" && d.status !== "OPEN") {
      throw new DisputeError("BAD_TRANSITION", `Cannot claim from ${d.status}.`);
    }
    if (to === "CANCELLED" && d.reporter !== by && d.status !== "OPEN") {
      throw new DisputeError("NOT_PERMITTED", "Only the reporter can cancel a dispute under review.");
    }
    const from = d.status;
    d.status = to;
    d.history.push({ at, from, to, by, note });
    d.updatedAt = at;
    return structuredClone(d);
  }

  private require(disputeId: string): Dispute {
    const d = this.disputes.get(disputeId);
    if (!d) throw new DisputeError("NOT_FOUND", `Dispute ${disputeId} was not found.`);
    return d;
  }
}

export type { ReplayManifest, ReplayEvidence, SignedReplay };
