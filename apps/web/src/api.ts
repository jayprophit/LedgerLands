import type { BoardTile, GameCommand, MatchState } from "@ledgerlands/shared-types";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

async function json<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error((body as { message?: string; error?: string }).message ?? (body as { error?: string }).error ?? "Request failed");
  return body as T;
}

export async function getBoard(): Promise<BoardTile[]> {
  const response = await fetch(`${API_URL}/api/board`);
  return (await json<{ tiles: BoardTile[] }>(response)).tiles;
}

export async function createMatch(
  playerName: string,
  opts?: { difficulty?: string; seed?: number },
): Promise<{ match: MatchState; playerId: string }> {
  const response = await fetch(`${API_URL}/api/matches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerName, solo: true, difficulty: opts?.difficulty ?? "NORMAL", ...(opts?.seed !== undefined ? { seed: opts.seed } : {}) }),
  });
  return json(response);
}

export async function sendCommand(matchId: string, playerId: string, command: GameCommand): Promise<MatchState> {
  const response = await fetch(`${API_URL}/api/matches/${matchId}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId, command, commandId: `${Date.now()}-${Math.random().toString(36).slice(2)}` }),
  });
  return (await json<{ match: MatchState }>(response)).match;
}

export async function fetchReplay(matchId: string): Promise<{
  rulesetVersion: string;
  boardVersion: string;
  seed: number;
  players: Array<{ id: string; name: string }>;
  events: Array<{ type: string; atRevision: number }>;
  settlement: { winnerId?: string; balances: Record<string, number> };
  chainHash: string;
}> {
  const response = await fetch(`${API_URL}/api/matches/${matchId}/replay`);
  return json(response);
}

export async function fetchLeaderboard(season = "season-1", mode = "ffa"): Promise<{
  leaderboard: Array<{ userId: string; rating: number; tier: string; rank: number; wins: number; losses: number }>;
}> {
  const response = await fetch(`${API_URL}/api/ranked/leaderboard?season=${season}&mode=${mode}`);
  return json(response);
}

export interface WebTournament {
  id: string;
  name: string;
  status: string;
  entryFee: number;
  maxPlayers: number;
  entries: string[];
  bracket: Array<{ id: string; round: number; seedA?: string; seedB?: string; winnerId?: string }>;
  championId?: string;
}

export async function listTournaments(): Promise<{ tournaments: WebTournament[] }> {
  return json(await fetch(`${API_URL}/api/tournaments`));
}

export async function tournamentAction(id: string, action: "open" | "lock" | "start" | "cancel", body?: unknown): Promise<{ tournament: WebTournament }> {
  const response = await fetch(`${API_URL}/api/tournaments/${id}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return json(response);
}

export async function createTournament(name: string): Promise<{ tournament: WebTournament }> {
  const response = await fetch(`${API_URL}/api/tournaments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, entryFee: 0, maxPlayers: 4 }),
  });
  return json(response);
}

export async function registerTournament(id: string, userId: string): Promise<{ tournament: WebTournament }> {
  const response = await fetch(`${API_URL}/api/tournaments/${id}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  return json(response);
}

export async function reportTournamentResult(id: string, bracketMatchId: string, winnerId: string): Promise<{ tournament: WebTournament }> {
  const response = await fetch(`${API_URL}/api/tournaments/${id}/results`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bracketMatchId, winnerId }),
  });
  return json(response);
}

export function subscribe(matchId: string, onState: (state: MatchState) => void): () => void {
  const url = new URL(API_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  const socket = new WebSocket(url.toString());
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "subscribe", matchId })));
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data as string) as { type: string; match?: MatchState };
      if (message.type === "match_state" && message.match) onState(message.match);
    } catch {
      /* ignore */
    }
  });
  return () => socket.close();
}
