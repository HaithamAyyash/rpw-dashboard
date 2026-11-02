import { expect, test, type Page } from "@playwright/test";

const PASSWORD = process.env.SEED_USER_PASSWORD ?? "nakhel-dev-password";

async function logIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
}

const cards = (page: Page) => page.getByTestId("tree-card");

test("redirects to login without a session", async ({ page }) => {
  await page.goto("/al-ain-demo");
  await expect(page).toHaveURL(/\/login$/);
});

test("rejects a wrong password", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@al-ain-demo.example");
  await page.getByLabel("Password").fill("wrong");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator("form").getByRole("alert")).toContainText(
    "Wrong email or password",
  );
});

test("a one-organization user lands on Overview with real data", async ({
  page,
}) => {
  await logIn(page, "owner@al-ain-demo.example");
  await expect(page).toHaveURL(/\/al-ain-demo$/);
  await expect(page.getByText("Trees monitored")).toBeVisible();
  await expect(page.getByTestId("tree-count")).toHaveText("32 trees");
  await expect(cards(page).first()).toBeVisible();
  await page.screenshot({
    path: "tests/e2e/.output/overview.png",
    fullPage: false,
  });
});

test("the logo and stat card colours render", async ({ page }) => {
  await logIn(page, "owner@al-ain-demo.example");
  const logo = page.getByAltText("NAKHEL logo");
  await expect(logo).toBeVisible();
  await expect
    .poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  const bar = page.getByTestId("stat-bar").nth(1);
  await expect(bar).toHaveCSS("background-color", "rgb(245, 166, 35)");
});

test("status filters and search narrow the cards", async ({ page }) => {
  await logIn(page, "owner@al-ain-demo.example");
  await page.getByRole("button", { name: "Alert", exact: true }).click();
  await expect(page).toHaveURL(/status=alert/);
  await expect(
    cards(page).first().getByText("Alert", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Offline", exact: true }).click();
  await expect(
    cards(page).first().getByText("Offline", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByLabel("Search trees").fill("no-tree-like-this");
  await expect(page.getByText("No trees match this filter.")).toBeVisible();
});

test("Navigate to tree links to Google Maps directions", async ({ page }) => {
  await logIn(page, "owner@al-ain-demo.example");
  const link = cards(page)
    .first()
    .getByRole("link", { name: "Navigate to tree" });
  await expect(link).toHaveAttribute(
    "href",
    /google\.com\/maps\/dir\/\?api=1&destination=24\./,
  );
});

test("the zone selector filters cards and summary", async ({ page }) => {
  await logIn(page, "owner@al-ain-demo.example");
  await page.getByLabel("Zone").selectOption("Zone B");
  await expect(page).toHaveURL(/zone=Zone\+B/);
  await expect(page.getByTestId("tree-count")).toHaveText("16 trees");
  await expect(page.locator("aside").getByText("Zone B")).toBeVisible();
});

test("a multi-organization user picks one, then switches", async ({ page }) => {
  await logIn(page, "consultant@nakhel-demo.example");
  await expect(page.getByText("Choose an organization")).toBeVisible();
  await page.getByRole("link", { name: "Al Ain Demo Farms" }).click();
  await expect(page).toHaveURL(/\/al-ain-demo$/);
  await expect(page.getByTestId("tree-count")).toHaveText("32 trees");
  await page.getByLabel("Organization").selectOption("oasis-palm-demo");
  await expect(page).toHaveURL(/\/oasis-palm-demo$/);
  await expect(page.getByTestId("tree-count")).toHaveText("28 trees");
});

test("another organization's pages can't be opened", async ({ page }) => {
  await logIn(page, "owner@al-ain-demo.example");
  await expect(page).toHaveURL(/\/al-ain-demo$/);
  await page.goto("/oasis-palm-demo");
  await expect(page).toHaveURL(/\/al-ain-demo$/);
  await expect(page.getByText("Oasis Palm Demo Co")).toHaveCount(0);
});

test("logging out ends the session", async ({ page }) => {
  await logIn(page, "owner@al-ain-demo.example");
  await expect(page).toHaveURL(/\/al-ain-demo$/);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/al-ain-demo");
  await expect(page).toHaveURL(/\/login$/);
});

test("works at tablet width with no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await logIn(page, "owner@al-ain-demo.example");
  await expect(cards(page).first()).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "tests/e2e/.output/overview-tablet.png" });
});
