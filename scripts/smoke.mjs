const base = process.env.API_URL ?? "http://localhost:8787";
const health = await fetch(`${base}/health`).then((r) => r.json());
if (health.status !== "ok") throw new Error("health failed");
const created = await fetch(`${base}/api/matches`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ playerName: "Smoke Tester", seed: 123, solo: true }),
}).then(async (r) => {
  if (!r.ok) throw new Error(await r.text());
  return r.json();
});
if (!created.match?.id || !created.playerId) throw new Error("match creation failed");
const rolled = await fetch(`${base}/api/matches/${created.match.id}/command`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ playerId: created.playerId, command: { type: "ROLL_DICE" } }),
}).then(async (r) => {
  if (!r.ok) throw new Error(await r.text());
  return r.json();
});
if (!rolled.match?.lastDice) throw new Error("dice roll failed");
console.log("SMOKE_OK", { matchId: created.match.id, dice: rolled.match.lastDice });
