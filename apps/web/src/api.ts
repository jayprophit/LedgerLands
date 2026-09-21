import type { BoardTile, GameCommand, MatchState } from "@ledgerlands/shared-types";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

async function json<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? body.error ?? "Request failed");
  return body as T;
}

export async function getBoard(): Promise<BoardTile[]> {
  const response = await fetch(`${API_URL}/api/board`);
  return (await json<{ tiles: BoardTile[] }>(response)).tiles;
}

export async function createMatch(playerName: string): Promise<{ match: MatchState; playerId: string }> {
  const response = await fetch(`${API_URL}/api/matches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerName, solo: true }),
  });
  return json(response);
}

export async function sendCommand(matchId: string, playerId: string, command: GameCommand): Promise<MatchState> {
  const response = await fetch(`${API_URL}/api/matches/${matchId}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId, command }),
  });
  return (await json<{ match: MatchState }>(response)).match;
}

export function subscribe(matchId: string, onState: (state: MatchState) => void): () => void {
  const url = new URL(API_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  const socket = new WebSocket(url.toString());
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "subscribe", matchId })));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data) as { type: string; match?: MatchState };
    if (message.type === "match_state" && message.match) onState(message.match);
  });
  return () => socket.close();
}
