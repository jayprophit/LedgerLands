import { useEffect, useMemo, useState } from "react";
import type { BoardTile, MatchState } from "@ledgerlands/shared-types";
import { createMatch, getBoard, sendCommand, subscribe } from "./api";

export function App() {
  const [board, setBoard] = useState<BoardTile[]>([]);
  const [match, setMatch] = useState<MatchState>();
  const [playerId, setPlayerId] = useState<string>();
  const [name, setName] = useState("Player One");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => { getBoard().then(setBoard).catch((e) => setError(e.message)); }, []);
  useEffect(() => match?.id ? subscribe(match.id, setMatch) : undefined, [match?.id]);

  const me = match?.players.find((p) => p.id === playerId);
  const current = match?.players[match.currentPlayerIndex];
  const currentTile = current && board[current.position];
  const myTurn = Boolean(match && me && current?.id === me.id && match.status === "ACTIVE");
  const ownedHere = currentTile ? match?.properties[currentTile.id] : undefined;
  const canBuy = Boolean(myTurn && match?.turnPhase === "ACTION" && currentTile && ownedHere && !ownedHere.ownerId);

  const eventLog = useMemo(() => [...(match?.log ?? [])].slice(-10).reverse(), [match?.log]);

  async function run(action: () => Promise<MatchState>) {
    setBusy(true); setError(undefined);
    try { setMatch(await action()); } catch (e) { setError(e instanceof Error ? e.message : "Action failed"); }
    finally { setBusy(false); }
  }

  async function start() {
    setBusy(true); setError(undefined);
    try {
      const created = await createMatch(name.trim() || "Player One");
      setMatch(created.match); setPlayerId(created.playerId);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create match"); }
    finally { setBusy(false); }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">AETHERIUS OS · GAMES</div>
          <h1>LedgerLands</h1>
          <p>Deterministic property strategy with practice-value gameplay.</p>
        </div>
        <div className="status-pill">{match ? `${match.status} · R${match.revision}` : "READY"}</div>
      </header>

      {!match ? (
        <section className="launch-card">
          <h2>Start Solo Match</h2>
          <p>The development build uses practice units only. Real-value wallet operations are disabled.</p>
          <label>Player name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <button disabled={busy} onClick={start}>{busy ? "Starting…" : "Launch Match"}</button>
        </section>
      ) : (
        <div className="workspace">
          <section className="board" aria-label="LedgerLands board">
            {board.map((tile, index) => {
              const occupants = match.players.filter((p) => p.position === index && !p.bankrupt);
              const prop = match.properties[tile.id];
              return (
                <article key={tile.id} className={`tile tile-${tile.type.toLowerCase()}`}>
                  <span className="tile-index">{index}</span>
                  <strong>{tile.name}</strong>
                  <small>{tile.type.replaceAll("_", " ")}</small>
                  {tile.economics && <span className="price">{tile.economics.purchasePrice} u</span>}
                  {prop?.ownerId && <span className="owner">Owned</span>}
                  <div className="tokens">
                    {occupants.map((p) => <span key={p.id} title={p.name} className={p.id === playerId ? "token mine" : "token"}>{p.id.startsWith("bot-") ? "AI" : p.name.slice(0, 2).toUpperCase()}</span>)}
                  </div>
                </article>
              );
            })}
          </section>

          <aside className="sidebar">
            <section className="panel">
              <h2>Match Control</h2>
              <div className="turn-line"><span>Current</span><strong>{current?.name}</strong></div>
              <div className="turn-line"><span>Phase</span><strong>{match.turnPhase}</strong></div>
              <div className="turn-line"><span>Dice</span><strong>{match.lastDice?.join(" + ") ?? "—"}</strong></div>
              <div className="actions">
                <button disabled={!myTurn || match.turnPhase !== "ROLL" || busy} onClick={() => run(() => sendCommand(match.id, playerId!, { type: "ROLL_DICE" }))}>Roll Dice</button>
                <button disabled={!canBuy || busy} onClick={() => run(() => sendCommand(match.id, playerId!, { type: "BUY_PROPERTY", playerId: playerId!, tileId: currentTile!.id }))}>Buy Tile</button>
                <button disabled={!myTurn || match.turnPhase !== "ACTION" || busy} onClick={() => run(() => sendCommand(match.id, playerId!, { type: "END_TURN", playerId: playerId! }))}>End Turn</button>
              </div>
              {error && <p className="error">{error}</p>}
            </section>

            <section className="panel">
              <h2>Players</h2>
              {match.players.map((p) => <div className={`player-row ${p.id === current?.id ? "current" : ""}`} key={p.id}><span>{p.name}{p.bankrupt ? " · OUT" : ""}</span><strong>{p.balance} u</strong></div>)}
            </section>

            <section className="panel log-panel">
              <h2>Event Ledger</h2>
              {eventLog.map((event, i) => <code key={`${event.atRevision}-${i}`}>R{event.atRevision} · {event.type}</code>)}
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}
