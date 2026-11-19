import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = new URL('../docs/', import.meta.url);
const browser = await chromium.launch();
try {
  for (const name of ['index.html', 'changelog.html']) {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1050 } });
      await page.goto(new URL(name, root).href);
      await page.addScriptTag({ content: readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8') });
      const violations = await page.evaluate(async () => (await window.axe.run()).violations);
      assert.deepEqual(violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })), [], `${name} at ${width}px: accessibility`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: horizontal overflow`);
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('.skip-link').evaluate((link) => link === document.activeElement), true);

      const references = await page.locator('a[href], img[src], link[rel="stylesheet"]').evaluateAll((nodes) =>
        nodes.map((node) => node.href || node.src));
      for (const reference of references) {
        const url = new URL(reference);
        if (url.protocol !== 'file:') continue;
        assert.ok(url.href.startsWith(root.href), `Link leaves documentation directory: ${reference}`);
        assert.ok(statSync(fileURLToPath(url)).isFile(), `Missing file: ${reference}`);
        if (url.hash && url.pathname.endsWith('.html')) {
          const target = readFileSync(url, 'utf8');
          assert.ok(target.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `Missing anchor: ${reference}`);
        }
      }
      for (const image of await page.locator('img').all()) {
        await image.scrollIntoViewIfNeeded();
        await image.evaluate((img) => img.decode());
        assert.equal(await image.evaluate((img) => img.naturalWidth), 1440);
      }
      await page.close();
      console.log(`${name} at ${width}px: links, images, accessibility, keyboard, and reflow passed`);
    }
  }
} finally {
  await browser.close();
}
