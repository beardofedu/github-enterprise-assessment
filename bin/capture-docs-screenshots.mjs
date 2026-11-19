import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadRubric } from '../src/engine.js';
import { createServer } from '../src/server.js';

const temp = mkdtempSync(join(tmpdir(), 'assessment-docs-'));
const port = 4174;
let server;
let browser;

try {
  server = createServer({
    rubric: loadRubric(),
    evidence: JSON.parse(readFileSync(new URL('../examples/sample-evidence.json', import.meta.url), 'utf8')),
    answersPath: join(temp, 'answers.json'),
    port,
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('#tab-controls tbody tr').first().waitFor({ state: 'attached' });
  await page.locator('#answers-file').setInputFiles({
    name: 'demo-answers.json',
    mimeType: 'application/json',
    buffer: readFileSync(new URL('../examples/answers.example.json', import.meta.url)),
  });
  await page.getByRole('status').getByText('Answers loaded and saved locally.').waitFor();
  await page.locator('#toast').waitFor({ state: 'hidden' });

  for (const [view, name] of [
    ['Improvement areas', 'improvements'],
    ['All controls', 'controls'],
    ['Questionnaire', 'questionnaire'],
    ['Coverage gaps', 'coverage'],
  ]) {
    await page.getByRole('tab', { name: view, exact: true }).click();
    if (name === 'controls') await page.locator('#f-pillar').selectOption({ label: 'Governance' });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: fileURLToPath(new URL(`../docs/images/demo-${name}.png`, import.meta.url)) });
    console.log(`Captured demo-${name}.png`);
  }
} finally {
  if (browser) await browser.close();
  if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(temp, { recursive: true, force: true });
}
