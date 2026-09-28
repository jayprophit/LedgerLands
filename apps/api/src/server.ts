import Fastify, { type FastifyInstance } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import type { GameCommand } from "@ledgerlands/shared-types";
import { BOARD_VERSION, DEFAULT_BOARD, GameRuleError, RULESET_VERSION } from "@ledgerlands/game-engine";
import { FileBackend, MemoryBackend, PersistentMatchStore } from "@ledgerlands/match-store";
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

export function buildApp(): BuiltApp {
  const app = Fastify({ logger: false });
  const dataDir = process.env.LEDGERLANDS_DATA_DIR;
  const store = new PersistentMatchStore(dataDir ? new FileBackend(dataDir) : new MemoryBackend());
  const ledger = new PracticeLedger();
  const tournaments = new TournamentService();
  const ratings = new Map<string, PlayerRating>();
  const subscriptions = new Map<string, Set<WebSocket>>();

  function broadcast(matchId: string, match: unknown): void {
    const sockets = subscriptions.get(matchId);
    if (!sockets) return;
    const message = JSON.stringify({ type: "match_state", match });
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(message);
    }
  }

  app.addHook("onRequest", async (_request, reply) => {
    reply.header("access-control-allow-origin", process.env.CORS_ORIGIN ?? "http://localhost:5173");
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
    persistence: dataDir ? "file" : "memory",
    realValueFeaturesEnabled: false,
  });
  app.get("/health", health);
  app.get("/api/v1/health", health);

  const board = async () => ({ tiles: DEFAULT_BOARD, boardVersion: BOARD_VERSION, rulesetVersion: RULESET_VERSION });
  app.get("/api/board", board);
  app.get("/api/v1/board", board);
  app.get("/api/matches", async () => ({ matches: store.list() }));
  app.get("/api/v1/matches", async () => ({ matches: store.list() }));

  app.post<{
    Body: { playerName?: string; startingBalance?: number; seed?: number; solo?: boolean; difficulty?: string };
  }>("/api/matches", async (request, reply) => {
    try {
      const { match, playerId } = store.create({
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
    const match = store.get(request.params.id);
    if (!match) return reply.code(404).send({ error: "match not found" });
    return { match };
  });

  app.post<{ Params: { id: string }; Body: { playerName?: string; startingBalance?: number } }>(
    "/api/matches/:id/join",
    async (request, reply) => {
      try {
        const { match, playerId } = store.join(request.params.id, request.body?.playerName ?? "", request.body?.startingBalance ?? 15000);
        broadcast(request.params.id, match);
        return reply.code(201).send({ match, playerId });
      } catch (error) {
        return ruleError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/matches/:id/start", async (request, reply) => {
    try {
      const match = store.start(request.params.id);
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
      const match = store.command(request.params.id, playerId, command, {
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
        return { matchId: request.params.id, events: store.eventsSince(request.params.id, since) };
      } catch (error) {
        return ruleError(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/matches/:id/replay", async (request, reply) => {
    try {
      return store.exportReplay(request.params.id);
    } catch (error) {
      return ruleError(reply, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    "/api/matches/:id/resume",
    async (request, reply) => {
      try {
        if (request.query?.token) return store.resume(request.query.token);
        return { resumeToken: store.resumeToken(request.params.id), match: store.get(request.params.id) };
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
  app.post<{ Body: { name?: string; entryFee?: number; maxPlayers?: number } }>(
    "/api/tournaments",
    async (request, reply) => {
      try {
        const t = tournaments.create({ name: request.body?.name ?? "", entryFee: request.body?.entryFee ?? 0, maxPlayers: request.body?.maxPlayers ?? 8 });
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

  function attachSockets(): void {
    const wss = new WebSocketServer({ server: app.server, path: "/ws" });
    wss.on("connection", (socket) => {
      const heartbeat = setInterval(() => {
        if (socket.readyState === socket.OPEN) socket.ping();
      }, 30000);
      socket.on("message", (raw) => {
        try {
          const message = JSON.parse(raw.toString()) as { type?: string; matchId?: string };
          if (message.type !== "subscribe" || !message.matchId) return;
          let set = subscriptions.get(message.matchId);
          if (!set) {
            set = new Set();
            subscriptions.set(message.matchId, set);
          }
          set.add(socket);
          const match = store.get(message.matchId);
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

function ruleError(reply: any, error: unknown) {
  if (error instanceof GameRuleError) {
    const status = error.code === "STALE_STATE" ? 412 : error.code === "MATCH_NOT_FOUND" ? 404 : 409;
    return reply.code(status).send({ error: error.code, message: error.message });
  }
  if (error instanceof TournamentError) {
    const status = error.code === "NOT_FOUND" ? 404 : 409;
    return reply.code(status).send({ error: error.code, message: error.message });
  }
  // eslint-disable-next-line no-console
  console.error(error);
  return reply.code(500).send({ error: "internal_error" });
}

// Only listen when executed directly (tests import buildApp with LL_NO_LISTEN=1).
if (process.env.LL_NO_LISTEN !== "1") {
  const { app, attachSockets } = buildApp();
  attachSockets();
  const port = Number(process.env.API_PORT ?? 8787);
  await app.listen({ host: "0.0.0.0", port });
}
