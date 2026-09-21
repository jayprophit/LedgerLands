import Fastify from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import type { GameCommand } from "@ledgerlands/shared-types";
import { DEFAULT_BOARD, GameRuleError } from "@ledgerlands/game-engine";
import { MatchStore } from "./store.js";
import { PracticeLedger } from "./ledger.js";

const app = Fastify({ logger: true });
const store = new MatchStore();
const ledger = new PracticeLedger();
const subscriptions = new Map<string, Set<WebSocket>>();

app.addHook("onRequest", async (_request, reply) => {
  reply.header("access-control-allow-origin", process.env.CORS_ORIGIN ?? "http://localhost:5173");
  reply.header("access-control-allow-headers", "content-type,authorization,x-player-id");
  reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
});

app.options("*", async (_request, reply) => reply.code(204).send());

app.get("/health", async () => ({
  status: "ok",
  app: "com.aetherius.ledgerlands",
  version: "0.1.0",
  realValueFeaturesEnabled: false,
}));

app.get("/api/board", async () => ({ tiles: DEFAULT_BOARD }));
app.get("/api/matches", async () => ({ matches: store.list() }));

app.post<{ Body: { playerName?: string; startingBalance?: number; seed?: number; solo?: boolean } }>(
  "/api/matches",
  async (request, reply) => {
    const playerName = request.body?.playerName?.trim();
    if (!playerName) return reply.code(400).send({ error: "playerName is required" });
    const state = store.create({
      playerName,
      ...(request.body.startingBalance !== undefined ? { startingBalance: request.body.startingBalance } : {}),
      ...(request.body.seed !== undefined ? { seed: request.body.seed } : {}),
      ...(request.body.solo !== undefined ? { solo: request.body.solo } : {}),
    });
    const human = state.players.find((p) => !p.id.startsWith("bot-"));
    return reply.code(201).send({ match: state, playerId: human?.id });
  },
);

app.get<{ Params: { id: string } }>("/api/matches/:id", async (request, reply) => {
  const match = store.get(request.params.id);
  if (!match) return reply.code(404).send({ error: "match not found" });
  return { match };
});

app.post<{ Params: { id: string }; Body: { playerName?: string; startingBalance?: number } }>(
  "/api/matches/:id/join",
  async (request, reply) => {
    const playerName = request.body?.playerName?.trim();
    if (!playerName) return reply.code(400).send({ error: "playerName is required" });
    try {
      const match = store.join(request.params.id, playerName, request.body.startingBalance ?? 15000);
      const player = match.players.at(-1);
      broadcast(request.params.id, match);
      return reply.code(201).send({ match, playerId: player?.id });
    } catch (error) {
      return ruleError(reply, error);
    }
  },
);

app.post<{ Params: { id: string }; Body: { playerId?: string; command?: GameCommand } }>(
  "/api/matches/:id/command",
  async (request, reply) => {
    const playerId = request.body?.playerId;
    const command = request.body?.command;
    if (!playerId || !command) return reply.code(400).send({ error: "playerId and command are required" });
    try {
      const match = store.command(request.params.id, playerId, command);
      broadcast(request.params.id, match);
      return { match };
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

function ruleError(reply: any, error: unknown) {
  if (error instanceof GameRuleError) {
    return reply.code(409).send({ error: error.code, message: error.message });
  }
  app.log.error(error);
  return reply.code(500).send({ error: "internal_error" });
}

const wss = new WebSocketServer({ server: app.server, path: "/ws" });
wss.on("connection", (socket) => {
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
      socket.once("close", () => set?.delete(socket));
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "invalid websocket message" }));
    }
  });
});

function broadcast(matchId: string, match: unknown): void {
  const sockets = subscriptions.get(matchId);
  if (!sockets) return;
  const message = JSON.stringify({ type: "match_state", match });
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(message);
  }
}

const port = Number(process.env.API_PORT ?? 8787);
await app.listen({ host: "0.0.0.0", port });
