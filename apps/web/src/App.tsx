import { useEffect, useMemo, useState } from "react";
import type { BoardTile, GameCommand, MatchState } from "@ledgerlands/shared-types";
import {
  createMatch,
  createTournament,
  fetchLeaderboard,
  fetchReplay,
  getBoard,
  listTournaments,
  registerTournament,
  reportTournamentResult,
  sendCommand,
  subscribe,
  tournamentAction,
  type WebTournament,
} from "./api";
import { QUESTS, RARITY_COLORS, TOKENS, dailyShop } from "./game-data";

type Tab = "play" | "wallet" | "quests" | "inventory" | "shop" | "ranked" | "tournaments";

interface Profile {
  name: string;
  tokenId: string;
  mainBalance: number;
  ownedTokens: string[];
  questProgress: Record<string, number>;
  questsClaimed: string[];
  lastLoginRewardDay: string;
  matchesPlayed: number;
  matchesWon: number;
}

const PROFILE_KEY = "ledgerlands.profile.v1";

function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) return JSON.parse(raw) as Profile;
  } catch {
    /* fresh */
  }
  return {
    name: "Player One",
    tokenId: "spire-fox",
    mainBalance: 15000,
    ownedTokens: ["spire-fox", "tide-golem"],
    questProgress: {},
    questsClaimed: [],
    lastLoginRewardDay: "",
    matchesPlayed: 0,
    matchesWon: 0,
  };
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function App() {
  const [board, setBoard] = useState<BoardTile[]>([]);
  const [match, setMatch] = useState<MatchState>();
  const [playerId, setPlayerId] = useState<string>();
  const [profile, setProfile] = useState<Profile>(loadProfile);
  const [tab, setTab] = useState<Tab>("play");
  const [name, setName] = useState(profile.name);
  const [difficulty, setDifficulty] = useState("NORMAL");
  const [tier, setTier] = useState<"starter" | "standard" | "highRoller">("standard");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [bidAmount, setBidAmount] = useState("500");
  const [tradeTo, setTradeTo] = useState("");
  const [tradeOfferSats, setTradeOfferSats] = useState("0");
  const [tradeOfferProps, setTradeOfferProps] = useState<string[]>([]);
  const [tradeRequestProps, setTradeRequestProps] = useState<string[]>([]);
  const [loginReward, setLoginReward] = useState<number | null>(null);
  const [replay, setReplay] = useState<{
    chainHash: string;
    rulesetVersion: string;
    boardVersion: string;
    events: Array<{ type: string; atRevision: number }>;
    settlement: { winnerId?: string; balances: Record<string, number> };
  } | null>(null);
  const [leaderboard, setLeaderboard] = useState<Array<{ userId: string; rating: number; tier: string; rank: number; wins: number; losses: number }>>([]);
  const [tournaments, setTournaments] = useState<WebTournament[]>([]);
  const [tnyName, setTnyName] = useState("Friday Cup");

  useEffect(() => {
    getBoard().then(setBoard).catch((e) => setError(e instanceof Error ? e.message : "Board load failed"));
  }, []);
  useEffect(() => (match?.id ? subscribe(match.id, setMatch) : undefined), [match?.id]);
  useEffect(() => {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  }, [profile]);

  // Daily login reward: 50-1000 simulated sats, once per day.
  useEffect(() => {
    const day = todayKey();
    if (profile.lastLoginRewardDay !== day) {
      const reward = 50 + Math.floor(Math.random() * 951);
      setProfile((p) => ({ ...p, mainBalance: p.mainBalance + reward, lastLoginRewardDay: day }));
      setLoginReward(reward);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const me = match?.players.find((p) => p.id === playerId);
  const current = match?.players[match.currentPlayerIndex];
  const currentTile = current && board[current.position];
  const myTurn = Boolean(match && me && current?.id === me.id && match.status === "ACTIVE" && !me.bankrupt);
  const myTile = me && board[me.position];
  const myProp = myTile ? match?.properties[myTile.id] : undefined;
  const canBuy = Boolean(myTurn && match?.turnPhase === "ACTION" && myTile && myProp && !myProp.ownerId);
  const canDecline = canBuy && !match?.auction;
  const auction = match?.auction;
  const pendingTrades = useMemo(
    () => (match?.trades ?? []).filter((t) => t.status === "PROPOSED" && (t.toPlayerId === playerId || t.fromPlayerId === playerId)),
    [match?.trades, playerId],
  );
  const eventLog = useMemo(() => [...(match?.log ?? [])].slice(-14).reverse(), [match?.log]);

  const questProgressView = useMemo(() => {
    if (!match) return profile.questProgress;
    const counts: Record<string, number> = { ...profile.questProgress };
    counts["play-1"] = Math.max(counts["play-1"] ?? 0, profile.matchesPlayed + (match.status === "COMPLETED" ? 1 : 0));
    const passCount = match.log.filter((e) => e.type === "PASSED_START" && (e as { playerId?: string }).playerId === playerId).length;
    counts["pass-start-5"] = (profile.questProgress["pass-start-5"] ?? 0) + passCount;
    const buys = match.log.filter((e) => e.type === "PROPERTY_BOUGHT" && (e as { playerId?: string }).playerId === playerId).length;
    counts["buy-3"] = (profile.questProgress["buy-3"] ?? 0) + buys;
    const rents = match.log.filter((e) => e.type === "RENT_PAID" && (e as { toPlayerId?: string }).toPlayerId === playerId).length;
    counts["rent-5"] = (profile.questProgress["rent-5"] ?? 0) + rents;
    const builds = match.log.filter((e) => e.type === "PROPERTY_DEVELOPED" && (e as { playerId?: string }).playerId === playerId).length;
    counts["build-1"] = (profile.questProgress["build-1"] ?? 0) + builds;
    return counts;
  }, [match, profile, playerId]);

  async function run(action: () => Promise<MatchState>) {
    setBusy(true);
    setError(undefined);
    try {
      setMatch(await action());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  function cmd(c: GameCommand) {
    if (!match || !playerId) return Promise.reject(new Error("No match"));
    return sendCommand(match.id, playerId, c);
  }

  async function start() {
    setBusy(true);
    setError(undefined);
    try {
      const balances = { starter: 5000, standard: 15000, highRoller: 30000 } as const;
      void balances;
      const created = await createMatch(name.trim() || "Player One", { difficulty });
      setMatch(created.match);
      setPlayerId(created.playerId);
      setTradeTo(created.match.players.find((p) => p.id !== created.playerId)?.id ?? "");
      setProfile((p) => ({ ...p, name: name.trim() || "Player One" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create match");
    } finally {
      setBusy(false);
    }
  }

  // Settlement: when match completes, credit winnings + update quests.
  useEffect(() => {
    if (match?.status === "COMPLETED" && me) {
      setProfile((p) => {
        if (p.matchesPlayed > 0 && (p.questProgress["play-1"] ?? 0) >= 1 && match.turn === 0) return p;
        const won = match.winnerId === me.id;
        const winnings = won ? Math.max(0, me.balance) : 0;
        return {
          ...p,
          mainBalance: p.mainBalance + winnings,
          matchesPlayed: p.matchesPlayed + 1,
          matchesWon: p.matchesWon + (won ? 1 : 0),
          questProgress: {
            ...p.questProgress,
            "play-1": (p.questProgress["play-1"] ?? 0) + 1,
            "win-1": (p.questProgress["win-1"] ?? 0) + (won ? 1 : 0),
          },
        };
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match?.status]);

  const shop = useMemo(() => dailyShop(new Date().getDate() + new Date().getMonth() * 31), []);

  function claimQuest(code: string) {
    const def = QUESTS.find((q) => q.code === code);
    if (!def) return;
    const progress = questProgressView[code] ?? profile.questProgress[code] ?? 0;
    if (progress < def.target || profile.questsClaimed.includes(code)) return;
    setProfile((p) => ({
      ...p,
      mainBalance: p.mainBalance + def.reward,
      questsClaimed: [...p.questsClaimed, code],
    }));
  }

  function buyShopItem(tokenId: string, price: number) {
    if (profile.mainBalance < price || profile.ownedTokens.includes(tokenId)) return;
    setProfile((p) => ({ ...p, mainBalance: p.mainBalance - price, ownedTokens: [...p.ownedTokens, tokenId] }));
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">AETHERIUS OS · GAMES</div>
          <h1>LedgerLands</h1>
          <p>Original property strategy · practice sats only · real-value disabled.</p>
          {loginReward !== null && <p className="reward-line">Daily login reward: +{loginReward} sim-sats.</p>}
        </div>
        <div className="status-pill">
          {match ? `${match.status} · R${match.revision} · ${match.rulesetVersion ?? "classic-v1"}` : "READY"} · 💰 {profile.mainBalance}
        </div>
      </header>

      <nav className="tabs" aria-label="Sections">
        {(["play", "wallet", "quests", "inventory", "shop", "ranked", "tournaments"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      {tab === "play" && !match && (
        <section className="launch-card">
          <h2>Start Solo Match</h2>
          <p>Practice units only. New profiles start with 15,000 sim-sats and two common tokens.</p>
          <label>
            Player name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          </label>
          <label>
            Token
            <select value={profile.tokenId} onChange={(e) => setProfile((p) => ({ ...p, tokenId: e.target.value }))}>
              {TOKENS.filter((t) => profile.ownedTokens.includes(t.id)).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.emoji} {t.name} ({t.rarity})
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <label>
              Difficulty
              <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
                {["BEGINNER", "EASY", "NORMAL", "HARD", "EXPERT"].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Starting balance
              <select value={tier} onChange={(e) => setTier(e.target.value as typeof tier)}>
                <option value="starter">Starter · 5,000</option>
                <option value="standard">Standard · 15,000</option>
                <option value="highRoller">High-roller · 30,000</option>
              </select>
            </label>
          </div>
          <button disabled={busy} onClick={start}>
            {busy ? "Starting…" : "Launch Match"}
          </button>
          {error && <p className="error">{error}</p>}
        </section>
      )}

      {tab === "play" && match && (
        <div className="workspace">
          <section className="board" aria-label="LedgerLands board">
            {board.map((tile, index) => {
              const occupants = match.players.filter((p) => p.position === index && !p.bankrupt);
              const prop = match.properties[tile.id];
              return (
                <article key={tile.id} className={`tile tile-${tile.type.toLowerCase()}`}>
                  <span className="tile-index">{index}</span>
                  <strong>{tile.name}</strong>
                  <small>
                    {tile.type.replaceAll("_", " ")}
                    {tile.group ? ` · ${tile.group}` : ""}
                  </small>
                  {tile.economics && <span className="price">{tile.economics.purchasePrice} sats</span>}
                  {(tile.type === "TRANSIT" || tile.type === "SERVICE") && tile.amount && (
                    <span className="price">{tile.amount} sats</span>
                  )}
                  {prop?.ownerId && (
                    <span className="owner">
                      {match.players.find((p) => p.id === prop.ownerId)?.name ?? "Owned"}
                      {prop.development > 0 ? ` · Lv${prop.development}` : ""}
                      {prop.mortgaged ? " · MORTGAGED" : ""}
                    </span>
                  )}
                  <div className="tokens">
                    {occupants.map((p) => (
                      <span key={p.id} title={p.name} className={p.id === playerId ? "token mine" : "token"}>
                        {p.id.startsWith("bot-") ? "AI" : p.name.slice(0, 2).toUpperCase()}
                      </span>
                    ))}
                  </div>
                </article>
              );
            })}
          </section>

          <aside className="sidebar">
            <section className="panel">
              <h2>Match Control</h2>
              <div className="turn-line">
                <span>Current</span>
                <strong>{current?.name}</strong>
              </div>
              <div className="turn-line">
                <span>Phase</span>
                <strong>{match.turnPhase}</strong>
              </div>
              <div className="turn-line">
                <span>Dice</span>
                <strong>{match.lastDice?.join(" + ") ?? "—"}</strong>
              </div>
              <div className="turn-line">
                <span>On tile</span>
                <strong>{currentTile?.name ?? "—"}</strong>
              </div>
              {me && (
                <div className="turn-line">
                  <span>You</span>
                  <strong>
                    {me.balance} sats{me.inDetention ? " · DETAINED" : ""}
                    {(me.detentionCards ?? 0) > 0 ? ` · 🎫×${me.detentionCards}` : ""}
                  </strong>
                </div>
              )}
              <div className="actions">
                <button disabled={!myTurn || match.turnPhase !== "ROLL" || busy} onClick={() => run(() => cmd({ type: "ROLL_DICE" }))}>
                  Roll Dice
                </button>
                <button disabled={!canBuy || busy} onClick={() => run(() => cmd({ type: "BUY_PROPERTY", playerId: playerId!, tileId: myTile!.id }))}>
                  Buy ({myTile?.economics?.purchasePrice ?? myTile?.amount ?? 0} sats)
                </button>
                <button disabled={!canDecline || busy} onClick={() => run(() => cmd({ type: "DECLINE_PROPERTY", playerId: playerId! }))}>
                  Decline → Auction
                </button>
                <button
                  disabled={!myTurn || match.turnPhase !== "ACTION" || busy || !myTile || !myProp?.ownerId || myProp.ownerId !== playerId}
                  onClick={() => run(() => cmd({ type: "DEVELOP_PROPERTY", playerId: playerId!, tileId: myTile!.id }))}
                >
                  Develop
                </button>
                <div className="row">
                  <button
                    disabled={!myTile || !myProp || myProp.ownerId !== playerId || myProp.mortgaged || busy}
                    onClick={() => run(() => cmd({ type: "MORTGAGE_PROPERTY", playerId: playerId!, tileId: myTile!.id }))}
                  >
                    Mortgage
                  </button>
                  <button
                    disabled={!myTile || !myProp || myProp.ownerId !== playerId || !myProp.mortgaged || busy}
                    onClick={() => run(() => cmd({ type: "UNMORTGAGE_PROPERTY", playerId: playerId!, tileId: myTile!.id }))}
                  >
                    Unmortgage
                  </button>
                </div>
                {me?.inDetention && (
                  <div className="row">
                    <button disabled={busy} onClick={() => run(() => cmd({ type: "PAY_DETENTION_FINE", playerId: playerId! }))}>
                      Pay 50 fine
                    </button>
                    <button disabled={busy || (me.detentionCards ?? 0) <= 0} onClick={() => run(() => cmd({ type: "USE_DETENTION_CARD", playerId: playerId! }))}>
                      Use pardon chip
                    </button>
                  </div>
                )}
                <button disabled={!myTurn || match.turnPhase !== "ACTION" || busy} onClick={() => run(() => cmd({ type: "END_TURN", playerId: playerId! }))}>
                  End Turn{match.pendingExtraRoll ? " (extra roll → Roll again)" : ""}
                </button>
                <button disabled={busy || match.status !== "ACTIVE"} onClick={() => run(() => cmd({ type: "SURRENDER", playerId: playerId! }))}>
                  Surrender
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    setMatch(undefined);
                    setPlayerId(undefined);
                  }}
                >
                  Leave match
                </button>
              </div>
              {error && <p className="error">{error}</p>}
              {match.status === "COMPLETED" && (
                <p className="reward-line">
                  {match.winnerId === playerId ? `Victory! Winnings (${me?.balance ?? 0} sats) added to main wallet.` : "Match over. Better luck next time."}
                </p>
              )}
            </section>

            <section className="panel">
              <h2>Auction</h2>
              {!auction && <p className="muted">No active auction.</p>}
              {auction && (
                <>
                  <div className="turn-line">
                    <span>Tile</span>
                    <strong>{board.find((t) => t.id === auction.tileId)?.name}</strong>
                  </div>
                  <div className="turn-line">
                    <span>Highest</span>
                    <strong>{auction.highestBid ? `${auction.highestBid.amount} by ${match.players.find((p) => p.id === auction.highestBid!.playerId)?.name}` : "—"}</strong>
                  </div>
                  <div className="row">
                    <input value={bidAmount} onChange={(e) => setBidAmount(e.target.value)} inputMode="numeric" aria-label="Bid amount" />
                    <button disabled={busy} onClick={() => run(() => cmd({ type: "PLACE_BID", playerId: playerId!, amount: Number(bidAmount) }))}>
                      Bid
                    </button>
                  </div>
                  <div className="row">
                    <button disabled={busy} onClick={() => run(() => cmd({ type: "PASS_AUCTION", playerId: playerId! }))}>
                      Pass
                    </button>
                    <button disabled={busy} onClick={() => run(() => cmd({ type: "COMPLETE_AUCTION", playerId: playerId! }))}>
                      Complete
                    </button>
                  </div>
                </>
              )}
            </section>

            <section className="panel">
              <h2>Trade (sats + properties)</h2>
              <label>
                Counterparty
                <select value={tradeTo} onChange={(e) => { setTradeTo(e.target.value); setTradeRequestProps([]); }}>
                  {match.players.filter((p) => p.id !== playerId && !p.bankrupt).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Offer sats<input value={tradeOfferSats} onChange={(e) => setTradeOfferSats(e.target.value)} inputMode="numeric" />
              </label>
              <small className="muted">Offer properties (yours, undeveloped):</small>
              <div className="check-list">
                {Object.values(match.properties)
                  .filter((pr) => pr.ownerId === playerId && pr.development === 0)
                  .map((pr) => (
                    <label key={pr.tileId} className="check">
                      <input
                        type="checkbox"
                        checked={tradeOfferProps.includes(pr.tileId)}
                        onChange={() => setTradeOfferProps((s) => (s.includes(pr.tileId) ? s.filter((x) => x !== pr.tileId) : [...s, pr.tileId]))}
                      />
                      {board.find((t) => t.id === pr.tileId)?.name ?? pr.tileId}
                    </label>
                  ))}
              </div>
              <small className="muted">Request properties (theirs, undeveloped):</small>
              <div className="check-list">
                {Object.values(match.properties)
                  .filter((pr) => pr.ownerId === tradeTo && pr.development === 0)
                  .map((pr) => (
                    <label key={pr.tileId} className="check">
                      <input
                        type="checkbox"
                        checked={tradeRequestProps.includes(pr.tileId)}
                        onChange={() => setTradeRequestProps((s) => (s.includes(pr.tileId) ? s.filter((x) => x !== pr.tileId) : [...s, pr.tileId]))}
                      />
                      {board.find((t) => t.id === pr.tileId)?.name ?? pr.tileId}
                    </label>
                  ))}
              </div>
              <button
                disabled={busy || !tradeTo}
                onClick={() =>
                  run(() =>
                    cmd({
                      type: "PROPOSE_TRADE",
                      playerId: playerId!,
                      toPlayerId: tradeTo,
                      offer: { sats: Number(tradeOfferSats) || 0, propertyIds: tradeOfferProps },
                      request: { sats: 0, propertyIds: tradeRequestProps },
                    }),
                  )
                }
              >
                Propose trade
              </button>
              {pendingTrades.length === 0 && <p className="muted">No pending trades.</p>}
              {pendingTrades.map((t) => (
                <div key={t.id} className="trade-row">
                  <small>
                    {t.id}: {match.players.find((p) => p.id === t.fromPlayerId)?.name} → {match.players.find((p) => p.id === t.toPlayerId)?.name} · {t.offer.sats ?? 0} sats
                    {(t.offer.propertyIds ?? []).length > 0 && ` + [${(t.offer.propertyIds ?? []).join(", ")}]`}
                    {(t.request.propertyIds ?? []).length > 0 && ` for [${(t.request.propertyIds ?? []).join(", ")}]`}
                  </small>
                  <div className="row">
                    {t.toPlayerId === playerId && (
                      <>
                        <button disabled={busy} onClick={() => run(() => cmd({ type: "ACCEPT_TRADE", playerId: playerId!, tradeId: t.id }))}>
                          Accept
                        </button>
                        <button disabled={busy} onClick={() => run(() => cmd({ type: "REJECT_TRADE", playerId: playerId!, tradeId: t.id }))}>
                          Reject
                        </button>
                      </>
                    )}
                    {t.fromPlayerId === playerId && (
                      <button disabled={busy} onClick={() => run(() => cmd({ type: "CANCEL_TRADE", playerId: playerId!, tradeId: t.id }))}>
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </section>

            <section className="panel">
              <h2>Players</h2>
              {match.players.map((p) => (
                <div className={`player-row ${p.id === current?.id ? "current" : ""}`} key={p.id}>
                  <span>
                    {p.name}
                    {p.bankrupt ? " · OUT" : ""}
                    {p.inDetention ? " · 🔒" : ""}
                  </span>
                  <strong>{p.balance} sats</strong>
                </div>
              ))}
            </section>

            <section className="panel log-panel">
              <h2>Event Ledger</h2>
              {eventLog.map((event, i) => (
                <code key={`${event.atRevision}-${i}`}>
                  R{event.atRevision} · {event.type}
                </code>
              ))}
            </section>

            <section className="panel log-panel">
              <h2>Replay / Dispute Export</h2>
              <button
                disabled={busy || !match}
                onClick={() =>
                  run(async () => {
                    const r = await fetchReplay(match!.id);
                    setReplay(r);
                    return match!;
                  })
                }
              >
                Export replay
              </button>
              {replay && (
                <>
                  <div className="turn-line"><span>Ruleset</span><strong>{replay.rulesetVersion}</strong></div>
                  <div className="turn-line"><span>Chain hash</span><strong className="hash">{replay.chainHash.slice(0, 16)}…</strong></div>
                  <div className="turn-line"><span>Settlement</span><strong>{replay.settlement.winnerId ?? "—"}</strong></div>
                  <div className="replay-timeline">
                    {replay.events.map((e, i) => (
                      <code key={`${e.atRevision}-${i}`}>R{e.atRevision} · {e.type}</code>
                    ))}
                  </div>
                </>
              )}
            </section>
          </aside>
        </div>
      )}

      {tab === "wallet" && (
        <section className="launch-card wide">
          <h2>Main Wallet (simulated)</h2>
          <p className="muted">Persistent practice balance. Match winnings settle here. No real crypto.</p>
          <div className="turn-line"><span>Balance</span><strong>{profile.mainBalance} sim-sats</strong></div>
          <div className="turn-line"><span>Matches</span><strong>{profile.matchesPlayed} played · {profile.matchesWon} won</strong></div>
          {match && me && (
            <div className="turn-line"><span>In-match</span><strong>{me.balance} sats (match R{match.revision})</strong></div>
          )}
        </section>
      )}

      {tab === "quests" && (
        <section className="launch-card wide">
          <h2>Quests</h2>
          {QUESTS.map((q) => {
            const progress = Math.min(q.target, questProgressView[q.code] ?? profile.questProgress[q.code] ?? 0);
            const claimed = profile.questsClaimed.includes(q.code);
            const done = progress >= q.target;
            return (
              <div key={q.code} className="player-row">
                <span>{q.title} — {q.description} ({progress}/{q.target})</span>
                <button disabled={!done || claimed} onClick={() => claimQuest(q.code)}>
                  {claimed ? "Claimed" : done ? `Claim +${q.reward}` : `+${q.reward}`}
                </button>
              </div>
            );
          })}
        </section>
      )}

      {tab === "inventory" && (
        <section className="launch-card wide">
          <h2>Inventory</h2>
          <div className="token-grid">
            {TOKENS.filter((t) => profile.ownedTokens.includes(t.id)).map((t) => (
              <div key={t.id} className="token-card" style={{ borderColor: RARITY_COLORS[t.rarity] }}>
                <span className="token-emoji">{t.emoji}</span>
                <strong>{t.name}</strong>
                <small style={{ color: RARITY_COLORS[t.rarity] }}>{t.rarity}</small>
                <small className="muted">{t.description}</small>
              </div>
            ))}
          </div>
          <h3>Earn-only (locked)</h3>
          <div className="token-grid">
            {TOKENS.filter((t) => !profile.ownedTokens.includes(t.id)).map((t) => (
              <div key={t.id} className="token-card locked">
                <span className="token-emoji">{t.emoji}</span>
                <strong>{t.name}</strong>
                <small>{t.rarity} · {t.unlockMethod}</small>
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === "shop" && (
        <section className="launch-card wide">
          <h2>Daily Shop (simulated)</h2>
          <p className="muted">Rotates daily. Earn-only rarities can never be bought.</p>
          {shop.map((l) => {
            const token = TOKENS.find((t) => t.id === l.tokenId)!;
            const owned = profile.ownedTokens.includes(token.id);
            return (
              <div key={l.listingId} className="player-row">
                <span>{token.emoji} {token.name} · {token.rarity} · {l.price} sats</span>
                <button disabled={owned || profile.mainBalance < l.price} onClick={() => buyShopItem(token.id, l.price)}>
                  {owned ? "Owned" : "Buy"}
                </button>
              </div>
            );
          })}
        </section>
      )}
      {tab === "ranked" && (
        <section className="launch-card wide">
          <h2>Ranked — Season 1 (simulated)</h2>
          <p className="muted">Cosmetic-only competition. Ratings reflect results, never purchases.</p>
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              fetchLeaderboard()
                .then((r) => setLeaderboard(r.leaderboard))
                .catch((e) => setError(e instanceof Error ? e.message : "Leaderboard failed"))
                .finally(() => setBusy(false));
            }}
          >
            Refresh leaderboard
          </button>
          {leaderboard.length === 0 && <p className="muted">No ranked results yet. Finish matches, then report them via the API.</p>}
          {leaderboard.map((row) => (
            <div key={row.userId} className="player-row">
              <span>#{row.rank} {row.userId} · {row.tier}</span>
              <strong>{row.rating} · {row.wins}W/{row.losses}L</strong>
            </div>
          ))}
        </section>
      )}

      {tab === "tournaments" && (
        <section className="launch-card wide">
          <h2>Tournaments (simulated sats)</h2>
          <p className="muted">Single elimination · 2 or 4 entries · needs API running.</p>
          <div className="row">
            <input value={tnyName} onChange={(e) => setTnyName(e.target.value)} aria-label="Tournament name" />
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                createTournament(tnyName.trim() || "Friday Cup")
                  .then(() => listTournaments())
                  .then((r) => setTournaments(r.tournaments))
                  .catch((e) => setError(e instanceof Error ? e.message : "Create failed"))
                  .finally(() => setBusy(false));
              }}
            >
              Create
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                listTournaments()
                  .then((r) => setTournaments(r.tournaments))
                  .catch((e) => setError(e instanceof Error ? e.message : "Refresh failed"))
                  .finally(() => setBusy(false));
              }}
            >
              Refresh
            </button>
          </div>
          {error && <p className="error">{error}</p>}
          {tournaments.map((t) => (
            <div key={t.id} className="trade-row">
              <div className="turn-line"><span>{t.name}</span><strong>{t.status} · {t.entries.length}/{t.maxPlayers}</strong></div>
              <small className="muted">Entries: {t.entries.join(", ") || "—"}</small>
              {t.bracket.length > 0 && (
                <div className="replay-timeline">
                  {t.bracket.map((b) => (
                    <div key={b.id} className="player-row">
                      <span>R{b.round}: {b.seedA ?? "?"} vs {b.seedB ?? "?"}{b.winnerId ? ` → ${b.winnerId}` : ""}</span>
                      {!b.winnerId && b.seedA && b.seedB && t.status === "ACTIVE" && (
                        <button
                          disabled={busy}
                          onClick={() => {
                            setBusy(true);
                            reportTournamentResult(t.id, b.id, b.seedA!)
                              .then(() => listTournaments())
                              .then((r) => setTournaments(r.tournaments))
                              .catch((e) => setError(e instanceof Error ? e.message : "Report failed"))
                              .finally(() => setBusy(false));
                          }}
                        >
                          {b.seedA} wins
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="row">
                {t.status === "DRAFT" && (
                  <button disabled={busy} onClick={() => { setBusy(true); tournamentAction(t.id, "open").then(() => listTournaments()).then((r) => setTournaments(r.tournaments)).finally(() => setBusy(false)); }}>
                    Open
                  </button>
                )}
                {t.status === "REGISTRATION" && (
                  <>
                    <button disabled={busy} onClick={() => { setBusy(true); registerTournament(t.id, profile.name).then(() => listTournaments()).then((r) => setTournaments(r.tournaments)).catch((e) => setError(e instanceof Error ? e.message : "Register failed")).finally(() => setBusy(false)); }}>
                      Register me
                    </button>
                    <button disabled={busy} onClick={() => { setBusy(true); tournamentAction(t.id, "lock").then(() => listTournaments()).then((r) => setTournaments(r.tournaments)).catch((e) => setError(e instanceof Error ? e.message : "Lock failed")).finally(() => setBusy(false)); }}>
                      Lock
                    </button>
                  </>
                )}
                {t.status === "LOCKED" && (
                  <button disabled={busy} onClick={() => { setBusy(true); tournamentAction(t.id, "start").then(() => listTournaments()).then((r) => setTournaments(r.tournaments)).finally(() => setBusy(false)); }}>
                    Start
                  </button>
                )}
                {(t.status === "REGISTRATION" || t.status === "LOCKED" || t.status === "ACTIVE") && (
                  <button disabled={busy} onClick={() => { setBusy(true); tournamentAction(t.id, "cancel").then(() => listTournaments()).then((r) => setTournaments(r.tournaments)).finally(() => setBusy(false)); }}>
                    Cancel
                  </button>
                )}
              </div>
              {t.championId && <p className="reward-line">Champion: {t.championId}</p>}
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
