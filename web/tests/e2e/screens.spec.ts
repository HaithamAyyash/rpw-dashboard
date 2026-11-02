import { expect, test, type Page } from "@playwright/test";

const PASSWORD = process.env.SEED_USER_PASSWORD ?? "nakhel-dev-password";
const OWNER = "owner@al-ain-demo.example";

async function logIn(page: Page, email = OWNER) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(/\/(al-ain-demo|oasis-palm-demo)?$/);
}

test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => {
    throw new Error(`Page error: ${error.message}`);
  });
});

test("alert log: filter, acknowledge", async ({ page }) => {
  await logIn(page);
  await page.goto("/al-ain-demo/alerts");
  const rows = page.getByTestId("alert-row");
  await expect(rows.first()).toBeVisible();

  await page.getByRole("button", { name: "Critical", exact: true }).click();
  await expect(page).toHaveURL(/severity=critical/);
  await expect(rows.first()).toContainText(/detected|offline/i);
  await page.getByRole("button", { name: "All", exact: true }).click();

  await page.getByRole("button", { name: "Unacknowledged" }).click();
  await expect(page).toHaveURL(/open=1/);
  const first = rows.first();
  await expect(first).toBeVisible();
  const before = await first.textContent();
  await first.getByRole("button", { name: "Acknowledge" }).click();
  await expect(rows.first()).not.toHaveText(before!);
  await page.getByRole("button", { name: "Unacknowledged" }).click();
  await expect(page.getByText(/Acknowledged by/).first()).toBeVisible();
  await page.screenshot({ path: "tests/e2e/.output/alerts.png" });
});

test("classification: latest per node, sorts, labels fake model", async ({
  page,
}) => {
  await logIn(page);
  await page.goto("/al-ain-demo/classification");
  const rows = page.getByTestId("classification-row");
  await expect(rows).toHaveCount(32);
  await expect(rows.first()).toContainText("stub-0.1-FAKE");
  await page.getByRole("button", { name: /^Tree/ }).click();
  await expect(page).toHaveURL(/sort=tree_asc/);
  await expect(rows.first()).toContainText("PLM-A-01");
  await page.getByRole("button", { name: "Infested", exact: true }).click();
  await expect(page).toHaveURL(/label=infested/);
  await page.screenshot({ path: "tests/e2e/.output/classification.png" });
});

test("historical records: table, no BFCC or CQCC, date filter, CSV export", async ({
  page,
}) => {
  await logIn(page);
  await page.goto("/al-ain-demo/history");
  await expect(page.getByTestId("history-row").first()).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Energy (c0)" }),
  ).toBeVisible();
  await expect(page.getByText("BFCC")).toHaveCount(0);
  await expect(page.getByText("CQCC")).toHaveCount(0);
  await page.screenshot({ path: "tests/e2e/.output/history.png" });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Export CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("nakhel-al-ain-demo-features.csv");

  await page.getByLabel("From", { exact: true }).fill("2000-01-01");
  await page.getByLabel("To", { exact: true }).fill("2000-01-02");
  await expect(page.getByText("No records in this period.")).toBeVisible();
});

test("top bar export offers all three files", async ({ page }) => {
  await logIn(page);
  await page.goto("/al-ain-demo");
  await page.getByText("Export report").click();
  for (const name of ["Feature records", "Classifications", "Alerts"]) {
    await expect(
      page.locator("header").getByRole("link", { name }),
    ).toBeVisible();
  }
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("header").getByRole("link", { name: "Alerts" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("nakhel-al-ain-demo-alerts.csv");
});

test("system health: node and cluster cards with real values", async ({
  page,
}) => {
  await logIn(page);
  await page.goto("/al-ain-demo/health");
  await expect(page.getByTestId("health-cluster")).toHaveCount(2);
  await expect(page.getByTestId("health-cluster").first()).toContainText("MB");
  const nodes = page.getByTestId("health-node");
  await expect(nodes).toHaveCount(32);
  await expect(nodes.first()).toContainText("mV");
  await page.screenshot({ path: "tests/e2e/.output/health.png" });
});

test("acoustic analysis: overlay, ranges, small multiples", async ({
  page,
}) => {
  await logIn(page);
  await page.goto("/al-ain-demo/acoustic");
  await expect(
    page.getByTestId("energy-overview").locator("canvas"),
  ).toBeVisible();
  await expect(page.getByTestId("energy-node").first()).toBeVisible();
  await page.getByRole("button", { name: "7 d" }).click();
  await expect(page).toHaveURL(/range=7d/);
  await expect(
    page.getByTestId("energy-overview").locator("canvas"),
  ).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: "tests/e2e/.output/acoustic.png" });
  await page.getByText("Show as a table").click();
  await expect(
    page.getByRole("columnheader", { name: "Healthy average" }),
  ).toBeVisible();
});

test("sensor map: markers, legend, popup with tree data link", async ({
  page,
}) => {
  await logIn(page);
  await page.goto("/al-ain-demo/map");
  await expect(page.locator(".leaflet-container")).toBeVisible();
  await expect(page.locator(".alert-marker").first()).toBeVisible();
  await expect(page.locator(".cluster-marker")).toHaveCount(2);
  await expect(page.getByText("Status legend")).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: "tests/e2e/.output/map-overview.png" });
  // Leaflet must keep positioning its icons: our styles belong on the span inside.
  const icon = page.locator(".leaflet-marker-icon").first();
  await expect(icon).toHaveCSS("position", "absolute");
  const list = page.getByTestId("map-node-list").getByRole("button");
  await expect(list).toHaveCount(32);

  await list.first().click();
  const popup = page.locator(".leaflet-popup-content");
  await expect(popup).toBeVisible();
  await expect(popup.getByRole("link", { name: "Navigate" })).toHaveAttribute(
    "href",
    /google\.com\/maps/,
  );
  await page.waitForTimeout(1200);
  await page.screenshot({ path: "tests/e2e/.output/map.png" });
  await expect(page.locator(".leaflet-popup-content-wrapper")).toHaveCSS(
    "background-color",
    "rgb(36, 43, 41)",
  );
  await popup.getByRole("link", { name: "Tree data" }).click();
  await expect(page).toHaveURL(/\/history\?node=/);
  await expect(page.getByTestId("history-row").first()).toBeVisible();
});

test("settings: thresholds, invite a new member through to login, cluster key, nodes", async ({
  page,
  browser,
}) => {
  page.on("dialog", (dialog) => dialog.accept());
  await logIn(page);
  await page.goto("/al-ain-demo/settings");
  await expect(
    page.getByRole("heading", { name: "Organization" }),
  ).toBeVisible();

  // Thresholds validate on the server and the message reaches the form.
  const organization = page.getByRole("region", { name: "Organization" });
  await organization.getByLabel("Suspected from (%)").fill("90");
  await organization.getByRole("button", { name: "Save" }).click();
  await expect(organization.getByRole("alert")).toContainText(
    "below the alert threshold",
  );
  await organization.getByLabel("Suspected from (%)").fill("50");
  await organization.getByRole("button", { name: "Save" }).click();
  await expect(organization.getByText("Saved")).toBeVisible();

  // Register a cluster head: the key shows once.
  const suffix = Date.now().toString(36);
  const clusters = page.getByRole("region", { name: "Cluster heads" });
  await clusters.getByLabel("Name").fill(`CH-${suffix}`);
  await clusters.getByRole("button", { name: "Register" }).click();
  const key = await page.getByTestId("api-key").textContent();
  expect(key).toMatch(/^nkh_/);
  await clusters.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("api-key")).toHaveCount(0);
  const row = page
    .getByTestId("cluster-row")
    .filter({ hasText: `CH-${suffix}` });

  // Add a node to it.
  const nodes = page.getByRole("region", { name: "Nodes" });
  await nodes.getByLabel("LoRa ID").fill("42");
  await nodes.getByLabel("Tree label").fill(`E2E-${suffix}`);
  await nodes
    .getByLabel("Cluster head")
    .selectOption({ label: `CH-${suffix}` });
  await nodes.getByRole("button", { name: "Add node" }).click();
  await nodes.getByLabel("Search nodes").fill(`E2E-${suffix}`);
  await expect(page.getByTestId("node-row")).toHaveCount(1);
  await page
    .getByTestId("node-row")
    .getByRole("button", { name: "Retire" })
    .click();
  await expect(page.getByTestId("node-row")).toContainText("Retired");

  // A bad CSV reports the line and imports nothing.
  await nodes.getByLabel("CSV file to import").setInputFiles({
    name: "nodes.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`lora_id,tree_label,cluster\n70000,Bad,CH-${suffix}\n`),
  });
  await expect(nodes.getByRole("alert")).toContainText("Line 2");

  // Revoke.
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toContainText("Revoked");

  // Invite someone new; they accept in their own browser.
  const members = page.getByRole("region", { name: "Members" });
  const email = `e2e-${suffix}@example.com`;
  await members.getByLabel("Email to invite").fill(email);
  await members.getByRole("button", { name: "Invite by email" }).click();
  const link = await page.getByTestId("invite-link").textContent();
  expect(link).toContain("/invite/");
  await page.screenshot({
    path: "tests/e2e/.output/settings.png",
    fullPage: true,
  });

  const context = await browser.newContext();
  const guest = await context.newPage();
  await guest.goto(new URL(link!).pathname);
  await expect(
    guest.getByRole("heading", { name: /Join Al Ain Demo Farms/ }),
  ).toBeVisible();
  await guest.getByLabel("Your name").fill("E2E Person");
  await guest.getByLabel("Choose a password").fill("a-long-enough-password");
  await guest.getByRole("button", { name: "Create account and join" }).click();
  await guest.waitForURL(/\/al-ain-demo$/);
  await expect(guest.getByTestId("tree-count")).toBeVisible();
  await guest.goto(new URL(link!).pathname);
  await expect(guest.getByText("This invite isn't valid")).toBeVisible();
  await context.close();

  // Removing them works; the last owner rule stays enforced by the API.
  await page.reload();
  const newMember = page.getByTestId("member-row").filter({ hasText: email });
  await expect(newMember).toBeVisible();
  await newMember.getByRole("button", { name: "Remove" }).click();
  await expect(newMember).toHaveCount(0);
});

test("each screen is reachable from the sidebar at tablet width, with no sideways scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await logIn(page);
  for (const [name, path] of [
    ["Sensor map", "map"],
    ["Acoustic analysis", "acoustic"],
    ["Classification", "classification"],
    ["Alert log", "alerts"],
    ["Historical records", "history"],
    ["System health", "health"],
    ["Settings", "settings"],
  ]) {
    await page.getByRole("link", { name: name! }).click();
    await expect(page).toHaveURL(new RegExp(`/${path}`));
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, `${name} scrolls sideways`).toBeLessThanOrEqual(0);
  }
});
