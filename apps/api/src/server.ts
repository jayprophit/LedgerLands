import Fastify, { type FastifyInstance } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import type { GameCommand } from "@ledgerlands/shared-types";
import { BOARD_VERSION, DEFAULT_BOARD, GameRuleError, RULESET_VERSION } from "@ledgerlands/game-engine";
import {
  buildManifest,
  ConcurrencyError,
  DisputeError,
  DisputeService,
  Ed25519Signer,
  firstChainHash,
  MemoryBackend,
  PersistentMatchStore,
  signReplay,
  SigningError,
  UnsignedManifest,
  type DisputeStatus,
  type ReplaySigner,
  type StorageBackend,
} from "@ledgerlands/match-store";
import { DevAuthAdapter, type AuthPrincipal } from "@ledgerlands/auth";
import { MarketplaceService, MarketplaceError, type MarketplaceAssetKind } from "@ledgerlands/marketplace";
import { DoubleEntryLedger } from "@ledgerlands/ledger";
import {
  DurableMatchmakingService,
  MatchmakingError,
  MemoryMatchmakingStore,
  type QueueName,
} from "@ledgerlands/matchmaking";
import { blankRating, leaderboard, settleHeadToHead, type PlayerRating } from "@ledgerlands/ranked";
import { TournamentError, TournamentService } from "@ledgerlands/tournaments";
import { PracticeLedger } from "./ledger.js";

export interface BuiltApp {
  app: FastifyInstance;
  store: PersistentMatchStore;
  tournaments: TournamentService;
  ratings: Map<string, PlayerRating>;
  broadcast: (matchId: string, match: unknown) => void;
  attachSockets: () => void;
}

export function buildApp(opts?: { backend?: StorageBackend; persistence?: string }): BuiltApp {
  const app = Fastify({ logger: false });
  const persistence = opts?.persistence ?? (opts?.backend ? "custom" : "memory");
  const store = new PersistentMatchStore(opts?.backend ?? new MemoryBackend());
  const ledger = new PracticeLedger();
  const tournaments = new TournamentService();
  const ratings = new Map<string, PlayerRating>();
  const auth = new DevAuthAdapter(
    process.env.LEDGERLANDS_DEV_SECRET ? { secret: process.env.LEDGERLANDS_DEV_SECRET } : undefined,
  );
  const marketLedger = new DoubleEntryLedger();
  const marketplace = new MarketplaceService(marketLedger);
  const subscriptions = new Map<string, Set<WebSocket>>();

  function broadcast(matchId: string, match: unknown): void {
    const sockets = subscriptions.get(matchId);
    if (!sockets) return;
    const message = JSON.stringify({ type: "match_state", match });
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(message);
    }
  }

  const allowedOrigins = new Set(
    (process.env.CORS_ORIGIN ?? "http://localhost:5173,http://127.0.0.1:5173").split(",").map((s) => s.trim()),
  );

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) reply.header("access-control-allow-origin", origin);
    else reply.header("access-control-allow-origin", process.env.CORS_ORIGIN?.split(",")[0] ?? "http://localhost:5173");
    reply.header("access-control-allow-headers", "content-type,authorization,x-player-id,x-command-id,x-expected-revision");
    reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
  });

  app.options("*", async (_request, reply) => reply.code(204).send());

  const health = async () => ({
    status: "ok",
    app: "com.aetherius.ledgerlands",
    version: "0.1.0",
    boardVersion: BOARD_VERSION,
    rulesetVersion: RULESET_VERSION,
    persistence,
    realValueFeaturesEnabled: false,
  });
  app.get("/health", health);
  app.get("/api/v1/health", health);

  const board = async () => ({ tiles: DEFAULT_BOARD, boardVersion: BOARD_VERSION, rulesetVersion: RULESET_VERSION });
  app.get("/api/board", board);
  app.get("/api/v1/board", board);
  app.get("/api/matches", async () => ({ matches: await store.list() }));
  app.get("/api/v1/matches", async () => ({ matches: await store.list() }));

  app.post<{
    Body: { playerName?: string; startingBalance?: number; seed?: number; solo?: boolean; difficulty?: string };
  }>("/api/matches", async (request, reply) => {
    try {
      const { match, playerId } = await store.create({
        playerName: request.body?.playerName ?? "",
        ...(request.body?.startingBalance !== undefined ? { startingBalance: request.body.startingBalance } : {}),
        ...(request.body?.seed !== undefined ? { seed: request.body.seed } : {}),
        ...(request.body?.solo !== undefined ? { solo: request.body.solo } : {}),
        ...(request.body?.difficulty !== undefined ? { difficulty: request.body.difficulty } : {}),
      });
      return reply.code(201).send({ match, playerId });
    } catch (error) {
      return ruleError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/matches/:id", async (request, reply) => {
    const match = await store.get(request.params.id);
    if (!match) return reply.code(404).send({ error: "match not found" });
    return { match };
  });

  app.post<{ Params: { id: string }; Body: { playerName?: string; startingBalance?: number } }>(
    "/api/matches/:id/join",
    async (request, reply) => {
      try {
        const { match, playerId } = await store.join(request.params.id, request.body?.playerName ?? "", request.body?.startingBalance ?? 15000);
        broadcast(request.params.id, match);
        return reply.code(201).send({ match, playerId });
      } catch (error) {
        return ruleError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/matches/:id/start", async (request, reply) => {
    try {
      const match = await store.start(request.params.id);
      broadcast(request.params.id, match);
      return { match };
    } catch (error) {
      return ruleError(reply, error);
    }
  });

  app.post<{
    Params: { id: string };
    Body: { playerId?: string; command?: GameCommand; commandId?: string; expectedRevision?: number };
  }>("/api/matches/:id/command", async (request, reply) => {
    const playerId = request.body?.playerId;
    const command = request.body?.command;
    if (!playerId || !command) return reply.code(400).send({ error: "playerId and command are required" });
    try {
      const match = await store.command(request.params.id, playerId, command, {
        ...(request.body.commandId ? { commandId: request.body.commandId } : {}),
        ...(request.body.expectedRevision !== undefined ? { expectedRevision: request.body.expectedRevision } : {}),
      });
      broadcast(request.params.id, match);
      return { match };
    } catch (error) {
      return ruleError(reply, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    "/api/matches/:id/events",
    async (request, reply) => {
      try {
        const since = Number(request.query?.since ?? 0);
        return { matchId: request.params.id, events: await store.eventsSince(request.params.id, since) };
      } catch (error) {
        return ruleError(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/matches/:id/replay", async (request, reply) => {
    try {
      return await store.exportReplay(request.params.id);
    } catch (error) {
      return ruleError(reply, error);
    }
  });

  // ---- Replay manifests + dispute workflow (simulated) ----
  // Signing is optional and pluggable; an unsigned manifest is still produced so
  // dispute filing never depends on key management being ready.
  const replaySigner: ReplaySigner = process.env.LEDGERLANDS_REPLAY_SIGNER_KEY
    ? Ed25519Signer.fromPrivateKeyBase64("server-1", process.env.LEDGERLANDS_REPLAY_SIGNER_KEY)
    : new UnsignedManifest();
  const disputes = new DisputeService();

  /**
   * Build a manifest from a replay export. `issuedAt` is wall-clock and is NOT
   * part of the hash, so the manifest is content-addressed: two independent
   * exports of the same match always produce the same `manifestHash`, which is
   * what makes filed evidence comparable.
   */
  const manifestFor = async (matchId: string) => {
    const replay = await store.exportReplay(matchId);
    return {
      replay,
      manifest: buildManifest({
        matchId: replay.matchId,
        boardVersion: replay.boardVersion,
        rulesetVersion: replay.rulesetVersion,
        seed: replay.seed,
        eventCount: replay.events.length,
        firstHash: firstChainHash(JSON.stringify(replay.events[0] ?? {})),
        finalHash: replay.chainHash,
        settlement: replay.settlement,
      }),
    };
  };

  app.get<{ Params: { id: string } }>("/api/matches/:id/replay/manifest", async (request, reply) => {
    try {
      const { replay, manifest } = await manifestFor(request.params.id);
      const signed = await signReplay(replaySigner, manifest);
      return { signed, events: replay.events };
    } catch (error) {
      return ruleError(reply, error);
    }
  });

  app.post<{
    Body: { matchId?: string; reporter?: string; category?: string; reason?: string };
  }>("/api/disputes", async (request, reply) => {
    try {
      const body = request.body ?? {};
      if (!body.matchId || !body.reporter || !body.category || !body.reason) {
        return reply.code(400).send({ error: "matchId, reporter, category and reason are required" });
      }
      const { replay, manifest } = await manifestFor(body.matchId);
      const signed = await signReplay(replaySigner, manifest);
      const dispute = disputes.open({
        matchId: body.matchId,
        reporter: body.reporter,
        category: body.category as Parameters<typeof disputes.open>[0]["category"],
        reason: body.reason,
        signed,
        events: replay.events.map((e) => ({ type: e.type, atRevision: e.atRevision })),
      });
      return reply.code(201).send({ dispute });
    } catch (error) {
      return ruleError(reply, error);
    }
  });

  app.get("/api/disputes", async (request) => {
    const q = request.query as { matchId?: string; status?: DisputeStatus };
    return {
      disputes: disputes.list({
        ...(q.matchId ? { matchId: q.matchId } : {}),
        ...(q.status ? { status: q.status } : {}),
      }),
    };
  });

  app.post<{ Params: { id: string }; Body: { reviewer?: string } }>("/api/disputes/:id/claim", async (request, reply) => {
    if (!request.body?.reviewer) return reply.code(400).send({ error: "reviewer is required" });
    try {
      return { dispute: disputes.claim(request.params.id, request.body.reviewer) };
    } catch (error) {
      return ruleError(reply, error);
    }
  });

  app.post<{
    Params: { id: string };
    Body: { reviewer?: string; outcome?: "UPHELD" | "DENIED" | "PARTIAL"; note?: string; correctiveAction?: string };
  }>("/api/disputes/:id/resolve", async (request, reply) => {
    const body = request.body ?? {};
    if (!body.reviewer || !body.outcome || !body.note) {
      return reply.code(400).send({ error: "reviewer, outcome and note are required" });
    }
    try {
      return {
        dispute: disputes.resolve(
          request.params.id,
          body.reviewer,
          body.outcome,
          body.note,
          Date.now(),
          body.correctiveAction,
        ),
      };
    } catch (error) {
      return ruleError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/disputes/:id", async (request, reply) => {
    const d = disputes.get(request.params.id);
    if (!d) return reply.code(404).send({ error: "dispute not found" });
    return { dispute: d };
  });

  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    "/api/matches/:id/resume",
    async (request, reply) => {
      try {
        if (request.query?.token) return await store.resume(request.query.token);
        return { resumeToken: await store.resumeToken(request.params.id), match: await store.get(request.params.id) };
      } catch (error) {
        return ruleError(reply, error);
      }
    },
  );

  // ---- Ranked (simulated; cosmetic-only) ----
  app.post<{
    Body: { seasonId?: string; mode?: string; a?: string; b?: string; outcomeA?: "WIN" | "LOSS" | "DRAW" };
  }>("/api/ranked/report", async (request, reply) => {
    const { seasonId = "season-1", mode = "ffa", a, b, outcomeA = "WIN" } = request.body ?? {};
    if (!a || !b || a === b) return reply.code(400).send({ error: "a and b must be distinct user ids" });
    const ka = `${seasonId}:${mode}:${a}`;
    const kb = `${seasonId}:${mode}:${b}`;
    const ra = ratings.get(ka) ?? blankRating(a, seasonId, mode);
    const rb = ratings.get(kb) ?? blankRating(b, seasonId, mode);
    const settled = settleHeadToHead(ra, rb, outcomeA);
    ratings.set(ka, settled.a);
    ratings.set(kb, settled.b);
    return { a: settled.a, b: settled.b };
  });

  app.get<{ Querystring: { season?: string; mode?: string } }>("/api/ranked/leaderboard", async (request) => {
    const season = request.query?.season ?? "season-1";
    const mode = request.query?.mode ?? "ffa";
    const rows = [...ratings.values()].filter((r) => r.seasonId === season && r.mode === mode);
    return { seasonId: season, mode, leaderboard: leaderboard(rows) };
  });

  // ---- Tournaments (simulated sats) ----
  app.post<{ Body: { name?: string; format?: string; entryFee?: number; maxPlayers?: number; rounds?: number } }>(
    "/api/tournaments",
    async (request, reply) => {
      try {
        const format = (request.body?.format ?? "SINGLE_ELIMINATION") as
          | "SINGLE_ELIMINATION"
          | "DOUBLE_ELIMINATION"
          | "SWISS"
          | "ROUND_ROBIN";
        const t = tournaments.create({
          name: request.body?.name ?? "",
          format,
          entryFee: request.body?.entryFee ?? 0,
          maxPlayers: request.body?.maxPlayers ?? 8,
          ...(format === "SWISS" && request.body?.rounds !== undefined ? { swiss: { rounds: request.body.rounds } } : {}),
        });
        return reply.code(201).send({ tournament: t });
      } catch (error) {
        return ruleError(reply, error);
      }
    },
  );

  app.get("/api/tournaments", async () => ({ tournaments: tournaments.list() }));

  app.get<{ Params: { id: string } }>("/api/tournaments/:id", async (request, reply) => {
    const t = tournaments.get(request.params.id);
    if (!t) return reply.code(404).send({ error: "tournament not found" });
    return { tournament: t };
  });

  const tny = (fn: (id: string) => unknown) => async (request: { params: { id: string } }, reply: any) => {
    try {
      return { tournament: fn(request.params.id) };
    } catch (error) {
      return ruleError(reply, error);
    }
  };
  app.post<{ Params: { id: string } }>("/api/tournaments/:id/open", tny((id) => tournaments.openRegistration(id)));
  app.post<{ Params: { id: string } }>("/api/tournaments/:id/lock", tny((id) => tournaments.lock(id)));
  app.post<{ Params: { id: string } }>("/api/tournaments/:id/start", tny((id) => tournaments.start(id)));
  app.post<{ Params: { id: string } }>("/api/tournaments/:id/cancel", tny((id) => tournaments.cancel(id)));
  app.post<{ Params: { id: string }; Body: { userId?: string } }>(
    "/api/tournaments/:id/register",
    async (request, reply) => {
      try {
        if (!request.body?.userId) return reply.code(400).send({ error: "userId is required" });
        return { tournament: tournaments.register(request.params.id, request.body.userId) };
      } catch (error) {
        return ruleError(reply, error);
      }
    },
  );
  app.post<{ Params: { id: string }; Body: { bracketMatchId?: string; winnerId?: string } }>(
    "/api/tournaments/:id/results",
    async (request, reply) => {
      try {
        if (!request.body?.bracketMatchId || !request.body?.winnerId) {
          return reply.code(400).send({ error: "bracketMatchId and winnerId are required" });
        }
        return { tournament: tournaments.reportResult(request.params.id, request.body.bracketMatchId, request.body.winnerId) };
      } catch (error) {
        return ruleError(reply, error);
      }
    },
  );

  app.post<{ Body: { accountId?: string; amount?: number } }>("/api/practice/faucet", async (request, reply) => {
    const { accountId, amount = 15000 } = request.body ?? {};
    if (!accountId) return reply.code(400).send({ error: "accountId is required" });
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000) {
      return reply.code(400).send({ error: "amount must be an integer from 1 to 100000" });
    }
    ledger.record({ accountId, amount, direction: "CREDIT", category: "practice", reference: "development-faucet" });
    return { accountId, balance: ledger.balance(accountId) };
  });

  app.get<{ Params: { accountId: string } }>("/api/practice/:accountId", async (request) => ({
    accountId: request.params.accountId,
    balance: ledger.balance(request.params.accountId),
    history: ledger.history(request.params.accountId),
  }));

  // ---- Dev auth (NOT production auth; see packages/auth) ----
  app.post<{ Body: { displayName?: string } }>("/api/auth/dev/login", async (request, reply) => {
    try {
      const { principal, token } = auth.loginDev(request.body?.displayName ?? "");
      return { principal, token, warning: "DEV-ONLY session: no MFA, no KYC, never valid for real value." };
    } catch (error) {
      return reply.code(400).send({ error: "invalid_name", message: (error as Error).message });
    }
  });

  app.get("/api/auth/me", async (request, reply) => {
    const principal = bearer(request.headers.authorization, auth);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    return { principal };
  });

  // ---- Matchmaking (durable queue; claim creates the authoritative match) ----
  const matchmakingStore = new MemoryMatchmakingStore();
  const durableMatchmaking = new DurableMatchmakingService(matchmakingStore);

  app.post<{ Body: { playerId?: string; displayName?: string; queue?: QueueName; rating?: number } }>(
    "/api/matchmaking/join",
    async (request, reply) => {
      try {
        if (!request.body?.playerId || !request.body?.displayName || !request.body?.queue) {
          return reply.code(400).send({ error: "playerId, displayName and queue are required" });
        }
        const entry = await durableMatchmaking.join({
          playerId: request.body.playerId,
          displayName: request.body.displayName,
          queue: request.body.queue,
          rating: request.body.rating ?? 1500,
        });
        return { entry };
      } catch (error) {
        return ruleError(reply, error);
      }
    },
  );

  app.post<{ Body: { playerId?: string; queue?: QueueName } }>("/api/matchmaking/leave", async (request) => ({
    removed: await durableMatchmaking.leave(request.body?.playerId ?? "", request.body?.queue),
  }));

  app.get<{ Querystring: { queue?: string } }>("/api/matchmaking/queue", async (request) => {
    const queue = (request.query?.queue ?? "CASUAL_1V1") as QueueName;
    return { queue, entries: await durableMatchmaking.queued(queue) };
  });

  app.get<{ Params: { reservationId: string } }>("/api/matchmaking/reservations/:reservationId", async (request, reply) => {
    const rows = await durableMatchmaking.reservation(request.params.reservationId);
    if (rows.length === 0) return reply.code(404).send({ error: "reservation not found" });
    return { reservationId: request.params.reservationId, entries: rows };
  });

  /**
   * One matchmaking pass. Grouping, claiming, authoritative match creation and
   * finalization all happen here so a client cannot forge a match.
   */
  app.post("/api/matchmaking/tick", async (request, reply) => {
    try {
      const created = await durableMatchmaking.tick(async ({ playerIds }) => {
        const first = playerIds[0]!;
        const started = await store.create({ playerName: first, solo: false });
        for (const pid of playerIds.slice(1)) await store.join(started.match.id, pid);
        await store.start(started.match.id);
        return started.match.id;
      });
      const assignments = [];
      for (const a of created) {
        const match = await store.get(a.matchId);
        assignments.push({ ...a, match });
      }
      broadcast("matchmaking", { assignments });
      return { assignments };
    } catch (error) {
      return ruleError(reply, error);
    }
  });

  // ---- Marketplace sandbox (simulated sats only) ----
  app.post<{ Body: { kind?: MarketplaceAssetKind; assetId?: string; ownerId?: string } }>(
    "/api/marketplace/mint",
    async (request, reply) => {
      try {
        if (!request.body?.kind || !request.body?.assetId || !request.body?.ownerId) {
          return reply.code(400).send({ error: "kind, assetId and ownerId are required" });
        }
        marketplace.registerAsset(request.body.kind, request.body.assetId, request.body.ownerId);
        return { ok: true };
      } catch (error) {
        return ruleError(reply, error);
      }
    },
  );

  app.post<{ Body: { accountId?: string; amount?: number } }>(
    "/api/marketplace/faucet",
    async (request, reply) => {
      const { accountId, amount = 5000 } = request.body ?? {};
      if (!accountId) return reply.code(400).send({ error: "accountId is required" });
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000) {
        return reply.code(400).send({ error: "amount must be an integer from 1 to 100000" });
      }
      marketLedger.post({
        playerId: accountId,
        amount,
        debitAccount: "MATCH_BANK",
        creditAccount: "PLAYER_AVAILABLE",
        type: "deposit",
        idempotencyKey: `mkt-faucet-${accountId}-${amount}-${Date.now()}`,
      });
      return { accountId, balance: marketLedger.balanceOf("PLAYER_AVAILABLE", accountId) };
    },
  );

  app.post<{ Body: { sellerId?: string; kind?: MarketplaceAssetKind; assetId?: string; price?: number } }>(
    "/api/marketplace/list",
    async (request, reply) => {
      try {
        if (!request.body?.sellerId || !request.body?.kind || !request.body?.assetId || request.body?.price === undefined) {
          return reply.code(400).send({ error: "sellerId, kind, assetId and price are required" });
        }
        const listing = marketplace.list(request.body.sellerId, request.body.kind, request.body.assetId, request.body.price);
        return reply.code(201).send({ listing });
      } catch (error) {
        return ruleError(reply, error);
      }
    },
  );

  app.post<{ Body: { buyerId?: string; listingId?: string; idempotencyKey?: string } }>(
    "/api/marketplace/buy",
    async (request, reply) => {
      try {
        if (!request.body?.buyerId || !request.body?.listingId || !request.body?.idempotencyKey) {
          return reply.code(400).send({ error: "buyerId, listingId and idempotencyKey are required" });
        }
        const listing = marketplace.buy(request.body.buyerId, request.body.listingId, request.body.idempotencyKey);
        return { listing };
      } catch (error) {
        return ruleError(reply, error);
      }
    },
  );

  app.get("/api/marketplace/listings", async () => ({ listings: marketplace.listOpen() }));

  function attachSockets(): void {
    const wss = new WebSocketServer({ server: app.server, path: "/ws" });
    wss.on("connection", (socket) => {
      const heartbeat = setInterval(() => {
        if (socket.readyState === socket.OPEN) socket.ping();
      }, 30000);
      socket.on("message", async (raw) => {
        try {
          const message = JSON.parse(raw.toString()) as { type?: string; matchId?: string };
          if (message.type !== "subscribe" || !message.matchId) return;
          let set = subscriptions.get(message.matchId);
          if (!set) {
            set = new Set();
            subscriptions.set(message.matchId, set);
          }
          set.add(socket);
          const match = await store.get(message.matchId);
          if (match) socket.send(JSON.stringify({ type: "match_state", match }));
          socket.once("close", () => {
            set?.delete(socket);
            clearInterval(heartbeat);
          });
        } catch {
          socket.send(JSON.stringify({ type: "error", message: "invalid websocket message" }));
        }
      });
      socket.once("close", () => clearInterval(heartbeat));
    });
  }

  return { app, store, tournaments, ratings, broadcast, attachSockets };
}

function bearer(header: string | undefined, auth: DevAuthAdapter): AuthPrincipal | null {
  if (!header?.startsWith("Bearer ")) return null;
  return auth.verifyToken(header.slice("Bearer ".length));
}

function ruleError(reply: any, error: unknown) {
  if (error instanceof GameRuleError) {
    const status = error.code === "STALE_STATE" ? 412 : error.code === "MATCH_NOT_FOUND" ? 404 : 409;
    return reply.code(status).send({ error: error.code, message: error.message });
  }
  if (error instanceof MatchmakingError) {
    return reply.code(409).send({ error: error.code, message: error.message });
  }
  if (error instanceof MarketplaceError) {
    return reply.code(409).send({ error: error.code, message: error.message });
  }
  if (error instanceof TournamentError) {
    const status = error.code === "NOT_FOUND" ? 404 : 409;
    return reply.code(status).send({ error: error.code, message: error.message });
  }
  if (error instanceof ConcurrencyError) {
    return reply.code(409).send({ error: error.code, message: `${error.message} Reload and retry.` });
  }
  if (error instanceof DisputeError) {
    return reply.code(409).send({ error: error.code, message: error.message });
  }
  if (error instanceof SigningError) {
    return reply.code(500).send({ error: error.code, message: error.message });
  }
  // eslint-disable-next-line no-console
  console.error(error);
  return reply.code(500).send({ error: "internal_error" });
}

// Only listen when executed directly (tests import buildApp with LL_NO_LISTEN=1).
if (process.env.LL_NO_LISTEN !== "1") {
  const { resolveMatchBackend } = await import("./prisma.js");
  const { backend, persistence } = await resolveMatchBackend();
  const { app, attachSockets } = buildApp({ backend, persistence });
  attachSockets();
  const port = Number(process.env.API_PORT ?? 8787);
  await app.listen({ host: "0.0.0.0", port });
}
