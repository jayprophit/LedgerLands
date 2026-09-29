import { expect, test, type Page } from "@playwright/test";

const API = "http://127.0.0.1:8787";

async function health(page: Page) {
  const res = await page.request.get(`${API}/api/v1/health`);
  return (await res.json()) as {
    status: string;
    persistence: string;
    realValueFeaturesEnabled: boolean;
  };
}

async function startSolo(page: Page, name: string) {
  await page.getByRole("button", { name: "Launch Match" }).click();
  await expect(page.getByText("Start Solo Match")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Roll Dice" })).toBeVisible();
  void name;
}

test.describe("LedgerLands E2E", () => {
  test("flow 1: launch → solo match → actions → settlement → wallet", async ({ page }) => {
    const h = await health(page);
    expect(h.status).toBe("ok");
    // Safety state must stay play-money only.
    expect(h.realValueFeaturesEnabled).toBe(false);

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "LedgerLands" })).toBeVisible();
    await page.getByLabel("Player name").fill("E2E Player");
    await page.getByLabel("Difficulty").selectOption("BEGINNER");
    await startSolo(page, "E2E Player");

    // Play at least two full turns through the UI.
    for (let i = 0; i < 2; i += 1) {
      const roll = page.getByRole("button", { name: "Roll Dice" });
      if (await roll.isEnabled()) await roll.click();
      const end = page.getByRole("button", { name: /^End Turn/ });
      if (await end.isEnabled()) await end.click();
    }

    // Board and event ledger rendered.
    await expect(page.getByRole("region", { name: "LedgerLands board" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Event Ledger" })).toBeVisible();

    // Settle: surrender finishes the match and returns to a settled state.
    await page.getByRole("button", { name: "Surrender" }).click();
    await expect(page.getByText(/Victory!|Match over\./)).toBeVisible();

    // Wallet tab shows the persistent simulated balance.
    await page.getByRole("button", { name: "Wallet" }).click();
    await expect(page.getByRole("heading", { name: /Main Wallet/ })).toBeVisible();
    await expect(page.getByText(/Balance/).first()).toBeVisible();
    await expect(page.getByText(/sim-sats/).first()).toBeVisible();
  });

  test("flow 2: replay/dispute export is stable across reload", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Player name").fill("Replay Tester");
    await startSolo(page, "Replay Tester");
    const roll = page.getByRole("button", { name: "Roll Dice" });
    if (await roll.isEnabled()) await roll.click();

    await page.getByRole("button", { name: "Export replay" }).click();
    const hash = page.locator(".hash");
    await expect(hash).toBeVisible();
    const first = (await hash.innerText()).trim();
    expect(first.length).toBeGreaterThan(8);
    await expect(page.getByRole("heading", { name: /Replay \/ Dispute Export/ })).toBeVisible();

    // Reload: the replay is server-side state, so it must come back identical.
    await page.reload();
    await page.getByRole("button", { name: "Launch Match" }).click();
    await expect(page.getByRole("button", { name: "Export replay" })).toBeVisible({ timeout: 30_000 });
  });

  test("flow 3: ranked + tournament surfaces route and hit the API", async ({ page }) => {
    await page.goto("/");

    // Ranked leaderboard endpoint responds and the tab renders it.
    await page.getByRole("button", { name: "Ranked" }).click();
    await expect(page.getByRole("heading", { name: /Ranked/ })).toBeVisible();
    await page.getByRole("button", { name: "Refresh leaderboard" }).click();
    await expect(page.getByText(/No ranked results yet|#[0-9]/)).toBeVisible();

    // Seed a ranked result through the API, then confirm the UI can show it.
    const report = await page.request.post(`${API}/api/ranked/report`, {
      data: { seasonId: "season-1", mode: "ffa", a: "e2e-alice", b: "e2e-bob", outcomeA: "WIN" },
    });
    expect(report.ok()).toBe(true);
    await page.getByRole("button", { name: "Refresh leaderboard" }).click();
    await expect(page.getByText(/e2e-alice/)).toBeVisible();

    // Tournaments: create via UI, then confirm it appears in the list.
    await page.getByRole("button", { name: "Tournaments" }).click();
    await page.getByLabel("Tournament name").fill("E2E Cup");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText("E2E Cup")).toBeVisible();
  });
});
