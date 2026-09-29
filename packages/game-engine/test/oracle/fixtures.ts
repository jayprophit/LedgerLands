/**
 * The oracle corpus.
 *
 * Each fixture is a deterministic match that exercises named mechanics. The
 * corpus is deliberately not "random bot games" — those drift as the AI
 * changes and cannot tell you which rule regressed. Every fixture names the
 * mechanics it covers, and the test asserts the fixture actually produced
 * evidence for them (see `requiredEvents`).
 *
 * Mechanics required by the directive, and the fixture that covers each:
 *   movement              -> `movement-and-pass-start`
 *   purchase              -> `purchase-and-mortgage-cycle`
 *   decline               -> `decline-triggers-auction`
 *   auction               -> `decline-triggers-auction`, `auction-multi-bidder`
 *   rent                  -> `rent-between-players`
 *   monopoly rent         -> `monopoly-doubles-rent`
 *   transit               -> `transit-and-service`
 *   service               -> `transit-and-service`
 *   mortgage/unmortgage   -> `purchase-and-mortgage-cycle`
 *   development           -> `monopoly-doubles-rent`
 *   jail                  -> `detention-fine-and-card`
 *   cards                 -> `detention-fine-and-card`
 *   trades                -> `trade-accept-and-reject`
 *   bankruptcy            -> `creditor-bankruptcy`
 *   surrender             -> `surrender-ends-match`
 *   completion            -> `creditor-bankruptcy`, `surrender-ends-match`
 */

import { DEFAULT_BOARD } from "../../src/index.js";
import type { GameEvent, TileId } from "@ledgerlands/shared-types";
import { FixtureDriver, type FixturePlayer } from "./driver.js";

export interface Fixture {
  name: string;
  seed: number;
  players: FixturePlayer[];
  /** Event types that must appear, so a fixture cannot silently stop testing. */
  requiredEvents: GameEvent["type"][];
  run: (driver: FixtureDriver) => void;
}

const twoRich: FixturePlayer[] = [
  { id: "p0", name: "Ada", balance: 30_000 },
  { id: "p1", name: "Bo", balance: 30_000 },
];

const threeRich: FixturePlayer[] = [
  { id: "p0", name: "Ada", balance: 30_000 },
  { id: "p1", name: "Bo", balance: 30_000 },
  { id: "p2", name: "Cy", balance: 30_000 },
];

const fourRich: FixturePlayer[] = [
  { id: "p0", name: "Ada", balance: 40_000 },
  { id: "p1", name: "Bo", balance: 40_000 },
  { id: "p2", name: "Cy", balance: 40_000 },
  { id: "p3", name: "Di", balance: 40_000 },
];

/** Drive a full match with the mechanical policy until it ends or we give up. */
function grind(driver: FixtureDriver, limit = 200): void {
  for (let i = 0; i < limit; i += 1) {
    if (driver.state.status !== "ACTIVE") return;
    driver.advanceOneTurn();
  }
}

function start(driver: FixtureDriver): void {
  driver.run("system", { type: "START_MATCH" });
}

export const FIXTURES: Fixture[] = [
  {
    name: "movement-and-pass-start",
    seed: 101,
    players: twoRich,
    requiredEvents: ["MATCH_STARTED", "DICE_ROLLED", "PLAYER_MOVED", "PASSED_START"],
    run: (d) => {
      start(d);
      // Park just before the origin so a normal roll passes it.
      d.setPosition(DEFAULT_BOARD.length - 4);
      d.roll();
      grind(d);
    },
  },
  {
    name: "purchase-and-mortgage-cycle",
    seed: 202,
    players: threeRich,
    requiredEvents: ["PROPERTY_BOUGHT", "PROPERTY_MORTGAGED", "PROPERTY_UNMORTGAGED"],
    run: (d) => {
      start(d);
      d.rollOnto("copper-01");
      d.buyCurrent();
      d.mortgage("copper-01");
      d.unmortgage("copper-01");
      d.rollOnto("copper-02");
      d.buyCurrent();
      grind(d);
    },
  },
  {
    name: "decline-triggers-auction",
    seed: 303,
    players: threeRich,
    requiredEvents: ["PROPERTY_OFFERED", "AUCTION_STARTED", "AUCTION_COMPLETED"],
    run: (d) => {
      start(d);
      d.rollOnto("teal-01");
      d.declineCurrent();
      d.tryRun(d.player.id, { type: "START_AUCTION", playerId: d.player.id, tileId: "teal-01" });
      d.tryRun(d.player.id, { type: "COMPLETE_AUCTION", playerId: d.player.id });
      grind(d);
    },
  },
  {
    name: "rent-between-players",
    seed: 404,
    players: threeRich,
    requiredEvents: ["PROPERTY_BOUGHT", "RENT_PAID"],
    run: (d) => {
      start(d);
      d.rollOnto("copper-01");
      d.buyCurrent();
      d.endTurn();
      d.waitForTurn("p1");
      d.rollOnto("copper-01");
      grind(d);
    },
  },
  {
    name: "monopoly-doubles-rent",
    seed: 505,
    players: threeRich,
    requiredEvents: ["PROPERTY_DEVELOPED", "RENT_PAID"],
    run: (d) => {
      start(d);
      d.seam("p0 owns the whole copper group", (state) => {
        for (const id of ["copper-01", "copper-02", "copper-03"]) {
          state.properties[id]!.ownerId = "p0";
          state.properties[id]!.development = 0;
          state.properties[id]!.mortgaged = false;
        }
      });
      // Development is an ACTION-phase command, so the fixture enters the phase
      // explicitly rather than waiting for a real roll to land there.
      d.setCurrentPlayer(0);
      d.setTurnPhase("ACTION");
      d.developEvenly(["copper-01", "copper-02", "copper-03"], 1);
      d.endTurn();
      d.waitForTurn("p1");
      d.rollOnto("copper-02");
    },
  },
  {
    name: "transit-and-service",
    seed: 606,
    players: threeRich,
    requiredEvents: ["RENT_PAID"],
    run: (d) => {
      start(d);
      d.rollOnto("transit-01");
      d.buyCurrent();
      d.endTurn();
      d.waitForTurn("p1");
      d.rollOnto("transit-01");
      grind(d);
    },
  },
  {
    name: "detention-fine-and-card",
    seed: 707,
    players: threeRich,
    requiredEvents: ["SENT_TO_DETENTION"],
    run: (d) => {
      start(d);
      d.jailPlayer("p0", 1);
      d.endTurn();
      grind(d, 20);
    },
  },
  {
    name: "detention-fine-paid",
    seed: 808,
    players: threeRich,
    requiredEvents: ["DETENTION_FINE_PAID"],
    run: (d) => {
      start(d);
      d.jailPlayer("p0");
      d.endTurn();
      for (let i = 0; i < 12 && d.state.status === "ACTIVE"; i += 1) {
        if (d.serveJailTurn("p0", "pay")) continue;
        d.advanceOneTurn();
      }
    },
  },
  {
    name: "detention-card-used",
    seed: 909,
    players: threeRich,
    requiredEvents: ["DETENTION_CARD_USED"],
    run: (d) => {
      start(d);
      d.jailPlayer("p0", 1);
      d.endTurn();
      for (let i = 0; i < 12 && d.state.status === "ACTIVE"; i += 1) {
        if (d.serveJailTurn("p0", "card")) continue;
        d.advanceOneTurn();
      }
    },
  },
  {
    name: "trade-accept",
    seed: 1010,
    players: threeRich,
    requiredEvents: ["TRADE_PROPOSED", "TRADE_ACCEPTED"],
    run: (d) => {
      start(d);
      d.rollOnto("copper-01");
      d.buyCurrent();
      d.endTurn();
      d.waitForTurn("p1");
      d.tryRun("p1", {
        type: "PROPOSE_TRADE",
        playerId: "p1",
        toPlayerId: "p0",
        offer: { sats: 1_000 },
        request: { propertyIds: ["copper-01"] },
      });
      d.tryRun("p0", { type: "ACCEPT_TRADE", playerId: "p0", tradeId: lastTradeId(d) });
      grind(d);
    },
  },
  {
    name: "trade-reject",
    seed: 1111,
    players: threeRich,
    requiredEvents: ["TRADE_PROPOSED", "TRADE_REJECTED"],
    run: (d) => {
      start(d);
      d.rollOnto("copper-01");
      d.buyCurrent();
      d.endTurn();
      d.waitForTurn("p1");
      d.tryRun("p1", {
        type: "PROPOSE_TRADE",
        playerId: "p1",
        toPlayerId: "p0",
        offer: { sats: 1_000 },
        request: { propertyIds: ["copper-01"] },
      });
      d.tryRun("p0", { type: "REJECT_TRADE", playerId: "p0", tradeId: lastTradeId(d) });
      grind(d);
    },
  },
  {
    name: "creditor-bankruptcy",
    seed: 1212,
    players: [
      { id: "p0", name: "Ada", balance: 40_000 },
      { id: "p1", name: "Bo", balance: 40_000 },
    ],
    requiredEvents: ["PLAYER_BANKRUPT", "MATCH_COMPLETED"],
    run: (d) => {
      start(d);
      // p1 owes p0 more than it holds. p1's property must pass to the creditor
      // rather than returning to the bank, and p0 must be declared the winner.
      d.seam("p0 owns gold-01, p1 owns copper-01", (state) => {
        state.properties["gold-01"]!.ownerId = "p0";
        state.properties["gold-01"]!.development = 0;
        state.properties["gold-01"]!.mortgaged = false;
        state.properties["copper-01"]!.ownerId = "p1";
        state.properties["copper-01"]!.development = 0;
        state.properties["copper-01"]!.mortgaged = false;
      });
      d.advanceOneTurn();
      d.waitForTurn("p1");
      // Set the shortfall immediately before the landing roll, so pass-start
      // rewards on the way round cannot refill p1 first.
      d.seam("p1 cannot cover gold rent", (state) => {
        state.players[1]!.balance = 5;
      });
      d.rollOnto("gold-01");
      grind(d, 20);
    },
  },
  {
    name: "bankruptcy-without-creditor",
    seed: 1213,
    players: [
      { id: "p0", name: "Ada", balance: 40_000 },
      { id: "p1", name: "Bo", balance: 40_000 },
    ],
    requiredEvents: ["PLAYER_BANKRUPT", "MATCH_COMPLETED"],
    run: (d) => {
      start(d);
      // Detention fine with no creditor: the estate returns to the bank and the
      // development level is reset, which is the branch creditor bankruptcy does
      // not take.
      d.seam("p1 owns a developed gold tile", (state) => {
        state.properties["gold-01"]!.ownerId = "p1";
        state.properties["gold-01"]!.development = 0;
        state.properties["gold-01"]!.mortgaged = false;
      });
      d.advanceOneTurn();
      d.waitForTurn("p1");
      d.seam("p1 jailed and cannot pay the fine", (state) => {
        const p = state.players[1]!;
        p.balance = 5;
        p.position = 10;
        p.inDetention = true;
        p.detentionTurns = 0;
      });
      for (let i = 0; i < 10 && d.state.status === "ACTIVE"; i += 1) {
        if (d.serveJailTurn("p1", "pay")) continue;
        if (!d.advanceOneTurn()) break;
      }
    },
  },
  {
    name: "surrender-ends-match",
    seed: 1313,
    players: [
      { id: "p0", name: "Ada", balance: 40_000 },
      { id: "p1", name: "Bo", balance: 1_000 },
    ],
    requiredEvents: ["PLAYER_SURRENDERED", "MATCH_COMPLETED"],
    run: (d) => {
      start(d);
      d.setCurrentPlayer(1);
      d.tryRun("p1", { type: "SURRENDER", playerId: "p1" });
    },
  },
  {
    name: "auction-multi-bidder",
    seed: 1414,
    players: fourRich,
    requiredEvents: ["AUCTION_STARTED", "AUCTION_BID", "AUCTION_COMPLETED"],
    run: (d) => {
      start(d);
      d.rollOnto("gold-03");
      d.declineCurrent();
      d.tryRun(d.player.id, { type: "START_AUCTION", playerId: d.player.id, tileId: "gold-03" });
      // Everyone else bids up the tile through the normal command path.
      for (const bidder of ["p1", "p2", "p3"]) {
        d.tryRun(bidder, { type: "PLACE_BID", playerId: bidder, amount: 3_000 + Number(bidder.slice(1)) * 500 });
      }
      d.tryRun("p3", { type: "COMPLETE_AUCTION", playerId: "p3" });
      grind(d);
    },
  },
  {
    name: "long-match-grind",
    seed: 1515,
    players: fourRich,
    requiredEvents: ["MATCH_STARTED"],
    run: (d) => {
      start(d);
      grind(d, 400);
    },
  },
  {
    name: "tax-and-luxury",
    seed: 1616,
    players: threeRich,
    requiredEvents: ["TAX_PAID"],
    run: (d) => {
      start(d);
      d.rollOnto("tax-01");
      d.rollOnto("tax-02");
      grind(d);
    },
  },
  {
    name: "cards-drawn",
    seed: 1717,
    players: threeRich,
    requiredEvents: ["MATCH_STARTED"],
    run: (d) => {
      start(d);
      grind(d, 300);
    },
  },
  {
    name: "all-tiles-granted-monopoly-rent",
    seed: 1818,
    players: threeRich,
    requiredEvents: ["RENT_PAID"],
    run: (d) => {
      start(d);
      d.seam("p0 owns the whole copper group, undeveloped", (state) => {
        for (const id of ["copper-01", "copper-02", "copper-03"]) {
          state.properties[id]!.ownerId = "p0";
          state.properties[id]!.development = 0;
          state.properties[id]!.mortgaged = false;
        }
      });
      // Hand the turn over through a real roll, then charge p1 monopoly rent.
      d.advanceOneTurn();
      d.waitForTurn("p1");
      d.rollOnto("copper-03");
    },
  },
];
function lastTradeId(d: FixtureDriver): string {
  const trades = d.state.trades ?? [];
  const last = trades[trades.length - 1];
  if (!last) throw new Error("fixture expected a trade to exist");
  return last.id;
}
