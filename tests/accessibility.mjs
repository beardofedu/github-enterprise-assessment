import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { assess, loadRubric } from "../src/engine.js";
import { renderHtml } from "../src/report.js";

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

async function assertThemeSelector(page, scheme, checkAccessibility = false) {
  const selector = page.getByLabel("Theme", { exact: true });
  const layout = await selector.evaluate((element) => {
    const select = element.getBoundingClientRect();
    const toolbar = element.closest(".header-actions").getBoundingClientRect();
    const actions = document.getElementById("actions").getBoundingClientRect();
    const label = document.querySelector('label[for="theme-select"]').getBoundingClientRect();
    return {
      rightGap: toolbar.right - select.right,
      centerOffset: Math.abs((select.top + select.height / 2) - (actions.top + actions.height / 2)),
      labelWidth: label.width,
      labelHeight: label.height,
    };
  });
  assert.ok(Math.abs(layout.rightGap) <= 1, "theme selector must align to the right edge of the toolbar");
  assert.ok(layout.centerOffset <= 1, "theme selector must be inline with the other actions");
  assert.ok(layout.labelWidth <= 1 && layout.labelHeight <= 1, "theme label must be visually hidden");
  assert.equal(await selector.inputValue(), "system");
  assert.deepEqual(await selector.locator("option").allTextContents(), [
    "System", "Light", "Dark", "High contrast (system)", "Colorblind (system)",
  ]);
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const settle = () => page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(document.getAnimations().filter((animation) => animation instanceof CSSTransition)
      .map((animation) => animation.finished.catch(() => {})));
  });
  const select = async (value) => { await selector.selectOption(value); await settle(); };
  await select("light");
  const light = await background();
  await assertPrimerStyles(page, "Light theme");
  await select("dark");
  const dark = await background();
  assert.notEqual(dark, light);
  await assertPrimerStyles(page, "Dark theme");
  await select("colorblind");
  assert.equal(await page.locator("html").getAttribute("data-light-theme"), "light_colorblind");
  assert.equal(await page.locator("html").getAttribute("data-dark-theme"), "dark_colorblind");
  await assertPrimerStyles(page, "Colorblind light");
  if (checkAccessibility) await axe(page, "Colorblind light");
  await select("high-contrast");
  await page.emulateMedia({ colorScheme: "light" });
  await settle();
  const contrastLight = await background();
  await assertPrimerStyles(page, "High contrast light");
  await page.emulateMedia({ colorScheme: "dark" });
  await settle();
  assert.notEqual(await background(), contrastLight);
  await assertPrimerStyles(page, "High contrast dark");
  if (checkAccessibility) await axe(page, "High contrast dark");
  await select("colorblind");
  await assertPrimerStyles(page, "Colorblind dark");
  if (checkAccessibility) await axe(page, "Colorblind dark");
  const savedBackground = await background();
  await page.reload();
  await page.locator("#tab-controls tbody tr").first().waitFor({ state: "attached" });
  assert.equal(await selector.inputValue(), "colorblind");
  assert.equal(await background(), savedBackground);
  await select("system");
  await page.emulateMedia({ colorScheme: "light" });
  await settle();
  assert.equal(await background(), light);
  await page.emulateMedia({ colorScheme: "dark" });
  await settle();
  assert.equal(await background(), dark);
  await page.emulateMedia({ colorScheme: scheme });
  await settle();
}

async function assertPillarNavigation(page, assessment) {
  const controlsTab = page.getByRole("tab", { name: "All controls" });
  const panel = page.locator("#tab-controls");
  await controlsTab.click();
  await page.locator("#f-status").selectOption("");
  for (const [index, pillar] of assessment.pillars.entries()) {
    await page.getByRole("tab", { name: "Improvement areas" }).click();
    const card = page.locator("#summary .pillar-card").nth(index);
    if (index === 0) await card.click({ position: { x: 4, y: 4 } });
    else await card.getByRole("button", { name: `View ${pillar.name} controls` }).click();
    assert.equal(await controlsTab.getAttribute("aria-selected"), "true");
    assert.equal(await panel.isVisible(), true);
    assert.equal(await page.locator("#f-pillar").inputValue(), pillar.id);
    assert.equal(await panel.evaluate((element) => document.activeElement === element), true);
    assert.equal(await panel.locator("h2").evaluate((heading) => {
      const rect = heading.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    }), true);
    assert.deepEqual(
      await panel.locator("tbody tr td:first-child strong").allTextContents(),
      assessment.controls.filter((control) => control.pillar === pillar.id).map((control) => control.id),
    );
  }

  await page.locator("#f-status").selectOption("fail");
  await page.getByRole("tab", { name: "Coverage gaps" }).click();
  const first = assessment.pillars[0];
  await page.getByRole("button", { name: `View ${first.name} controls` }).focus();
  await page.keyboard.press("Enter");
  assert.equal(await controlsTab.getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("#f-pillar").inputValue(), first.id);
  assert.equal(await page.locator("#f-status").inputValue(), "fail");
  assert.deepEqual(
    await panel.locator("tbody tr td:first-child strong").allTextContents(),
    assessment.controls.filter((control) => control.pillar === first.id && control.status === "fail").map((control) => control.id),
  );
  const second = assessment.pillars[1];
  await page.getByRole("button", { name: `View ${second.name} controls` }).focus();
  await page.keyboard.press("Space");
  assert.equal(await page.locator("#f-pillar").inputValue(), second.id);
  assert.equal(await panel.evaluate((element) => document.activeElement === element), true);

  const guidance = page.getByRole("link", { name: `${first.name} Well-Architected guidance` });
  assert.equal(await guidance.getAttribute("href"), first.url);
  await guidance.evaluate((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    link.dataset.clicked = "true";
  }, { once: true }));
  await guidance.click();
  assert.equal(await guidance.getAttribute("data-clicked"), "true");
  assert.equal(await page.locator("#f-pillar").inputValue(), second.id);
}

async function assertFindingDetails(page, assessment, checkAccessibility = false) {
  const control = (id) => assessment.controls.find((item) => item.id === id);
  const assertGroup = async (dialog, breakdown, status, title) => {
    const entries = breakdown.items.filter((item) => item.status === status).sort((a, b) => a.name.localeCompare(b.name));
    const heading = dialog.getByRole("heading", { name: `${title} (${entries.length})`, exact: true });
    assert.equal(await heading.isVisible(), true);
    const section = heading.locator("..");
    assert.deepEqual(await section.locator("li").allTextContents(), entries.map((item) => `${item.name}${item.note ? ` — ${item.note}` : ""}`));
  };
  await page.getByRole("tab", { name: "Improvement areas" }).click();
  const repoControl = control("SEC-02");
  const repoFinding = page.locator('#tab-improvements [data-breakdown="SEC-02"]');
  assert.equal(await repoFinding.textContent(), repoControl.finding);
  await repoFinding.click();
  const repoDialog = page.getByRole("dialog", { name: `SEC-02: ${repoControl.title}` });
  await assertGroup(repoDialog, repoControl.details.breakdown, "pass", "Enabled");
  await assertGroup(repoDialog, repoControl.details.breakdown, "fail", "Disabled");
  if (checkAccessibility) await axe(page, "Repository breakdown dialog");
  await page.keyboard.press("Escape");
  assert.equal(await repoDialog.isVisible(), false);
  assert.equal(await repoFinding.evaluate((button) => document.activeElement === button), true);

  await page.getByRole("tab", { name: "All controls" }).click();
  await page.locator("#f-pillar").selectOption("");
  await page.locator("#f-status").selectOption("");
  const orgControl = control("GOV-02");
  await page.locator('#tab-controls [data-breakdown="GOV-02"]').click();
  const orgDialog = page.getByRole("dialog", { name: `GOV-02: ${orgControl.title}` });
  await assertGroup(orgDialog, orgControl.details.breakdown, "pass", "Enabled");
  await assertGroup(orgDialog, orgControl.details.breakdown, "fail", "Disabled");
  await orgDialog.getByRole("button", { name: "Close", exact: true }).click();

  const sampleControl = control("COL-01");
  await page.locator('#tab-controls [data-breakdown="COL-01"]').click();
  const sampleDialog = page.getByRole("dialog", { name: `COL-01: ${sampleControl.title}` });
  assert.match(await sampleDialog.textContent(), /Only sampled repositories were assessed/);
  await assertGroup(sampleDialog, sampleControl.details.breakdown, "unknown", "Not assessed");
  await sampleDialog.getByRole("button", { name: "Close", exact: true }).click();
  const manualRow = page.locator("#tab-controls tbody tr").filter({ has: page.locator("strong", { hasText: "GOV-11" }) });
  assert.equal(await manualRow.locator("[data-breakdown]").count(), 0);
}

async function assertRepositoryAdminGuidance(page, assessment) {
  const next = structuredClone(assessment);
  const control = next.controls.find((item) => item.id === "SEC-01");
  control.status = "unknown";
  control.finding = "Repository security settings were not returned.";
  const access = {
    scopes: ["repo"],
    command: "gh auth refresh -h github.com -s repo",
    requiresOwner: false,
    requiresRepositoryAdmin: true,
    requiresSecurityManager: false,
  };
  next.coverageGaps = [{ id: control.id, pillar: control.pillar, title: control.title, status: control.status, finding: control.finding, access }];
  next.coverageAccess = access;
  await page.evaluate((nextData) => { data = nextData; renderGaps(); }, next);
  await page.getByRole("tab", { name: "Coverage gaps" }).click();
  const gaps = page.locator("#tab-gaps");
  assert.match(await gaps.textContent(), /repository administrator access/);
  assert.doesNotMatch(await gaps.textContent(), /organization owner/);

  const downloadPromise = page.waitForEvent("download");
  await gaps.locator("[data-task]").click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  let task = "";
  for await (const chunk of stream) task += chunk.toString();
  assert.match(task, /must also have repository administrator access/);
  assert.doesNotMatch(task, /organization owner/);
  await page.evaluate((original) => { data = original; renderGaps(); }, assessment);
}

try {
  server = spawn(process.execPath, [
    "bin/gh-waf-assess.js", "serve", "--demo", "--skip-update-check", "--port", String(port), "--answers", answersPath,
  ], { cwd: root, stdio: "ignore" });
  await waitForServer();
  browser = await chromium.launch({ headless: true });

  for (const colorScheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme });
    await page.goto(url);
    await page.locator("#tab-controls tbody tr").first().waitFor({ state: "attached" });
    await assertPrimerStyles(page, `Desktop ${colorScheme}`);
    await axe(page, `Desktop ${colorScheme}`);
    if (colorScheme === "light") await assertThemeSelector(page, colorScheme, true);
    const assessment = await (await fetch(`${url}/api/assessment`)).json();
    await assertPillarNavigation(page, assessment);
    await assertFindingDetails(page, assessment, colorScheme === "light");
    if (colorScheme === "light") await assertRepositoryAdminGuidance(page, assessment);

    await page.getByRole("tab", { name: "Improvement areas" }).click();
    const taskButton = page.locator("#tab-improvements [data-task]").first();
    assert.ok(await taskButton.count(), "improvement areas should have a Download task button");
    await page.getByRole("tab", { name: "All controls" }).click();
    await page.locator("#f-pillar").selectOption("");
    await page.locator("#f-status").selectOption("");
    const missingCount = assessment.controls.filter((control) => control.status !== "pass" && control.status !== "not_applicable").length;
    assert.equal(await page.locator("#tab-controls [data-task]").count(), missingCount);
    await page.getByRole("tab", { name: "Improvement areas" }).click();
    const downloadPromise = page.waitForEvent("download");
    await taskButton.click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^[a-z0-9-]+-implementation\.md$/);
    const stream = await download.createReadStream();
    let task = "";
    for await (const chunk of stream) task += chunk.toString();
    assert.match(task, /^# Implement /);
    assert.match(task, /This is a manual task export; downloading it does not change GitHub settings\./);
    assert.ok(await page.locator("#tab-improvements a[href='/implementation-guide']").count());

    await page.getByRole("tab", { name: "Questionnaire" }).click();
    const firstQuestion = page.locator("#tab-questionnaire .q").first();
    await firstQuestion.getByRole("radio", { name: "Yes" }).check();
    await firstQuestion.getByLabel("Notes / evidence (optional)").fill("Reviewed representative workflow evidence.");
    await firstQuestion.locator("textarea").blur();
    await page.locator("#toast").getByText("Answer saved locally.").waitFor();
    await axe(page, `After questionnaire answer ${colorScheme}`);
    await page.getByRole("button", { name: `View ${assessment.pillars[0].name} controls` }).click();
    assert.equal(await page.locator("#f-pillar").inputValue(), assessment.pillars[0].id);
    await page.getByRole("tab", { name: "Questionnaire" }).click();

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
    if (colorScheme === "light") await assertThemeSelector(page, colorScheme);
    const assessment = await page.evaluate(() => window.__ASSESSMENT__);
    await assertPillarNavigation(page, assessment);
    await assertFindingDetails(page, assessment);
    if (externalRequests.length) throw new Error(`Offline report requested external resources: ${externalRequests.join(", ")}`);
    await page.close();
  }
  console.log("Standalone HTML report: Primer styles applied offline in light and dark themes");

  const blockedStorage = await browser.newPage();
  await blockedStorage.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() { throw new DOMException("Storage blocked", "SecurityError"); },
    });
  });
  await blockedStorage.goto(url);
  assert.match(await blockedStorage.locator("#theme-error").textContent(), /could not be loaded/);
  await blockedStorage.getByLabel("Theme", { exact: true }).selectOption("dark");
  assert.equal(await blockedStorage.locator("html").getAttribute("data-color-mode"), "dark");
  assert.match(await blockedStorage.locator("#theme-error").textContent(), /could not save/);
  await blockedStorage.close();

  const evidence = JSON.parse(readFileSync(new URL("../examples/sample-evidence.json", import.meta.url), "utf8"));
  for (const org of Object.values(evidence.orgs)) org.settings = { ok: false, error: "Access denied", status: 403 };
  const gapReportPath = join(tempDir, "gaps.html");
  writeFileSync(gapReportPath, renderHtml(assess({ rubric: loadRubric(), evidence })));
  const gaps = await browser.newPage();
  await gaps.goto(pathToFileURL(gapReportPath).href);
  await gaps.getByRole("tab", { name: "Coverage gaps" }).click();
  await gaps.locator('#tab-gaps [data-breakdown="GOV-02"]').click();
  const gapDialog = gaps.getByRole("dialog", { name: /GOV-02:/ });
  const unknownHeading = gapDialog.getByRole("heading", { name: "Not assessed (2)" });
  assert.equal(await unknownHeading.isVisible(), true);
  assert.deepEqual(await unknownHeading.locator("..").locator("li").allTextContents(), [
    "octo-platform — Access denied", "octo-retail — Access denied",
  ]);
  await gaps.close();

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
  await narrow.locator('#tab-controls [data-breakdown="SEC-02"]').click();
  const narrowDialog = narrow.getByRole("dialog", { name: /SEC-02:/ });
  const dialogSize = await narrowDialog.evaluate((dialog) => {
    dialog.scrollTop = dialog.scrollHeight;
    const bounds = dialog.getBoundingClientRect();
    const header = dialog.querySelector(".finding-details-header").getBoundingClientRect();
    return { client: dialog.clientWidth, scroll: dialog.scrollWidth, top: bounds.top, headerTop: header.top, headerBottom: header.bottom, bottom: bounds.bottom };
  });
  assert.ok(dialogSize.scroll <= dialogSize.client + 1, "breakdown must reflow within a narrow dialog");
  assert.ok(dialogSize.headerTop >= dialogSize.top && dialogSize.headerBottom <= dialogSize.bottom, "breakdown close button must remain visible while scrolling");
  await axe(narrow, "Narrow breakdown dialog");
  await narrow.evaluate(() => {
    const item = data.controls.find((control) => control.id === "SEC-02").details.breakdown.items[0];
    item.note = "Sample context";
  });
  const breakdownDownload = narrow.waitForEvent("download");
  await narrowDialog.getByRole("button", { name: "Export .md" }).click();
  const breakdownFile = await breakdownDownload;
  assert.match(breakdownFile.suggestedFilename(), /^sec-02-[a-z0-9-]+\.md$/);
  let breakdownMarkdown = "";
  for await (const chunk of await breakdownFile.createReadStream()) breakdownMarkdown += chunk.toString();
  assert.match(breakdownMarkdown, /^# SEC-02: /);
  assert.match(breakdownMarkdown, /^## .+ \(\d+\)$/m);
  assert.match(breakdownMarkdown, /^- `[^`]+\/[^`]+`/m);
  assert.match(breakdownMarkdown, / - Sample context/);
  assert.doesNotMatch(breakdownMarkdown, /[^\x00-\x7F]/, "exported Markdown should contain only ASCII characters");
  await narrow.keyboard.press("Escape");
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
