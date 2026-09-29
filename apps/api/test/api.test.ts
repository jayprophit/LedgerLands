import { beforeAll, describe, expect, it } from "vitest";

process.env.LL_NO_LISTEN = "1";
const { buildApp } = await import("../src/server.js");
const { app } = buildApp();

beforeAll(async () => {
  await app.ready();
});

async function post(url: string, body: unknown, expectedStatus = 200) {
  const res = await app.inject({ method: "POST", url, payload: body });
  expect(res.statusCode).toBe(expectedStatus);
  return res.json() as any;
}

describe("API integration", () => {
  it("serves health with board/ruleset versions", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.boardVersion).toBe("classic-v1-board-1");
    expect(body.realValueFeaturesEnabled).toBe(false);
  });

  it("creates a solo match and rolls dice", async () => {
    const created = await post("/api/matches", { playerName: "Tester", seed: 7 }, 201);
    expect(created.match.status).toBe("ACTIVE");
    const rolled = await post(`/api/matches/${created.match.id}/command`, {
      playerId: created.playerId,
      command: { type: "ROLL_DICE" },
      commandId: "int-roll-1",
    });
    expect(rolled.match.lastDice).toHaveLength(2);
  });

  it("replays idempotent commands and rejects stale revisions", async () => {
    const created = await post("/api/matches", { playerName: "Tester", seed: 9 }, 201);
    const rev = created.match.revision;
    const a = await post(`/api/matches/${created.match.id}/command`, {
      playerId: created.playerId,
      command: { type: "ROLL_DICE" },
      commandId: "int-dedupe-1",
      expectedRevision: rev,
    });
    const b = await post(`/api/matches/${created.match.id}/command`, {
      playerId: created.playerId,
      command: { type: "ROLL_DICE" },
      commandId: "int-dedupe-1",
      expectedRevision: rev,
    });
    expect(a.match.revision).toBe(b.match.revision);
    const stale = await app.inject({
      method: "POST",
      url: `/api/matches/${created.match.id}/command`,
      payload: { playerId: created.playerId, command: { type: "ROLL_DICE" }, commandId: "int-stale-1", expectedRevision: rev },
    });
    expect(stale.statusCode).toBe(412);
    expect((stale.json() as any).error).toBe("STALE_STATE");
  });

  it("runs a multiplayer lobby: join then start", async () => {
    const created = await post("/api/matches", { playerName: "Host", solo: false, seed: 3 }, 201);
    expect(created.match.status).toBe("LOBBY");
    const joined = await post(`/api/matches/${created.match.id}/join`, { playerName: "Guest" }, 201);
    expect(joined.match.players).toHaveLength(2);
    const started = await post(`/api/matches/${created.match.id}/start`, {});
    expect(started.match.status).toBe("ACTIVE");
    // Joining after start is rejected.
    const late = await app.inject({
      method: "POST",
      url: `/api/matches/${created.match.id}/join`,
      payload: { playerName: "Late" },
    });
    expect(late.statusCode).toBe(409);
  });

  it("exports events and replay for disputes", async () => {
    const created = await post("/api/matches", { playerName: "Tester", seed: 12 }, 201);
    await post(`/api/matches/${created.match.id}/command`, {
      playerId: created.playerId,
      command: { type: "ROLL_DICE" },
      commandId: "int-ev-1",
    });
    const events = await app.inject({ method: "GET", url: `/api/matches/${created.match.id}/events?since=0` });
    expect(events.statusCode).toBe(200);
    expect(((events.json() as any).events as unknown[]).length).toBeGreaterThan(0);
    const replay = await app.inject({ method: "GET", url: `/api/matches/${created.match.id}/replay` });
    expect(replay.statusCode).toBe(200);
    const body = replay.json() as any;
    expect(body.chainHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.rulesetVersion).toBe("classic-v1");
  });

  it("records ranked results and serves a leaderboard", async () => {
    await post("/api/ranked/report", { seasonId: "s1", mode: "ffa", a: "alice", b: "bob", outcomeA: "WIN" });
    const res = await app.inject({ method: "GET", url: "/api/ranked/leaderboard?season=s1&mode=ffa" });
    expect(res.statusCode).toBe(200);
    const board = (res.json() as any).leaderboard as any[];
    expect(board[0].userId).toBe("alice");
    expect(board[0].rank).toBe(1);
  });

  it("runs a tournament lifecycle to completion", async () => {    const created = await post("/api/tournaments", { name: "Integ Cup", entryFee: 0, maxPlayers: 2 }, 201);
    const id = created.tournament.id;
    await post(`/api/tournaments/${id}/open`, {});
    await post(`/api/tournaments/${id}/register`, { userId: "p1" });
    await post(`/api/tournaments/${id}/register`, { userId: "p2" });
    await post(`/api/tournaments/${id}/lock`, {});
    await post(`/api/tournaments/${id}/start`, {});
    const locked = (await app.inject({ method: "GET", url: `/api/tournaments/${id}` }).then((r) => r.json())) as any;
    const final = locked.tournament.bracket[0];
    const done = await post(`/api/tournaments/${id}/results`, { bracketMatchId: final.id, winnerId: "p1" });
    expect(done.tournament.status).toBe("COMPLETED");
    expect(done.tournament.championId).toBe("p1");
  });

  it("issues dev sessions and verifies identity", async () => {
    const login = await post("/api/auth/dev/login", { displayName: "Dev Tester" });
    expect(login.token.startsWith("lld1.")).toBe(true);
    expect(login.principal.provider).toBe("dev");
    expect(login.warning).toMatch(/DEV-ONLY/);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${login.token}` } });
    expect(me.statusCode).toBe(200);
    expect((me.json() as any).principal.playerId).toBe(login.principal.playerId);
    const anon = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(anon.statusCode).toBe(401);
  });

  it("matchmakes two players into an authoritative match", async () => {
    await post("/api/matchmaking/join", { playerId: "mm-a", displayName: "A", queue: "CASUAL_1V1" });
    await post("/api/matchmaking/join", { playerId: "mm-b", displayName: "B", queue: "CASUAL_1V1" });
    const tick = await post("/api/matchmaking/tick", {});
    expect(tick.found).toHaveLength(1);
    const claimed = await post("/api/matchmaking/claim", { reservationId: tick.found[0].reservationId });
    expect(claimed.match.status).toBe("ACTIVE");
    expect(claimed.match.players).toHaveLength(2);
    expect(claimed.playerIds).toHaveLength(2);
  });

  it("settles a sandbox marketplace purchase", async () => {
    await post("/api/marketplace/faucet", { accountId: "shopper", amount: 2000 });
    await post("/api/marketplace/mint", { kind: "cosmetic", assetId: "neon-dice", ownerId: "vendor" });
    const listed = await post(
      "/api/marketplace/list",
      { sellerId: "vendor", kind: "cosmetic", assetId: "neon-dice", price: 1000 },
      201,
    );
    const bought = await post("/api/marketplace/buy", {
      buyerId: "shopper",
      listingId: listed.listing.id,
      idempotencyKey: "integ-buy-1",
    });
    expect(bought.listing.status).toBe("SOLD");
    const listings = (await app.inject({ method: "GET", url: "/api/marketplace/listings" }).then((r) => r.json())) as any;
    expect(listings.listings).toHaveLength(0);
  });
});
