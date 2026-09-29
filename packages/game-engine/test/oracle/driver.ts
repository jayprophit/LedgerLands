/**
 * Fixture driver for the determinism oracle.
 *
 * Fixtures need to reach specific board tiles deterministically. Rather than
 * brute-forcing seeds until a random roll lands somewhere useful, the driver
 * searches for a *position* that makes the next real `ROLL_DICE` land on the
 * target: the RNG is deterministic, so from a fixed state every candidate
 * position produces the same dice, and exactly one of them lands on the tile.
 *
 * Position is set directly. That is a test seam, not a game rule — every
 * consequential effect (movement, rent, purchase, tax, cards) is produced by a
 * genuine engine command, so the oracle still exercises real rule code.
 */

import { applyCommand, createMatchState, DEFAULT_BOARD, normalizeSeat } from "../../src/index.js";
import type {
  GameCommand,
  GameEvent,
  MatchState,
  PlayerId,
  TeamState,
  TileId,
} from "@ledgerlands/shared-types";

export interface FixturePlayer {
  id: PlayerId;
  name: string;
  balance?: number;
}

/**
 * A recorded step is either a real engine command, or a setup mutation used to
 * steer the fixture. Seams are recorded rather than hidden, because a fixture
 * that silently pokes at state would make "replay the recorded commands" a lie:
 * the replay would diverge for reasons that have nothing to do with the engine.
 */
export type RecordedStep =
  | { kind: "command"; command: GameCommand; actorId: string; resultRevision: number; events: GameEvent[] }
  | { kind: "seam"; label: string; apply: (state: MatchState) => void };

export interface RecordedCommand {
  command: GameCommand;
  actorId: string;
  /** Engine revision after applying; mirrors what a store would persist. */
  resultRevision: number;
  /** Events emitted by this command alone. */
  events: GameEvent[];
}

export class FixtureDriver {
  readonly commands: RecordedCommand[] = [];
  readonly steps: RecordedStep[] = [];
  readonly initial: MatchState;

  constructor(
    public state: MatchState,
    private readonly boardLength = DEFAULT_BOARD.length,
  ) {
    this.initial = structuredClone(state);
  }

  static create(players: FixturePlayer[], seed: number, id = "oracle"): FixtureDriver {
    const state = createMatchState({ id, seed, players });
    return new FixtureDriver(state);
  }

  /** A 2v2 match. Seating is alternating-team, decided by the engine. */
  static createTeams(players: FixturePlayer[], teams: TeamState[], seed: number, id = "oracle-teams"): FixtureDriver {
    const state = createMatchState({ id, seed, players, teams, mode: "TEAM_2V2" });
    return new FixtureDriver(state);
  }

  /** True when the fixture used a setup seam, so command-only replay is invalid. */
  get usesSeams(): boolean {
    return this.steps.some((s) => s.kind === "seam");
  }

  get current(): MatchState {
    return this.state;
  }

  get player(): { id: PlayerId; position: number; balance: number; inDetention: boolean; bankrupt: boolean } {
    const p = this.state.players[this.state.currentPlayerIndex]!;
    return {
      id: p.id,
      position: p.position,
      balance: p.balance,
      inDetention: p.inDetention,
      bankrupt: p.bankrupt,
    };
  }

  get turnPhase(): MatchState["turnPhase"] {
    return this.state.turnPhase;
  }

  /** Apply a real engine command and record it for the fixture. */
  run(actorId: string, command: GameCommand): this {
    const before = this.state.log.length;
    const next = applyCommand(this.state, command);
    const events = next.log.slice(before);
    this.state = next;
    this.commands.push({ command, actorId, resultRevision: next.revision, events });
    this.steps.push({ kind: "command", command, actorId, resultRevision: next.revision, events });
    return this;
  }

  /** Attempt a command; if the engine refuses it, record nothing and return false. */
  tryRun(actorId: string, command: GameCommand): boolean {
    try {
      this.run(actorId, command);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Record a setup mutation so a step-replay can reproduce the fixture exactly.
   * Seams exist to steer the game; they are never used to fake a game outcome
   * (balances, ownership and dice always come from the engine).
   */
  seam(label: string, mutate: (state: MatchState) => void): this {
    mutate(this.state);
    this.steps.push({ kind: "seam", label, apply: mutate });
    return this;
  }

  setPosition(position: number): this {
    const target = ((position % this.boardLength) + this.boardLength) % this.boardLength;
    return this.seam(`position=${target}`, (state) => {
      state.players[state.currentPlayerIndex]!.position = target;
    });
  }

  /** Test seam for forcing a phase. Not a game rule; recorded state stays real. */
  setTurnPhase(phase: MatchState["turnPhase"]): this {
    return this.seam(`turnPhase=${phase}`, (state) => {
      state.turnPhase = phase;
      state.pendingExtraRoll = false;
    });
  }

  setCurrentPlayer(index: number): this {
    return this.seam(`currentPlayer=${index}`, (state) => {
      state.currentPlayerIndex = index;
    });
  }

  /** Jail a player without waiting for three doubles. */
  bankrupt(playerId: PlayerId): this {
    this.seam(`${playerId} bankrupt`, (state) => {
      const p = state.players.find((x) => x.id === playerId);
      if (!p) throw new Error(`unknown player ${playerId}`);
      p.bankrupt = true;
      p.balance = 0;
    });
    // A bankrupt seat must not hold the turn. `applyCommand` cannot fix this for
    // us because a rejected command discards its clone, so the seat is
    // normalised here, as the store's restore path does.
    return this.normalizeSeat();
  }

  /** Skip a bankrupt player in the current seat, as the restore path does. */
  normalizeSeat(): this {
    return this.seam("normalizeSeat", (state) => {
      const fixed = normalizeSeat(state);
      state.currentPlayerIndex = fixed.currentPlayerIndex;
      state.status = fixed.status;
      state.revision = fixed.revision;
      state.log = fixed.log;
    });
  }

  /** Jail a player without waiting for three doubles. */
  jailPlayer(playerId: PlayerId, detentionCards = 0): this {
    return this.seam(`jail:${playerId}`, (state) => {
      const p = state.players.find((x) => x.id === playerId);
      if (!p) throw new Error(`unknown player ${playerId}`);
      p.position = 10; // detention
      p.inDetention = true;
      p.detentionTurns = 0;
      p.detentionCards = detentionCards;
    });
  }

  tileAt(index: number) {
    return DEFAULT_BOARD[((index % this.boardLength) + this.boardLength) % this.boardLength]!;
  }

  tileIdAt(index: number): string {
    return this.tileAt(index).id;
  }

  indexOfTile(tileId: string): number {
    const index = DEFAULT_BOARD.findIndex((t) => t.id === tileId);
    if (index < 0) throw new Error(`unknown tile ${tileId}`);
    return index;
  }

  /**
   * Find the position from which the next real roll lands on `tileId`.
   * Returns false when the player is jailed (a jail turn is not a landing).
   *
   * If the next roll would be a third double, the engine jails the player and
   * emits no PLAYER_MOVED for ANY position, so seeking is impossible while the
   * doubles streak stands at 2. In that case the streak is cleared through a
   * recorded seam and the search retried; the alternative is silently skipping
   * the mechanic the fixture exists to test.
   */
  seekTile(tileId: string): boolean {
    if (this.player.inDetention) return false;
    const target = this.indexOfTile(tileId);
    const attempt = (): boolean => {
      for (let start = 0; start < this.boardLength; start += 1) {
        const probe = structuredClone(this.state);
        const p = probe.players[probe.currentPlayerIndex]!;
        p.position = start;
        let landed: number | undefined;
        try {
          // Only the events this command APPENDS count. Scanning the whole log
          // finds an earlier PLAYER_MOVED from a previous turn and reports a
          // landing the probe never made.
          const before = probe.log.length;
          const rolled = applyCommand(probe, { type: "ROLL_DICE" });
          const moved = rolled.log.slice(before).find((e) => e.type === "PLAYER_MOVED");
          if (moved && moved.type === "PLAYER_MOVED") landed = moved.to;
        } catch {
          landed = undefined;
        }
        if (landed === target) {
          this.setPosition(start);
          return true;
        }
      }
      return false;
    };
    if (attempt()) return true;
    if (this.state.players[this.state.currentPlayerIndex]!.doublesStreak < 2) return false;
    this.clearDoublesStreak();
    return attempt();
  }

  /** Test seam: reset the doubles streak so the next roll is not a jail roll. */
  clearDoublesStreak(): this {
    return this.seam("doublesStreak=0", (state) => {
      state.players[state.currentPlayerIndex]!.doublesStreak = 0;
    });
  }

  /** Roll, and report the tile landed on. */
  roll(): string {
    this.run(this.player.id, { type: "ROLL_DICE" });
    return this.tileIdAt(this.player.position);
  }

  /**
   * Get back to a ROLL phase for `playerId`, ending the current turn if needed.
   * Without this, a fixture that buys one tile and then wants to land on another
   * silently does nothing, because ROLL_DICE is illegal in the ACTION phase.
   */
  ensureRollPhase(playerId?: PlayerId): boolean {
    if (this.state.status !== "ACTIVE") return false;
    if (this.turnPhase === "ROLL" && (!playerId || this.player.id === playerId)) return true;
    const target = playerId ?? this.player.id;
    if (!this.endTurn()) return false;
    return this.waitForTurn(target);
  }

  /** Roll onto a specific tile, or report that it was not reachable. */
  rollOnto(tileId: string, playerId?: PlayerId): boolean {
    if (!this.ensureRollPhase(playerId)) return false;
    if (!this.seekTile(tileId)) return false;
    // Capture the roller: a roll can end the turn (jail, bankruptcy), so
    // checking the *current* player afterwards would read the wrong seat.
    const roller = this.player.id;
    this.roll();
    const landedOn = this.state.players.find((p) => p.id === roller)?.position;
    return landedOn !== undefined && this.tileIdAt(landedOn) === tileId;
  }

  /**
   * Sats credited by the most recent command for passing the origin corner.
   *
   * A roll onto a low-numbered tile necessarily crosses the corner, so a test
   * asserting an exact balance delta has to account for this. Ignoring it was a
   * real source of false failures here.
   */
  lastPassReward(): number {
    const last = this.commands.at(-1);
    if (!last) return 0;
    return last.events.reduce(
      (sum, e) => (e.type === "PASSED_START" || e.type === "CARD_DRAWN" ? sum + (e.amount ?? 0) : sum),
      0,
    );
  }

  /** Leave jail by paying, if possible. */
  payDetentionFine(): boolean {
    if (!this.player.inDetention) return false;
    const id = this.player.id;
    return this.tryRun(id, { type: "PAY_DETENTION_FINE", playerId: id });
  }

  useDetentionCard(): boolean {
    if (!this.player.inDetention) return false;
    const id = this.player.id;
    return this.tryRun(id, { type: "USE_DETENTION_CARD", playerId: id });
  }

  surrender(): boolean {
    const id = this.player.id;
    return this.tryRun(id, { type: "SURRENDER", playerId: id });
  }

  /**
   * Wait for `playerId`'s turn, then act while they are jailed. Used by the
   * detention fixtures, which need the jailed player to be the one on turn.
   */
  serveJailTurn(playerId: PlayerId, action: "pay" | "card" | "roll"): boolean {
    if (!this.waitForTurn(playerId)) return false;
    if (!this.player.inDetention) return false;
    if (action === "pay") return this.payDetentionFine();
    if (action === "card") return this.useDetentionCard();
    this.roll();
    return true;
  }

  useDetentionCard(): boolean {
    if (!this.player.inDetention) return false;
    const id = this.player.id;
    return this.tryRun(id, { type: "USE_DETENTION_CARD", playerId: id });
  }

  surrender(): boolean {
    const id = this.player.id;
    return this.tryRun(id, { type: "SURRENDER", playerId: id });
  }

  buyCurrent(): boolean {
    const tile = this.tileAt(this.player.position);
    return this.tryRun(this.player.id, { type: "BUY_PROPERTY", playerId: this.player.id, tileId: tile.id });
  }

  declineCurrent(): boolean {
    return this.tryRun(this.player.id, { type: "DECLINE_PROPERTY", playerId: this.player.id });
  }

  develop(tileId: string): boolean {
    return this.tryRun(this.player.id, { type: "DEVELOP_PROPERTY", playerId: this.player.id, tileId });
  }

  /** Develop a tile, then keep developing every sibling to satisfy even-building. */
  developEvenly(groupTiles: TileId[], passes = 2): number {
    let built = 0;
    for (let pass = 0; pass < passes; pass += 1) {
      for (const tileId of groupTiles) {
        if (this.develop(tileId)) built += 1;
      }
    }
    return built;
  }

  mortgage(tileId: string): boolean {
    return this.tryRun(this.player.id, { type: "MORTGAGE_PROPERTY", playerId: this.player.id, tileId });
  }

  unmortgage(tileId: string): boolean {
    return this.tryRun(this.player.id, { type: "UNMORTGAGE_PROPERTY", playerId: this.player.id, tileId });
  }

  endTurn(): boolean {
    return this.tryRun(this.player.id, { type: "END_TURN", playerId: this.player.id });
  }

  /** End turns until it is `playerId`'s turn again (bounded). */
  waitForTurn(playerId: PlayerId, limit = 60): boolean {
    for (let i = 0; i < limit; i += 1) {
      if (this.state.currentPlayerIndex >= 0 && this.state.players[this.state.currentPlayerIndex]?.id === playerId) {
        return true;
      }
      if (this.state.status !== "ACTIVE") return false;
      const before = this.state.revision;
      if (!this.advanceOneTurn()) {
        // A bankrupt seat blocks progress; force the turn on so the loop ends.
        if (this.state.revision === before) return false;
      }
    }
    return false;
  }

  /** Play one full turn for whoever is current, as mechanically as possible. */
  advanceOneTurn(maxActions = 4): boolean {
    if (this.state.status !== "ACTIVE") return false;
    // A bankrupt player may still be seated at currentPlayerIndex; the engine
    // refuses their commands, so step over them rather than throwing.
    if (this.player.bankrupt) return false;
    const id = this.player.id;
    if (this.turnPhase === "ROLL") {
      if (this.player.inDetention && !this.payDetentionFine()) {
        this.roll();
        return true;
      }
      this.roll();
      return true;
    }
    // ACTION phase: buy/develop, then end the turn.
    for (let i = 0; i < maxActions; i += 1) {
      if (this.turnPhase !== "ACTION") break;
      if (this.pendingExtraRoll) break;
      if (!this.buyCurrent()) break;
    }
    if (this.turnPhase === "ACTION") this.endTurn();
    void id;
    return true;
  }
}
