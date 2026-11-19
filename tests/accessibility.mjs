import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const tempDir = mkdtempSync(join(tmpdir(), "gh-assessment-a11y-"));
const answersPath = join(tempDir, "answers.json");
const port = 19000 + Math.floor(Math.random() * 10000);
const url = `http://127.0.0.1:${port}`;
const axeSource = readFileSync(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
let server;
let browser;

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await fetch(url)).ok) return;
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
  await page.addScriptTag({ url: new URL("/__test/axe.js", page.url()).href });
  const results = await page.evaluate(async () => window.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
  }));
  if (results.violations.length) {
    const details = results.violations.map((violation) =>
      `${violation.id}: ${violation.nodes.map((node) => `${node.target.join(", ")}\n${node.failureSummary || ""}`).join("\n")}`
    ).join("\n");
    throw new Error(`${label}: ${results.violations.length} axe violations\n${details}`);
  }
  console.log(`${label}: no axe violations`);
}

function contrastRatio(foreground, background) {
  const parse = (color) => {
    const channels = color.match(/[\d.]+/g)?.map(Number);
    if (!channels || channels.length < 3) throw new Error(`Unsupported computed color: ${color}`);
    return channels;
  };
  const fg = parse(foreground);
  const bg = parse(background);
  if ((bg[3] ?? 1) !== 1) throw new Error(`Header background is not opaque: ${background}`);
  const alpha = fg[3] ?? 1;
  const luminance = (channels) => {
    const [red, green, blue] = channels.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const fgLuminance = luminance(fg.slice(0, 3).map((channel, i) => channel * alpha + bg[i] * (1 - alpha)));
  const bgLuminance = luminance(bg.slice(0, 3));
  return (Math.max(fgLuminance, bgLuminance) + 0.05) / (Math.min(fgLuminance, bgLuminance) + 0.05);
}

async function assertPrimerStyles(page, label) {
  const styles = await page.evaluate(() => ({
    foreground: getComputedStyle(document.documentElement).getPropertyValue("--fgColor-default").trim(),
    background: getComputedStyle(document.documentElement).getPropertyValue("--bgColor-default").trim(),
    cardBorder: getComputedStyle(document.querySelector("#summary .Box")).borderTopStyle,
    titleColor: getComputedStyle(document.querySelector(".Header h1")).color,
    headerBackground: getComputedStyle(document.querySelector(".Header")).backgroundColor,
  }));
  if (!styles.foreground || !styles.background || styles.cardBorder !== "solid") {
    throw new Error(`${label}: Primer styles are not applied: ${JSON.stringify(styles)}`);
  }
  const titleContrast = contrastRatio(styles.titleColor, styles.headerBackground);
  if (titleContrast < 4.5) {
    throw new Error(`${label}: header title contrast is ${titleContrast.toFixed(2)}:1 (minimum 4.5:1)`);
  }
}

try {
  server = spawn(process.execPath, [
    "bin/gh-waf-assess.js", "serve", "--demo", "--port", String(port), "--answers", answersPath,
  ], { cwd: root, stdio: "ignore" });
  await waitForServer();
  browser = await chromium.launch({ headless: true });

  for (const colorScheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme });
    await page.goto(url);
    await page.locator("#tab-controls tbody tr").first().waitFor({ state: "attached" });
    await assertPrimerStyles(page, `Desktop ${colorScheme}`);
    await axe(page, `Desktop ${colorScheme}`);

    await page.getByRole("tab", { name: "Improvement areas" }).click();
    const implement = page.locator("#tab-improvements [data-implement]").first();
    assert.ok(await implement.count(), "missing items should have an Implement button");
    await page.getByRole("tab", { name: "All controls" }).click();
    const controls = await (await fetch(`${url}/api/assessment`)).json();
    const missingCount = controls.controls.filter((control) => control.status !== "pass" && control.status !== "not_applicable").length;
    assert.equal(await page.locator("#tab-controls [data-implement]").count(), missingCount);
    await page.getByRole("tab", { name: "Improvement areas" }).click();
    const downloadPromise = page.waitForEvent("download");
    await implement.click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^[a-z0-9-]+-implementation\.md$/);
    const stream = await download.createReadStream();
    let task = "";
    for await (const chunk of stream) task += chunk.toString();
    assert.match(task, /^# Implement /);
    assert.match(task, /This plan is generated locally/);
    assert.ok(await page.locator("#tab-improvements a[href='/implementation-guide']").count());

    await page.getByRole("tab", { name: "Questionnaire" }).click();
    const firstQuestion = page.locator("#tab-questionnaire .q").first();
    await firstQuestion.getByRole("radio", { name: "Yes" }).check();
    await firstQuestion.getByLabel("Notes / evidence (optional)").fill("Reviewed representative workflow evidence.");
    await firstQuestion.locator("textarea").blur();
    await page.locator("#toast").getByText("Answer saved locally.").waitFor();
    await axe(page, `After questionnaire answer ${colorScheme}`);

    await page.locator("#answers-file").setInputFiles({
      name: "answers.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ "GOV-11": { answer: "partial", notes: "Imported review notes." } })),
    });
    await page.getByRole("status").getByText("Answers loaded and saved locally.").waitFor();
    const imported = page.locator('.q[data-id="GOV-11"]');
    assert.equal(await imported.getByRole("radio", { name: "Partial", exact: true }).isChecked(), true);
    assert.equal(await imported.locator("textarea").inputValue(), "Imported review notes.");
    await axe(page, `After importing answers ${colorScheme}`);
    await page.reload();
    await page.getByRole("tab", { name: "Questionnaire" }).click();
    assert.equal(await imported.locator("textarea").inputValue(), "Imported review notes.");
    await page.locator("#answers-file").setInputFiles({
      name: "answers.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"GOV-11":"invalid"}'),
    });
    await page.getByRole("alert").getByText(/Unable to load answers/).waitFor();
    assert.equal(await imported.locator("textarea").inputValue(), "Imported review notes.");
    await page.close();
  }

  const reportResponse = await fetch(`${url}/api/report.html`);
  if (!reportResponse.ok) throw new Error("HTML report could not be downloaded.");
  const reportPath = join(tempDir, "assessment.html");
  writeFileSync(reportPath, await reportResponse.text());
  for (const colorScheme of ["light", "dark"]) {
    const page = await browser.newPage({ colorScheme, offline: true });
    const externalRequests = [];
    page.on("request", (request) => {
      if (/^https?:/.test(request.url())) externalRequests.push(request.url());
    });
    await page.goto(pathToFileURL(reportPath).href);
    await page.locator("#tab-controls tbody tr").first().waitFor({ state: "attached" });
    await assertPrimerStyles(page, `Offline report ${colorScheme}`);
    if (externalRequests.length) throw new Error(`Offline report requested external resources: ${externalRequests.join(", ")}`);
    await page.close();
  }
  console.log("Standalone HTML report: Primer styles applied offline in light and dark themes");

  const narrow = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
  await narrow.goto(url);
  await narrow.locator("#tab-controls tbody tr").first().waitFor({ state: "attached" });
  const width = await narrow.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  if (width.document > width.viewport + 1) {
    throw new Error(`Narrow viewport reflow failed: ${JSON.stringify(width)}`);
  }
  await narrow.keyboard.press("Tab");
  if (!(await narrow.evaluate(() => document.activeElement.matches(".skip-link")))) {
    throw new Error("The skip link is not the first keyboard stop.");
  }
  await narrow.keyboard.press("Tab");
  if (!(await narrow.evaluate(() => document.activeElement.matches("#actions a")))) {
    throw new Error("The report actions do not follow the skip link in keyboard order.");
  }
  const improvementTab = narrow.getByRole("tab", { name: "Improvement areas" });
  await improvementTab.focus();
  await narrow.keyboard.press("ArrowRight");
  if (!(await narrow.getByRole("tab", { name: "All controls" }).evaluate((tab) => tab.getAttribute("aria-selected") === "true"))) {
    throw new Error("Arrow-key navigation between assessment tabs failed.");
  }
  await axe(narrow, "Narrow viewport");
  console.log("Skip link, tab keyboard navigation, and 390px reflow: passed");
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolveExit) => server.once("exit", resolveExit));
  }
  rmSync(tempDir, { recursive: true, force: true });
}
