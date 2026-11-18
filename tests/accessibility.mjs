import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const dataDir = mkdtempSync(join(tmpdir(), "gh-assessment-a11y-"));
const port = 19000 + Math.floor(Math.random() * 10000);
const axeSource = readFileSync(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
let server;
let browser;

function command(program, args, env = process.env) {
  const result = spawnSync(program, args, { stdio: "inherit", env });
  if (result.status !== 0) throw new Error(`${program} exited with ${result.status}`);
}

async function waitForServer(url) {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("Dashboard did not start.");
}

async function axe(page, label) {
  await page.route("**/__test/axe.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: axeSource,
  }));
  await page.addScriptTag({
    url: new URL("/__test/axe.js", page.url()).href,
  });
  const results = await page.evaluate(async () => {
    return await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] }
    });
  });
  if (results.violations.length) {
    const details = results.violations.map((v) =>
      `${v.id}: ${v.nodes.map((n) => `${n.target.join(", ")}\n${n.failureSummary || ""}`).join("\n")}`
    ).join("\n");
    throw new Error(`${label}: ${results.violations.length} axe violations\n${details}`);
  }
  console.log(`${label}: no axe violations`);
}

try {
  command("python3", ["-m", "assessment", "demo", "--data-dir", dataDir]);
  server = spawn("python3", ["-m", "assessment", "serve", "--port", String(port), "--data-dir", dataDir], {
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  await waitForServer(url);
  browser = await chromium.launch({ headless: true });

  for (const colorScheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme });
    await page.goto(url);
    await page.getByRole("heading", { name: "Assessment criteria" }).waitFor();
    await axe(page, `Desktop ${colorScheme}`);

    await page.getByRole("combobox", { name: "Pillar" }).selectOption("productivity");
    const firstManual = page.locator('form[data-criterion-id="PROD-01"]');
    await firstManual.getByLabel("Maturity level").selectOption("2");
    await firstManual.getByLabel("Evidence or reason for exclusion").fill("Reviewed representative workflow evidence.");
    await firstManual.getByRole("button", { name: "Save assessment" }).click();
    await page.getByRole("status").filter({ hasText: "Evidence saved locally" }).waitFor();
    await axe(page, `After attestation ${colorScheme}`);
    await page.close();
  }

  const narrow = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
  await narrow.goto(`http://127.0.0.1:${port}`);
  const width = await narrow.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  if (width.document > width.viewport + 1) {
    throw new Error(`Narrow viewport reflow failed: ${JSON.stringify(width)}`);
  }
  const expectedOrder = [
    ".skip-link",
    ".Header-link",
    "a[download]",
    "#scope-heading + dl + details summary",
    "#pillar-filter",
    "#criteria details summary",
    "#criteria article a.Link",
    'form[data-criterion-id="PROD-01"] select[name="decision"]',
    'form[data-criterion-id="PROD-01"] textarea[name="note"]',
    'form[data-criterion-id="PROD-01"] button[type="submit"]',
  ];
  for (const selector of expectedOrder) {
    await narrow.keyboard.press("Tab");
    const focused = await narrow.evaluate(
      (expected) => document.activeElement.matches(expected),
      selector
    );
    if (!focused) throw new Error(`Unexpected keyboard focus order before ${selector}.`);
  }
  await axe(narrow, "Narrow viewport");
  console.log("Keyboard skip link and narrow viewport: passed");
} finally {
  if (browser) await browser.close();
  if (server) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
  rmSync(dataDir, { recursive: true, force: true });
}
